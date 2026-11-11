'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  isForwardable,
  flattenInbound,
  domainOf,
  buildUpstreamHeaders,
} = require('../scripts/upstream-headers.js');

const CLIENT = { ua: 'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0', appVersion: '5.9.3' };
const UID = '00b81dd0-a5e7-4277-ae7c-2aae3020ff72';

// 客户端真实入站头（取自 magpie 归档里 WorkBuddy 客户端那一组）。
function inboundHeaders() {
  return {
    accept: 'application/json',
    'accept-encoding': 'gzip, compress, deflate, br',
    'accept-language': 'zh-CN,zh;q=0.9',
    'acp-connection-id': '01a1c55e-6ca8-74d2-bc54-524619d832be',
    authorization: 'Bearer local-proxy-token',
    'content-length': '261313',
    'content-type': 'application/json',
    host: '127.0.0.1:47900',
    'x-api-key': 'local-proxy-key',
    'x-request-id': '01a1c55f6f7f721eae7db6108f0c9510',
    'x-stainless-arch': 'arm64',
    'x-stainless-lang': 'js',
    'x-stainless-package-version': '6.25.0',
    'x-user-id': '147e611a-ccb1-42ad-8c0d-4483c4952193',
    traceparent: '00-579d6ec757fa42fe98c31bddcfb35e4f-f9707b040da5eb66-01',
    'user-agent': 'OpenAI/JS 6.26.0',
  };
}

test('forwardable whitelist keeps context and drops credentials', () => {
  for (const name of ['x-stainless-lang', 'x-conversation-id', 'traceparent', 'accept-language', 'x-request-id']) {
    assert.equal(isForwardable(name), true, `${name} 应该透传`);
  }
  for (const name of ['authorization', 'x-api-key', 'cookie', 'host', 'content-length', 'connection', 'user-agent', 'x-user-id']) {
    assert.equal(isForwardable(name), false, `${name} 不该透传`);
  }
  // accept-encoding 必须拦：透传 br 后 undici 不保证解压，流式转发会吐乱码。
  assert.equal(isForwardable('accept-encoding'), false);
});

test('flattenInbound lowercases and drops header injection', () => {
  const flat = flattenInbound({ 'X-Foo': ['a', 'b'], 'X-Bar': 'ok\ninjected: 1', 'X-Empty': '' });
  assert.equal(flat['x-foo'], 'a, b');
  assert.equal(flat['x-bar'], undefined);
  assert.equal(flat['x-empty'], undefined);
});

test('domainOf falls back to the official host instead of emitting garbage', () => {
  assert.equal(domainOf('https://www.workbuddy.cn'), 'www.workbuddy.cn');
  assert.equal(domainOf('http://127.0.0.1:1234'), '127.0.0.1');
  assert.equal(domainOf(''), 'www.workbuddy.cn');
  assert.equal(domainOf(null), 'www.workbuddy.cn');
});

test('identity headers follow the official client shape', () => {
  const headers = buildUpstreamHeaders({
    inbound: inboundHeaders(),
    uid: UID,
    token: 'acct-token-B',
    client: CLIENT,
    upstreamOrigin: 'https://www.workbuddy.cn',
  });

  assert.equal(headers['x-ide-name'], 'WorkBuddy');
  assert.equal(headers['x-ide-type'], 'WorkBuddy');
  assert.equal(headers['x-ide-version'], '5.9.3');
  assert.equal(headers['x-product'], 'SaaS');
  assert.equal(headers['x-domain'], 'www.workbuddy.cn');
  assert.equal(headers['x-codebuddy-request'], '1');
  assert.equal(headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(headers['x-agent-intent'], 'craft');
  assert.equal(headers['x-agent-purpose'], 'conversation');
  assert.equal(headers['x-agent-runtime'], 'local-agent');
  assert.equal(headers['x-agent-type'], 'main');
  assert.equal(headers.accept, 'text/event-stream');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['accept-language'], 'zh-CN,zh;q=0.9');
});

test('UA is the official node shape, never the inbound SDK UA', () => {
  const headers = buildUpstreamHeaders({
    inbound: inboundHeaders(),
    uid: UID,
    token: 't',
    client: CLIENT,
    upstreamOrigin: 'https://www.workbuddy.cn',
  });
  assert.equal(headers['user-agent'], CLIENT.ua);
  assert.notEqual(headers['user-agent'], 'OpenAI/JS 6.26.0');
  assert.notEqual(headers['user-agent'], 'node');
});

test('X-User-Id follows the account actually used, not the logged-in one', () => {
  const headers = buildUpstreamHeaders({
    inbound: inboundHeaders(),
    uid: UID,
    token: 't',
    client: CLIENT,
    upstreamOrigin: 'https://www.workbuddy.cn',
  });
  // 入站写的是当前登录账号 147e...，本次用的是备份号 → 必须被覆盖。
  assert.equal(headers['x-user-id'], UID);
  assert.notEqual(headers['x-user-id'], '147e611a-ccb1-42ad-8c0d-4483c4952193');
});

test('call context passes through and local credentials never leave', () => {
  const headers = buildUpstreamHeaders({
    inbound: inboundHeaders(),
    uid: UID,
    token: 'acct-token-B',
    client: CLIENT,
    upstreamOrigin: 'https://www.workbuddy.cn',
  });
  assert.equal(headers['x-stainless-arch'], 'arm64');
  assert.equal(headers['x-stainless-package-version'], '6.25.0');
  assert.equal(headers['x-request-id'], '01a1c55f6f7f721eae7db6108f0c9510');
  assert.equal(headers.traceparent, '00-579d6ec757fa42fe98c31bddcfb35e4f-f9707b040da5eb66-01');
  assert.equal(headers['acp-connection-id'], '01a1c55e-6ca8-74d2-bc54-524619d832be');
  // 出站凭据只能是本次账号的 token
  assert.equal(headers.authorization, 'Bearer acct-token-B');
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers.host, undefined);
  assert.equal(headers['content-length'], undefined);
  assert.equal(headers['accept-encoding'], undefined);
  assert.equal(headers.cookie, undefined);
});

test('no inbound headers (dashboard test button) still produces a usable set', () => {
  const headers = buildUpstreamHeaders({
    inbound: null,
    uid: UID,
    token: 't',
    client: CLIENT,
    upstreamOrigin: 'https://www.workbuddy.cn',
  });
  assert.equal(headers['x-ide-name'], 'WorkBuddy');
  assert.equal(headers['accept-language'], 'zh-CN,zh;q=0.9');
  assert.equal(headers['user-agent'], CLIENT.ua);
  assert.equal(headers['x-user-id'], UID);
  // 没有会话上下文就不编：宁可缺，也不造一个查无此会话的 id。
  assert.equal(headers['x-conversation-id'], undefined);
  assert.equal(headers['x-request-id'], undefined);
  assert.ok(Object.keys(headers).length >= 12);
});

test('missing client version omits X-Ide-Version instead of writing undefined', () => {
  const headers = buildUpstreamHeaders({
    inbound: null,
    uid: UID,
    token: 't',
    client: { ua: 'WorkBuddy/5.9.3' },
    upstreamOrigin: 'https://www.workbuddy.cn',
  });
  assert.equal(headers['x-ide-version'], undefined);
  assert.equal(headers['user-agent'], 'WorkBuddy/5.9.3');
});