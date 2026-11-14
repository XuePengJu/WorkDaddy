'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withDefaultEffort, normalizeModel } = require('../scripts/credit-proxy.js');

// 上游这条车道里 reasoning_effort 才是思考的开关：不带档位 = 不思考。有的客户端
// UI 保存不住思考配置，每轮都发不出档位，于是「配了思考却从来不思考」。代理侧
// 补最短一档，让这类请求至少真的思考。

test('a request that names no effort still gets the lowest one', () => {
  const out = withDefaultEffort({ model: 'deepseek-v4.1-flash' });
  assert.equal(out.reasoning_effort, 'low');
  assert.deepEqual(out.thinking, { type: 'enabled' });
});

test('null, blank and switch-off spellings all land on low', () => {
  for (const value of [null, undefined, '', '   ', 'none', 'disabled', 'off']) {
    const out = withDefaultEffort({ model: 'deepseek-v4.1-flash', reasoning_effort: value });
    assert.equal(out.reasoning_effort, 'low', `reasoning_effort=${JSON.stringify(value)}`);
  }
});

test('an explicit supported level is passed through untouched', () => {
  for (const level of ['low', 'high', 'max']) {
    const out = withDefaultEffort({ model: 'deepseek-v4.1-flash', reasoning_effort: level });
    assert.equal(out.reasoning_effort, level);
  }
});

test('a level the model never declared is replaced by its lowest rung', () => {
  assert.equal(withDefaultEffort({ model: 'deepseek-v4.1-flash', reasoning_effort: 'xhigh' }).reasoning_effort, 'low');
  // glm-5.2 的档位表里没有 low，最低档就是它自己的第一档。
  assert.equal(withDefaultEffort({ model: 'glm-5.2' }).reasoning_effort, 'high');
});

test('a model outside the ladder table is forwarded without inventing a field', () => {
  assert.equal(withDefaultEffort({ model: 'brand-new-model' }).reasoning_effort, undefined);
});

test('non-deepseek models do not get a thinking switch', () => {
  const out = withDefaultEffort({ model: 'glm-5.3-flash' });
  assert.equal(out.reasoning_effort, 'low');
  assert.equal(out.thinking, undefined);
});

test('the display-name spelling is normalized to the upstream id first', () => {
  const out = withDefaultEffort({ model: normalizeModel('DeepSeek-V4.1-Flash') });
  assert.equal(out.model, 'deepseek-v4.1-flash');
  assert.equal(out.reasoning_effort, 'low');
});

test('the caller payload itself is never mutated', () => {
  const payload = { model: 'deepseek-v4.1-flash' };
  withDefaultEffort(payload);
  assert.equal(payload.reasoning_effort, undefined);
  assert.equal(payload.thinking, undefined);
});
