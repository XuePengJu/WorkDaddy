'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  UPSTREAM_CODES,
  readUpstreamError,
  isAccountLevelFailure,
  scrubMessages,
  downgradeDeveloperRole,
} = require('../scripts/credit-proxy.js');

// 上游把真正的判定放在响应体的 code 字段里，HTTP 状态码经常只是 400。
// 分不清「渠道校验」「请求不合法」「账号被限制」这三件事的代价很大：
// 前两种换号没用，最后一种必须立刻停号，否则等于继续拿这个号去撞风控。

test('a numeric code in the body is read as is', () => {
  const failure = readUpstreamError(JSON.stringify({ code: 11128, msg: 'request illegal' }));
  assert.equal(failure.code, 11128);
  assert.equal(failure.message, 'request illegal');
  assert.equal(failure.level, 'channel');
});

test('a string code and a nested error.code are both understood', () => {
  assert.equal(readUpstreamError(JSON.stringify({ code: '11140' })).code, 11140);
  assert.equal(readUpstreamError(JSON.stringify({ error: { code: 11133, message: 'bad tools' } })).code, 11133);
});

test('a body without a usable code falls back to zero', () => {
  for (const body of ['', 'not json', 'null', JSON.stringify({}), JSON.stringify({ error: { code: 'invalid_request_error' } })]) {
    assert.equal(readUpstreamError(body).code, 0, JSON.stringify(body));
  }
});

test('the label never echoes account or credential material', () => {
  const failure = readUpstreamError(JSON.stringify({ code: 11128, msg: 'Bearer sk-abcdef should not leak whole' }));
  assert.equal(failure.message.length <= 200, true);
  assert.equal(failure.label.includes('sk-'), false);
});

test('account restriction is a rotation failure even though it arrives as a 400', () => {
  assert.equal(isAccountLevelFailure(400, 11140), true);
});

test('channel and request errors are never retried on another account', () => {
  for (const code of [10085, 11128, 11133, 11153, 11159]) {
    assert.equal(isAccountLevelFailure(400, code), false, `code=${code}`);
  }
});

test('status-only classification still works for unknown codes', () => {
  assert.equal(isAccountLevelFailure(401, 0), true);
  assert.equal(isAccountLevelFailure(402, 0), true);
  assert.equal(isAccountLevelFailure(429, 0), true);
  assert.equal(isAccountLevelFailure(400, 0), false);
  assert.equal(isAccountLevelFailure(500, 0), false);
});

test('every declared code carries a level and a label', () => {
  for (const [code, meta] of Object.entries(UPSTREAM_CODES)) {
    assert.equal(['account', 'channel', 'request'].includes(meta.level), true, `code=${code}`);
    assert.equal(typeof meta.label === 'string' && meta.label.length > 0, true, `code=${code}`);
  }
});

test('a third-party client identity line is reworded before the request goes out', () => {
  const messages = [{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' }];
  const out = scrubMessages(messages);
  assert.equal(out[0].content, 'You are an AI agent powered by DeepSeek.');
  // 入参不能被就地改写：同一份 payload 还要用于日志与重试。
  assert.equal(messages[0].content, 'You are an AI agent powered by DeepSeek Harness.');
});

test('block content is scrubbed per text part while the block shape stays intact', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Tokens prefixed with @ are paths the user explicitly referenced. Read them.' },
      { type: 'image', source: { data: 'AAAA' } },
    ],
  }];
  const out = scrubMessages(messages);
  assert.equal(out[0].content[0].text, 'Tokens prefixed with @ are paths the user referenced. Read them.');
  assert.deepEqual(out[0].content[1], { type: 'image', source: { data: 'AAAA' } });
});

test('text without a known fingerprint keeps its identity, object and all', () => {
  const messages = [{ role: 'user', content: 'hello' }, { role: 'tool', content: 'ok' }];
  assert.equal(scrubMessages(messages), messages);
});

test('developer role is downgraded to the equivalent system role', () => {
  const messages = [
    { role: 'developer', content: 'be terse' },
    { role: 'user', content: 'hi' },
  ];
  const out = downgradeDeveloperRole(messages);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user']);
  assert.equal(out[0].content, 'be terse');
  assert.equal(messages[0].role, 'developer');
});

test('messages without a developer role are passed through untouched', () => {
  const messages = [{ role: 'system', content: 'x' }];
  assert.equal(downgradeDeveloperRole(messages), messages);
});