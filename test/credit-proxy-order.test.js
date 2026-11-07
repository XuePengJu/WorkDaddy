'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createCreditProxy,
  orderCandidates,
  readOrderMode,
  ORDER_MODES,
} = require('../scripts/credit-proxy.js');

const API_TOKEN = 'local-proxy-token';

// 选号顺序决定了「登的号」和「用的号」是否一致：
//  current  = 当前登录账号优先，请求用的 token 就是登录的那个号；
//  expiring = 临期积分优先（旧行为），会先拿备份号的 token 去烧积分。
// 错配本身是账号风险，所以默认必须是 current，且改动要能落盘、能在看板上看见。

test('current mode puts the signed-in account in front of the backups', () => {
  const pool = [{ uid: 'bak1' }, { uid: 'bak2' }];
  const current = [{ uid: 'me' }];
  assert.deepEqual(orderCandidates(pool, current, 'current').map((r) => r.uid), ['me', 'bak1', 'bak2']);
});

test('expiring mode restores the old backup-first order', () => {
  const pool = [{ uid: 'bak1' }, { uid: 'bak2' }];
  const current = [{ uid: 'me' }];
  assert.deepEqual(orderCandidates(pool, current, 'expiring').map((r) => r.uid), ['bak1', 'bak2', 'me']);
});

test('missing arrays never break candidate assembly', () => {
  assert.deepEqual(orderCandidates(null, undefined, 'current'), []);
  assert.deepEqual(orderCandidates([{ uid: 'bak1' }], [], 'current').map((r) => r.uid), ['bak1']);
});

test('an unknown or unreadable order file falls back to the safe default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-order-read-'));
  const file = path.join(dir, 'order.json');
  assert.equal(readOrderMode(file), 'current');
  fs.writeFileSync(file, 'not json');
  assert.equal(readOrderMode(file), 'current');
  fs.writeFileSync(file, JSON.stringify({ mode: 'whatever' }));
  assert.equal(readOrderMode(file), 'current');
  fs.writeFileSync(file, JSON.stringify({ mode: 'expiring' }));
  assert.equal(readOrderMode(file), 'expiring');
  fs.rmSync(dir, { recursive: true, force: true });
});

function startUpstream() {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        calls.push(req.headers.authorization || '');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"id":"x","model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

async function startProxy(upstreamPort, orderFile) {
  const proxy = createCreditProxy({
    apiToken: API_TOKEN,
    listAccounts: () => ['cur00001', 'bak00001', 'bak00002'].map((uid) => ({ uid })),
    currentUid: () => 'cur00001',
    getToken: async (uid) => `token-${uid}`,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    orderFile,
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

function setOrder(port, mode) {
  return fetch(`http://127.0.0.1:${port}/control/order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ mode }),
  });
}

test('by default a request goes out on the signed-in account and never on a backup', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-order-default-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { proxy, port } = await startProxy(upstream.port, path.join(dir, 'order.json'));
  t.after(() => proxy.stop());

  const res = await chat(port);
  assert.equal(res.status, 200);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0], 'Bearer token-cur00001');

  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.order, 'current');
  assert.equal(health.lastRequest.uid, 'cur00001');
  assert.equal(health.lastRequest.current, 'cur00001');
  assert.equal(health.lastRequest.matched, true);
});

test('switching to expiring is persisted and shows up as a mismatch', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-order-switch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orderFile = path.join(dir, 'order.json');
  const { proxy, port } = await startProxy(upstream.port, orderFile);
  t.after(() => proxy.stop());

  const switched = await setOrder(port, 'expiring');
  assert.equal(switched.status, 200);
  const body = await switched.json();
  assert.equal(body.ok, true);
  assert.equal(body.saved, true);
  assert.equal(readOrderMode(orderFile), 'expiring');

  const res = await chat(port);
  assert.equal(res.status, 200);
  // 备份号排到了前面：这次用的不是登录的那个号，必须能被看见。
  assert.equal(upstream.calls[0].startsWith('Bearer token-cur00001'), false);

  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.order, 'expiring');
  assert.equal(health.lastRequest.matched, false);
  assert.equal(health.lastRequest.current, 'cur00001');
});

test('an unsupported mode is rejected instead of silently ignored', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-order-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { proxy, port } = await startProxy(upstream.port, path.join(dir, 'order.json'));
  t.after(() => proxy.stop());

  const res = await setOrder(port, 'whatever');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.message, new RegExp(ORDER_MODES.join('|')));
});