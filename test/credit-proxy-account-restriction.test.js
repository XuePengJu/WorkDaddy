'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createCreditProxy } = require('../scripts/credit-proxy.js');

const API_TOKEN = 'local-proxy-token';

function startUpstream(reply) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        calls.push({ auth: req.headers.authorization || '', body });
        reply(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

async function startProxy(upstreamPort, accounts, current) {
  const proxy = createCreditProxy({
    apiToken: API_TOKEN,
    listAccounts: () => accounts.map((uid) => ({ uid })),
    currentUid: () => current,
    getToken: async (uid) => `token-${uid}`,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    // 与 UA 无关的用例：注入固定值，别去探本机 CDP / 写真实缓存。
    upstreamUa: { resolve: async () => 'Mozilla/5.0 (Test) AppleWebKit/537.36' },
    port: 0,
    log: () => {},
  });
  await proxy.start();
  return { proxy, port: proxy.server.address().port };
}

function chat(port) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

const restrictedBody = JSON.stringify({ code: 11140, msg: 'abnormal activity detected' });
const channelBody = JSON.stringify({ code: 11128, msg: 'request illegal' });

test('a restricted account is evicted from rotation for the rest of the process', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(restrictedBody);
  });
  t.after(() => upstream.server.close());
  const { proxy, port } = await startProxy(upstream.port, ['uid-alpha', 'uid-beta'], 'uid-alpha');
  t.after(() => proxy.stop());

  const first = await chat(port);
  assert.equal(first.status, 400);
  const firstBody = await first.json();
  // 上游原文案会被丢掉，换成可操作的中文说明。
  assert.equal(firstBody.error.code, 11140);
  assert.match(firstBody.error.message, /账号被上游限制/);
  // 两个候选号都被试过，都记进了受限名单。
  assert.equal(upstream.calls.length, 2);
  assert.equal(proxy.stats.restricted.length, 2);

  const second = await chat(port);
  assert.equal(second.status, 503);
  const secondBody = await second.json();
  assert.match(secondBody.error.message, /均被上游限制/);
  // 关键：第二个请求没有再往上游打任何一次。
  assert.equal(upstream.calls.length, 2);
});

test('channel validation failure stops at the first account and evicts nothing', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(channelBody);
  });
  t.after(() => upstream.server.close());
  const { proxy, port } = await startProxy(upstream.port, ['uid-alpha', 'uid-beta'], 'uid-alpha');
  t.after(() => proxy.stop());

  const first = await chat(port);
  assert.equal(first.status, 400);
  const body = await first.json();
  assert.equal(body.error.code, 11128);
  // 换号对渠道校验毫无意义：只打了一次上游，且没有账号被标记。
  assert.equal(upstream.calls.length, 1);
  assert.equal(proxy.stats.restricted.length, 0);

  const second = await chat(port);
  assert.equal(second.status, 400);
  // 不被标记 = 下一个请求照常尝试，不会因为一次 11128 就把账号池清空。
  assert.equal(upstream.calls.length, 2);
});

test('a throttled account still rotates to the next one and stays usable', async (t) => {
  const upstream = await startUpstream((req, res) => {
    if (req.headers.authorization === 'Bearer token-uid-beta') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ msg: 'usage exceeds frequency limit' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"id":"x","model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  t.after(() => upstream.server.close());
  const { proxy, port } = await startProxy(upstream.port, ['uid-alpha', 'uid-beta'], 'uid-beta');
  t.after(() => proxy.stop());

  // 默认「当前账号优先」：先打当前登录号 uid-beta，它被限流后才轮到备份号 uid-alpha。
  // 这也是真实里最常发生的情形——登着的号累了，代理帮你换一个号继续跑完。
  const res = await chat(port);
  assert.equal(res.status, 200);
  assert.equal(upstream.calls.length, 2);
  // 限流只是「这个号现在累了」，不是红线：不进受限名单。
  assert.equal(proxy.stats.restricted.length, 0);
  assert.equal(proxy.stats.rotations, 1);
});