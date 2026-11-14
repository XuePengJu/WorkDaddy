'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const compat = require('../scripts/workbuddy-compat');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
function element(x, y, width, height, parentElement = null) {
  return { isConnected: true, parentElement, css: {},
    rect: { x, y, left:x, top:y, width, height, right:x+width, bottom:y+height },
    getBoundingClientRect() { return this.rect; }, closest() { return this.shell || null; } };
}
function harness() {
  const parent = element(240,64,1160,836), shell = element(240,64,700,836,parent);
  shell.shell = shell;
  const preview = element(940,0,460,900);
  const doc = {
    defaultView: {innerWidth:1400,innerHeight:900,getComputedStyle:n=>({display:'block',visibility:'visible',opacity:'1',...n.css})},
    querySelector: selector => selector.includes('teams-container') ? parent : null,
    querySelectorAll: selector => selector === '.conversation-shell' ? [shell] : selector === '.detail-panel-container' ? [preview] : [],
  };
  return { doc, shell, preview, parent };
}
// WorkBuddy 5.11.3 工作台壳：没有 .conversation-shell，只有
// .layout-window-frame / __body / __aside 和 .wb-home-page。
function workbenchHarness(overrides = {}) {
  const frame = element(0,0,1400,900);
  const body = element(360,0,917,747,frame);
  const home = element(395,64,848,645,body);
  const aside = element(overrides.asideLeft == null ? 1277 : overrides.asideLeft, 0,
    overrides.asideWidth || 0, 747, frame);
  const preview = element(0,0,0,0);
  const nodes = {
    '.teams-container': frame,
    '.layout-window-frame': frame,
    '.layout-window-frame__body': body,
    '.layout-window-frame__aside': aside,
    '.wb-home-page': home,
    '.detail-panel-container': preview,
  };
  const doc = {
    defaultView: {innerWidth:1400,innerHeight:900,getComputedStyle:n=>({display:'block',visibility:'visible',opacity:'1',...(n && n.css)})},
    querySelector(selector) {
      const parts = selector.split(',').map(s => s.trim());
      for (const key of Object.keys(nodes)) {
        if (parts.indexOf(key) >= 0) return overrides.noMarker && key !== '.layout-window-frame__body' ? null : nodes[key];
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.conversation-shell' || selector === '.chat-container') return [];
      if (selector === '.detail-panel-container') return [preview];
      return [];
    },
  };
  return { doc, frame, body, home, aside, preview, nodes };
}
test('conversation area uses shell width independently from the WorkBuddy viewport', () => {
  const h = harness();
  const area = compat.findConversationArea(h.doc);
  assert.equal(area.element,h.shell);
  assert.equal(area.rect.width,700);
  assert.equal(area.rect.right,940);
});
test('fullscreen file preview hides a still-mounted, nonzero chat shell and restores it on exit', () => {
  const h = harness();
  const split = h.preview.rect;
  h.preview.rect = element(0,0,1400,900).rect;
  assert.equal(compat.findConversationArea(h.doc).rect,null);
  assert.equal(h.shell.rect.width,700);
  h.preview.rect = split;
  assert.equal(compat.findConversationArea(h.doc).rect.width,700);
});
test('partial overlay and viewport clipping constrain the usable chat area', () => {
  const h = harness();
  h.shell.rect = element(240,64,1160,836).rect;
  assert.equal(compat.findConversationArea(h.doc).rect.width,700);
  h.preview.css.display='none'; h.doc.defaultView.innerWidth=1000;
  assert.equal(compat.findConversationArea(h.doc).rect.width,760);
});
test('hidden ancestors, zero size and unmounted chat never fall back to teams main content', () => {
  const h = harness();
  h.parent.css.visibility='hidden'; assert.equal(compat.findConversationArea(h.doc).rect,null);
  h.parent.css={opacity:'0'}; assert.equal(compat.findConversationArea(h.doc).rect,null);
  h.parent.css={}; h.shell.rect=element(240,64,0,0).rect;
  assert.equal(compat.findConversationArea(h.doc).rect,null);
  h.doc.querySelectorAll=()=>[];
  assert.equal(compat.findConversationArea(h.doc),null);
});
test('message navigation selects its own shell when several conversations are mounted', () => {
  const h=harness(), other=element(20,64,300,836), viewport=element(240,64,700,700);
  viewport.shell=h.shell;
  h.doc.querySelectorAll=selector=>selector==='.conversation-shell'?[other,h.shell]:[];
  assert.equal(compat.findConversationArea(h.doc,viewport).element,h.shell);
});
test('5.11.3 workbench body resolves the conversation area when the legacy shell is gone', () => {
  const h = workbenchHarness();
  const area = compat.findConversationArea(h.doc);
  assert.ok(area, 'a modern workbench must not return null');
  assert.equal(area.element, h.body);
  assert.equal(area.rect.width, 917);
  assert.equal(area.rect.right, 1277);
  assert.ok(area.rect.width >= 800, 'message navigation needs the measured area, not the window');
});
test('5.11.3 collapsed aside leaves the workbench area intact', () => {
  const h = workbenchHarness({ asideWidth: 0 });
  assert.equal(compat.findConversationArea(h.doc).rect.width, 917);
});
test('5.11.3 expanded right aside subtracts the overlapped width', () => {
  const h = workbenchHarness({ asideLeft: 1000, asideWidth: 277 });
  const area = compat.findConversationArea(h.doc);
  assert.equal(area.rect.right, 1000);
  assert.equal(area.rect.width, 640);
});
test('5.11.3 zero-size frame body falls back to the home page body', () => {
  const h = workbenchHarness();
  h.body.rect = element(0,0,0,0).rect;
  const area = compat.findConversationArea(h.doc);
  assert.equal(area.element, h.home);
  assert.equal(area.rect.width, 848);
});
test('legacy conversation shell still wins over the 5.11.3 workbench shell', () => {
  const h = workbenchHarness();
  const shell = element(240,64,700,836,h.frame);
  h.doc.querySelectorAll = selector => selector === '.conversation-shell' ? [shell] :
    selector === '.detail-panel-container' ? [h.preview] : [];
  const area = compat.findConversationArea(h.doc);
  assert.equal(area.element, shell);
  assert.equal(area.rect.width, 700);
});
test('unknown pages without a modern shell marker still return null', () => {
  const h = workbenchHarness({ noMarker: true });
  assert.equal(compat.findConversationArea(h.doc), null);
});
test('robot hides with absent chat without overriding panel-open state, then restores', () => {
  const classes=new Set(), fab={classList:{contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)}};
  let area=null, positions=0;
  const ctx={CAPS:{},root:{querySelector:()=>fab},document:{querySelector:()=>null},WBS_COMPAT:{findConversationArea:()=>area},
    ensureFabAnchorObserver(){},fabDrag:null,fabQuietMode:{wake(){}},messageNavigation:{updateLayout(){}},
    readFabBottom:()=>null,fabAnchorOffsets:()=>({right:22,bottom:22}),applyFabPosition:()=>positions++};
  const start=source.indexOf('    function positionFab()');
  vm.runInNewContext(source.slice(start,source.indexOf('    setBuildTimeout(scheduleFabPos',start)),ctx);
  ctx.positionFab(); assert.equal(classes.has('is-area-hidden'),true); assert.equal(positions,0);
  area={element:{},rect:element(0,0,1000,800).rect}; classes.add('hidden');
  ctx.positionFab(); assert.equal(classes.has('is-area-hidden'),false);assert.equal(classes.has('hidden'),true);assert.equal(positions,0);
  classes.delete('hidden');ctx.positionFab();assert.equal(positions,1);
  area=null;ctx.CAPS.nativeComposer=true;ctx.positionFab();assert.equal(classes.has('is-area-hidden'),false,'native IDE clients retain their existing fallback');
});
test('modern workbench surface keeps robot visible when no conversation area resolves yet', () => {
  const classes=new Set(), fab={classList:{contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)}};
  let positions=0;
  const ctx={CAPS:{},root:{querySelector:()=>fab},document:{querySelector:()=>({})},WBS_COMPAT:{findConversationArea:()=>null},
    ensureFabAnchorObserver(){},fabDrag:null,fabQuietMode:{wake(){}},messageNavigation:{updateLayout(){}},
    readFabBottom:()=>null,fabAnchorOffsets:()=>({right:22,bottom:22}),applyFabPosition:()=>positions++};
  const start=source.indexOf('    function positionFab()');
  vm.runInNewContext(source.slice(start,source.indexOf('    setBuildTimeout(scheduleFabPos',start)),ctx);
  ctx.positionFab();
  assert.equal(classes.has('is-area-hidden'),false,'5.11.3 workbench must not hide the robot');
  assert.equal(positions,1,'robot falls back to window edge offsets');
  ctx.document.querySelector=()=>null;
  ctx.positionFab();
  assert.equal(classes.has('is-area-hidden'),true,'unknown pages keep the conservative hidden state');
});
