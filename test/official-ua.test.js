'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BUILTIN_UA,
  saneUa,
  detectFromCdp,
  detectFromPackage,
  readUaCache,
  writeUaCache,
  createOfficialUa,
} = require('../scripts/official-ua.js');

// 取值链：cdp → package → cache → builtin。
// 硬要求：任何情况下都要有 UA。退回「不发 UA」就等于继续发 undici 的 `node`，
// 那比现在更糟，所以最后一级必须是常量而不是空串。

const REAL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) WorkBuddy/5.9.3 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('saneUa only lets browser-shaped UA through', () => {
  assert.equal(saneUa(REAL_UA), REAL_UA);
  assert.equal(saneUa(''), '');
  assert.equal(saneUa(null), '');
  assert.equal(saneUa('<html><head><title>401</title></head></html>'), '');
  assert.equal(saneUa('node'), '');
  assert.equal(saneUa(`Mozilla/5.0 bad\r\ninjection AppleWebKit/537.36`), '');
});

test('cdp value is accepted only when the product token is WorkBuddy', async () => {
  const ok = await detectFromCdp({
    fetchImpl: async () => ({ ok: true, json: async () => ({ 'User-Agent': REAL_UA }) }),
  });
  assert.equal(ok.ua, REAL_UA);
  assert.equal(ok.appVersion, '5.9.3');

  // 9222 被用户的 Chrome 占着时，拿 Chrome 的 UA 去冒充官方客户端比 node 更糟。
  const chrome = await detectFromCdp({
    fetchImpl: async () => ({ ok: true, json: async () => ({ 'User-Agent': CHROME_UA }) }),
  });
  assert.equal(chrome, null);

  const notOk = await detectFromCdp({ fetchImpl: async () => ({ ok: false }) });
  assert.equal(notOk, null);

  const thrown = await detectFromCdp({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(thrown, null);
});

test('package detection rebuilds the UA from the installed app versions', () => {
  const seen = [];
  const ua = detectFromPackage({
    appPaths: ['/Applications/WorkBuddy.app'],
    exec: (file, args) => {
      seen.push(file);
      if (file === 'plutil') {
        const target = args[args.length - 1];
        if (target.endsWith('Contents/Info.plist')) return '5.9.3\n';
        if (target.endsWith('Resources/Info.plist')) return '37.10.3\n';
      }
      if (file === 'strings') return `blah Chrome/138.0.7204.251 blah`;
      return '';
    },
  });
  assert.equal(ua.ua, REAL_UA);
  assert.equal(ua.appVersion, '5.9.3');
  // 只读了被指定的那一个包，没有到处乱翻。
  assert.equal(seen.filter((f) => f === 'plutil').length, 2);
});

test('package detection gives up instead of inventing a version', () => {
  // 版本读不全就不拼 UA：缺 Chromium 版本的 UA 上游不校验，但人看着就是假的。
  const broken = detectFromPackage({
    appPaths: ['/Applications/Nope.app'],
    exec: (file) => (file === 'strings' ? '' : ''),
  });
  assert.equal(broken, null);
  assert.equal(detectFromPackage({ platform: 'win32' }), null);
});

test('cache round trip keeps ua / source / appVersion', (t) => {
  const dir = tmpDir(t, 'wd-ua-cache-');
  const file = path.join(dir, 'ua.json');
  assert.equal(readUaCache(file), null);
  assert.equal(writeUaCache({ ua: REAL_UA, source: 'cdp', appVersion: '5.9.3' }, file), true);
  const back = readUaCache(file);
  assert.equal(back.ua, REAL_UA);
  assert.equal(back.source, 'cdp');
  assert.equal(back.appVersion, '5.9.3');
  // 手工搞坏的缓存不能被当成有效值用出去。
  fs.writeFileSync(file, JSON.stringify({ ua: 'node' }));
  assert.equal(readUaCache(file), null);
});

test('cdp result wins and is persisted for next start', async (t) => {
  const dir = tmpDir(t, 'wd-ua-cdp-');
  const cacheFile = path.join(dir, 'ua.json');
  const resolver = createOfficialUa({
    cacheFile,
    detectCdp: async () => ({ ua: REAL_UA, appVersion: '5.9.3' }),
    detectPackage: () => { throw new Error('不该走到 package'); },
  });
  assert.equal(await resolver.resolve(), REAL_UA);
  assert.equal(resolver.current().source, 'cdp');
  // 关键：这一发拿到了，就落盘；下次启动取不到才有得兜。
  assert.equal(readUaCache(cacheFile).source, 'cdp');
});

test('package is used and persisted when cdp is unreachable', async (t) => {
  const dir = tmpDir(t, 'wd-ua-pkg-');
  const cacheFile = path.join(dir, 'ua.json');
  const resolver = createOfficialUa({
    cacheFile,
    detectCdp: async () => null,
    detectPackage: () => ({ ua: REAL_UA, appVersion: '5.9.3' }),
  });
  assert.equal(await resolver.resolve(), REAL_UA);
  assert.equal(resolver.current().source, 'package');
  assert.equal(readUaCache(cacheFile).source, 'package');
});

test('a cold start with no detection falls back to the last good value', async (t) => {
  const dir = tmpDir(t, 'wd-ua-fallback-');
  const cacheFile = path.join(dir, 'ua.json');
  writeUaCache({ ua: REAL_UA, source: 'cdp', appVersion: '5.9.3' }, cacheFile);
  const resolver = createOfficialUa({
    cacheFile,
    detectCdp: async () => null,
    detectPackage: () => null,
  });
  assert.equal(await resolver.resolve(), REAL_UA);
  assert.equal(resolver.current().source, 'cdp');
});

test('with no cache at all it still sends a UA, never an empty one', async (t) => {
  const dir = tmpDir(t, 'wd-ua-builtin-');
  const cacheFile = path.join(dir, 'ua.json');
  const resolver = createOfficialUa({
    cacheFile,
    detectCdp: async () => null,
    detectPackage: () => null,
  });
  const ua = await resolver.resolve();
  assert.equal(ua, BUILTIN_UA);
  assert.equal(resolver.current().source, 'builtin');
  assert.match(ua, /WorkBuddy\/\d/);
  assert.match(ua, /AppleWebKit/);
});

test('a throwing probe degrades to a usable value instead of breaking forwarding', async (t) => {
  const dir = tmpDir(t, 'wd-ua-throw-');
  const cacheFile = path.join(dir, 'ua.json');
  const resolver = createOfficialUa({
    cacheFile,
    detectCdp: async () => { throw new Error('boom'); },
    detectPackage: () => { throw new Error('boom'); },
  });
  assert.equal(await resolver.resolve(), BUILTIN_UA);
});

test('resolved value is memoised so requests do not re-probe', async (t) => {
  const dir = tmpDir(t, 'wd-ua-memo-');
  let calls = 0;
  const resolver = createOfficialUa({
    cacheFile: path.join(dir, 'ua.json'),
    detectCdp: async () => { calls += 1; return { ua: REAL_UA, appVersion: '5.9.3' }; },
    detectPackage: () => null,
  });
  await resolver.warmup();
  await resolver.resolve();
  await resolver.resolve();
  assert.equal(calls, 1);
});