'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCreditProxy } = require('../scripts/credit-proxy.js');

// 端到端只验一件事：构造好的身份头真的写进了出站请求。
// 头构造本身由 upstream-headers.test.js 覆盖，这里注入固定身份实现。

const LOCAL_API_KEY = 'local-api-key-for-test';
const ACCOUNT_UID = '00b81dd0-a5e7-4277-ae7c-2aae3020ff72';
const LOGGED_IN_UID = '147e611a-ccb1-42ad-8c0d-4483c4952193';
const CLIENT_UA = 'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0';

function startUpstream() {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        calls.push(req.headers);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"id":"x","model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

async function startProxy(upstreamPort, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-upstream-headers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const proxy = createCreditProxy({
    apiToken: LOCAL_API_KEY,
    // 只有一个号，且就是当前登录号：选号不干扰断言。
    listAccounts: () => [{ uid: LOGGED_IN_UID }],
    currentUid: () => LOGGED_IN_UID,
    getToken: async (uid) => `account-token-of-${uid}`,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    orderFile: path.join(dir, 'order.json'),
    upstreamUa: {
      resolve: async () => CLIENT_UA,
      identity: async () => ({ ua: CLIENT_UA, appVersion: '5.9.3', cliVersion: '2.165.0' }),
      current: () => ({ ua: CLIENT_UA, source: 'cdp', appVersion: '5.9.3' }),
    },
    port: 0,
    log: () => {},
  });
  await proxy.start();
  t.after(() => proxy.stop());
  return proxy.server.address().port;
}

function chat(port) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${LOCAL_API_KEY}`,
      'x-api-key': LOCAL_API_KEY,
      'accept-encoding': 'gzip, compress, deflate, br',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': 'OpenAI/JS 6.26.0',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '6.25.0',
      'x-request-id': '01a1c55f6f7f721eae7db6108f0c9510',
      'x-user-id': LOGGED_IN_UID,
    },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

test('upstream sees the official client identity, not the local SDK', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());
  const port = await startProxy(upstream.port, t);

  const res = await chat(port);
  assert.equal(res.status, 200);
  assert.equal(upstream.calls.length, 1);
  const sent = upstream.calls[0];

  // 身份头补齐
  assert.equal(sent['x-ide-name'], 'WorkBuddy');
  assert.equal(sent['x-ide-type'], 'WorkBuddy');
  assert.equal(sent['x-ide-version'], '5.9.3');
  assert.equal(sent['x-product'], 'SaaS');
  assert.equal(sent['x-codebuddy-request'], '1');
  assert.equal(sent['x-agent-intent'], 'craft');
  assert.equal(sent['x-agent-type'], 'main');
  assert.equal(sent['x-requested-with'], 'XMLHttpRequest');
  // X-Domain 跟着实际上游地址走（测试里是 127.0.0.1）
  assert.equal(sent['x-domain'], '127.0.0.1');

  // UA 是官方 node 形态，不是入站的 SDK UA
  assert.equal(sent['user-agent'], CLIENT_UA);
  assert.notEqual(sent['user-agent'], 'OpenAI/JS 6.26.0');

  // 调用链上下文透传
  assert.equal(sent['x-stainless-lang'], 'js');
  assert.equal(sent['x-stainless-package-version'], '6.25.0');
  assert.equal(sent['x-request-id'], '01a1c55f6f7f721eae7db6108f0c9510');
  assert.equal(sent['accept-language'], 'zh-CN,zh;q=0.9');

  // 凭据只带账号 token；本地代理凭据一个都不外发
  assert.equal(sent.authorization, `Bearer account-token-of-${LOGGED_IN_UID}`);
  assert.equal(sent['x-api-key'], undefined);
  // 压缩协商交回 undici（它会发自己的 gzip, deflate）：照抄入站的 br 会让流式转发吐乱码
  assert.notEqual(sent['accept-encoding'], 'gzip, compress, deflate, br');
  // content-length 由 fetch 按改造后的 body 重算，不能沿用入站值
  assert.notEqual(sent['content-length'], '261313');
});

test('account uid wins over the X-User-Id the client sent', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());
  const port = await startProxy(upstream.port, t);

  await chat(port);
  const sent = upstream.calls[0];
  // 客户端发的是 LOGGED_IN_UID；本次实际用号也必须一致时才成立。
  // 这里两者相同是配置决定的；关键断言是「值来自 account.uid 而不是入站头」。
  assert.equal(sent['x-user-id'], LOGGED_IN_UID);

  // 换一个号必须跟着换：模拟「备份号」场景
  const upstream2 = await startUpstream();
  t.after(() => upstream2.server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-upstream-headers-2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const proxy = createCreditProxy({
    apiToken: LOCAL_API_KEY,
    listAccounts: () => [{ uid: ACCOUNT_UID }],
    // 登录的是 A，可用账号池里只有 B（A 不在 listAccounts 里）
    currentUid: () => LOGGED_IN_UID,
    getToken: async (uid) => `account-token-of-${uid}`,
    upstreamOrigin: `http://127.0.0.1:${upstream2.port}`,
    orderFile: path.join(dir, 'order.json'),
    upstreamUa: {
      resolve: async () => CLIENT_UA,
      identity: async () => ({ ua: CLIENT_UA, appVersion: '5.9.3', cliVersion: '2.165.0' }),
    },
    port: 0,
    log: () => {},
  });
  await proxy.start();
  t.after(() => proxy.stop());
  await chat(proxy.server.address().port);
  assert.equal(upstream2.calls[0]['x-user-id'], ACCOUNT_UID);
  assert.notEqual(upstream2.calls[0]['x-user-id'], LOGGED_IN_UID);
});

test('healthz lists the header names that actually left', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());
  const port = await startProxy(upstream.port, t);

  await chat(port);
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.ok(Array.isArray(health.upstreamHeaderKeys));
  for (const name of ['x-ide-name', 'x-product', 'x-user-id', 'x-agent-intent', 'authorization', 'user-agent']) {
    assert.ok(health.upstreamHeaderKeys.includes(name), `${name} 应出现在出站头里`);
  }
  // 只暴露头名，不能带头值
  assert.equal(JSON.stringify(health.upstreamHeaderKeys).includes('Bearer'), false);
});