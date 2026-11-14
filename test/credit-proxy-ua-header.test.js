'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCreditProxy } = require('../scripts/credit-proxy.js');
const { BUILTIN_UA } = require('../scripts/official-ua.js');

const API_TOKEN = 'local-proxy-token';

// 端到端只验一件事：解析出来的 UA 真的写进了出站请求头。
// 解析链本身由 official-ua.test.js 覆盖，这里注入固定实现。

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

async function startProxy(upstreamPort, upstreamUa, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-ua-header-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const proxy = createCreditProxy({
    apiToken: API_TOKEN,
    listAccounts: () => [{ uid: 'cur00001' }],
    currentUid: () => 'cur00001',
    getToken: async (uid) => `{{SECRET_liv5a4fq}}${uid}`,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    orderFile: path.join(dir, 'order.json'),
    upstreamUa,
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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

test('the resolved UA is what leaves for upstream', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());
  const port = await startProxy(upstream.port, { resolve: async () => BUILTIN_UA }, t);

  const res = await chat(port);
  assert.equal(res.status, 200);
  assert.equal(upstream.calls.length, 1);
  // 不是 undici 默认的 node —— 那是本次改动要消掉的东西。
  assert.equal(upstream.calls[0]['user-agent'], BUILTIN_UA);
  assert.notEqual(upstream.calls[0]['user-agent'], 'node');
});

test('healthz exposes which UA is in effect and where it came from', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.server.close());
  const port = await startProxy(upstream.port, {
    resolve: async () => BUILTIN_UA,
    current: () => ({ ua: BUILTIN_UA, source: 'cdp', appVersion: '5.9.3' }),
  }, t);

  await chat(port);
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.upstreamUa.source, 'cdp');
  assert.equal(health.upstreamUa.ua, BUILTIN_UA);
});