'use strict';

/**
 * 积分轮换代理（本地 OpenAI 兼容端点）。
 *
 * 目的：不切换客户端账号的前提下，用「最早过期且有剩余积分」的备份账号 token
 * 去请求官方模型，把即将作废的积分先烧掉，同时当前账号的资料库/会话/工作区完全不受影响。
 *
 * 设计约束（与项目 AGENTS.md 一致）：
 *  1. 端口固定，不参与 UI 端口回退（UI 端口会在 47832/17832/27832/37832 之间漂移）。
 *  2. 全局串行：同一时刻只允许一个上游请求在跑。官方只设计过串行切号，
 *     并发多账号是最容易被识别的异常模式，这里主动放弃并发度换安全。
 *  3. 身份只由 Bearer token 决定，本模块不发送任何设备指纹/用户 ID 头。
 *  4. 日志只记 uid 前 8 位，不落 token、不落 prompt 内容。
 */

const http = require('node:http');
const { Readable } = require('node:stream');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 47900;
const DEFAULT_UPSTREAM = 'https://www.workbuddy.cn';
const UPSTREAM_PATH = '/v2/chat/completions';
// 一个请求最多换几次号（首个 chunk 之前才允许换）
const MAX_ACCOUNT_ATTEMPTS = 3;
// 单次请求上游超时（长文生成可能很久，给足）
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

// models.json 里的模型 id 用这个前缀标记「走本代理」，转发前剥掉。
const MODEL_PREFIX = 'credit-rotation/';

function shortUid(uid) {
  return String(uid || '').slice(0, 8) || 'unknown';
}

function nowMs() {
  return Date.now();
}

/**
 * 给账号打分并排序，产出「优先消耗」的候选队列。
 * 规则：排除当前账号 → 排除无限额 → 有余额的按最近过期时间升序 → 余额未知的排后面。
 * 缓存里没有积分数据的账号不会被丢弃，只是排在已知过期时间之后（避免缓存空窗导致代理不可用）。
 */
function rankAccounts(accounts, currentUid, creditCache) {
  const current = String(currentUid || '');
  const rows = (Array.isArray(accounts) ? accounts : [])
    .filter((account) => account && account.uid)
    .map((account) => {
      const cached = (creditCache && creditCache.get(account.uid)) || {};
      const segments = (Array.isArray(cached.creditSegments) ? cached.creditSegments : [])
        .filter((segment) => segment && Number(segment.remaining) > 0);
      const expiring = segments
        .filter((segment) => typeof segment.expiresAt === 'number' && Number.isFinite(segment.expiresAt))
        .sort((a, b) => a.expiresAt - b.expiresAt);
      const remaining = segments.reduce((sum, segment) => sum + Number(segment.remaining || 0), 0);
      return {
        uid: String(account.uid),
        nickname: account.nickname || '',
        isCurrent: String(account.uid) === current,
        unlimited: cached.creditUnlimited === true,
        known: segments.length > 0,
        remaining,
        expiresAt: expiring.length > 0 ? expiring[0].expiresAt : null,
      };
    });

  const currentRows = rows.filter((row) => row.isCurrent);
  const pool = rows
    .filter((row) => !row.isCurrent && !row.unlimited)
    // 余额明确为 0 的跳过；余额未知（缓存空窗）保留，否则缓存缺失时代理会直接不可用。
    .filter((row) => !row.known || row.remaining > 0)
    .sort((a, b) => {
      const ae = a.expiresAt === null ? Number.MAX_SAFE_INTEGER : a.expiresAt;
      const be = b.expiresAt === null ? Number.MAX_SAFE_INTEGER : b.expiresAt;
      if (ae !== be) return ae - be;
      return b.remaining - a.remaining;
    });

  return { pool, currentRows };
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 渲染进程直接 fetch 本机代理时会先发 OPTIONS 预检；缺了这些头浏览器会直接拦掉请求，
// 表现为「接口调不通」而服务端一条请求都收不到。
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key, accept, x-requested-with',
  'Access-Control-Max-Age': '86400',
};

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(text);
}

// 上游错误里可能带账号信息，只挑安全的字段回给客户端。
function readUpstreamMessage(text) {
  try {
    const parsed = JSON.parse(text);
    const message = parsed && (parsed.msg || parsed.message || (parsed.error && parsed.error.message));
    return typeof message === 'string' ? message.slice(0, 200) : '';
  } catch (_) {
    return '';
  }
}

function isAccountLevelFailure(status) {
  // 401/403 凭据失效、402 额度耗尽、429 限流：都可以尝试换一个账号。
  return status === 401 || status === 402 || status === 403 || status === 429;
}

function normalizeModel(model) {
  const value = String(model || '').trim();
  if (value.startsWith(MODEL_PREFIX)) return value.slice(MODEL_PREFIX.length);
  return value;
}

function createCreditProxy(deps) {
  const {
    apiToken,
    listAccounts,
    creditCache,
    currentUid,
    getToken,
    log = () => {},
    upstreamOrigin = DEFAULT_UPSTREAM,
    port = Number(process.env.WBSWITCH_CREDIT_PROXY_PORT) || DEFAULT_PORT,
  } = deps;

  // ---- 全局串行队列：同一时刻只跑一个上游请求 ----
  let chain = Promise.resolve();
  function enqueue(task) {
    const run = chain.then(task, task);
    // 队列本身不能被单个请求的失败打断
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  const stats = {
    startedAt: nowMs(),
    served: 0,
    failed: 0,
    rotations: 0,
    lastUid: null,
    lastError: null,
    byUid: Object.create(null),
    // 最近到达的请求（只记录元信息，不含 prompt 与 token 明文），
    // 用于区分「客户端没连上」和「连上了但被 401/404 拦」。
    recent: [],
  };

  function recordRequest(req, pathname, verdict) {
    const auth = String(req.headers.authorization || '');
    stats.recent.push({
      at: new Date().toISOString(),
      method: req.method,
      path: pathname,
      verdict,
      authKind: !auth ? 'none' : (auth.startsWith('Bearer ') ? 'bearer' : 'other'),
      authLen: auth.startsWith('Bearer ') ? auth.slice(7).trim().length : 0,
      apiKeyLen: String(req.headers['x-api-key'] || '').trim().length,
      ua: String(req.headers['user-agent'] || '').slice(0, 60),
      origin: String(req.headers.origin || '').slice(0, 40),
    });
    if (stats.recent.length > 25) stats.recent.shift();
  }

  function noteSuccess(uid) {
    stats.served += 1;
    stats.lastUid = uid;
    stats.lastError = null;
    stats.byUid[uid] = (stats.byUid[uid] || 0) + 1;
  }

  function candidates() {
    const accounts = typeof listAccounts === 'function' ? listAccounts() : [];
    const { pool, currentRows } = rankAccounts(accounts, currentUid && currentUid(), creditCache);
    // 备份账号按「最早过期优先」，最后用当前账号兜底保证可用性。
    return [...pool, ...currentRows].slice(0, MAX_ACCOUNT_ATTEMPTS);
  }

  async function resolveToken(uid) {
    const token = await getToken(uid);
    if (!token) throw new Error(`账号 ${shortUid(uid)} 无可用 accessToken`);
    return token;
  }

  /**
   * 真正向上游发起请求。返回 { ok, status, response } 或 { ok:false, status, message }。
   * 注意：这里不读 body，交给调用方决定是流式透传还是聚合。
   */
  async function callUpstream(payload, uid) {
    const token = await resolveToken(uid);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetch(`${upstreamOrigin}${UPSTREAM_PATH}`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        // 官方网关只接受流式请求；客户端要非流式时由本模块聚合。
        body: JSON.stringify({ ...payload, model: normalizeModel(payload.model), stream: true }),
        signal: controller.signal,
      });
      if (response.ok && response.body) {
        return { ok: true, response, uid };
      }
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        status: response.status || 502,
        message: readUpstreamMessage(text) || `上游返回 ${response.status}`,
        uid,
      };
    } catch (error) {
      return {
        ok: false,
        status: 502,
        message: error && error.name === 'AbortError' ? '上游超时' : (error.message || '上游请求失败'),
        uid,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 依次尝试候选账号，返回第一个成功的上游响应。 */
  async function callWithRotation(payload, onAttempt) {
    const list = candidates();
    if (list.length === 0) {
      return { ok: false, status: 503, message: '没有可用账号（账号列表为空）' };
    }
    let last = null;
    for (let index = 0; index < list.length; index += 1) {
      const account = list[index];
      if (index > 0) stats.rotations += 1;
      if (typeof onAttempt === 'function') onAttempt(account, index);
      const result = await callUpstream(payload, account.uid);
      if (result.ok) return result;
      last = result;
      // 只有账号级失败才值得换号；请求本身有问题（400）换谁都一样。
      if (!isAccountLevelFailure(result.status)) break;
      log(`[credit-proxy] 账号 ${shortUid(account.uid)} 失败（${result.status}），尝试下一个`);
    }
    return last || { ok: false, status: 502, message: '上游请求失败' };
  }

  /** 流式透传给客户端，同时旁路记录是否有内容产出。 */
  async function pipeStream(response, res, onChunk) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS_HEADERS,
    });
    let sawChunk = false;
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        if (!sawChunk) {
          sawChunk = true;
          res.flushHeaders && res.flushHeaders();
        }
        if (typeof onChunk === 'function') onChunk(chunk);
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
    } catch (error) {
      log(`[credit-proxy] 流式转发中断: ${error && error.message}`);
    } finally {
      res.end();
    }
    return sawChunk;
  }

  /** 把 SSE chunk 聚合成非流式 OpenAI 响应（客户端请求 stream:false 时用）。 */
  async function aggregate(response) {
    let text = '';
    for await (const chunk of Readable.fromWeb(response.body)) {
      text += chunk.toString('utf8');
    }
    let content = '';
    let reasoning = '';
    let finish = 'stop';
    let usage = null;
    let id = '';
    let model = '';
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch (_) {
        continue;
      }
      if (event.id) id = event.id;
      if (event.model) model = event.model;
      if (event.usage) usage = event.usage;
      const choice = event.choices && event.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string') content += delta.content;
      // 部分模型把思考过程放在 reasoning_content
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    }
    return {
      id: id || `credit-proxy-${nowMs()}`,
      object: 'chat.completion',
      created: Math.floor(nowMs() / 1000),
      model: model || 'credit-rotation',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: finish,
        },
      ],
      ...(usage ? { usage } : {}),
    };
  }

  async function handleChat(req, res) {
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : null;
    } catch (error) {
      return sendJson(res, 400, { error: { message: `请求体解析失败: ${error.message}`, type: 'invalid_request_error' } });
    }
    if (!payload || !Array.isArray(payload.messages)) {
      return sendJson(res, 400, { error: { message: '缺少 messages 字段', type: 'invalid_request_error' } });
    }

    const wantsStream = payload.stream === true;
    const startedAt = nowMs();
    const result = await enqueue(() => callWithRotation(payload, (account, index) => {
      if (index > 0) log(`[credit-proxy] 换号重试 → ${shortUid(account.uid)}`);
    }));

    if (!result.ok) {
      stats.failed += 1;
      stats.lastError = result.message;
      log(`[credit-proxy] 请求失败（${result.status}）: ${result.message}`);
      return sendJson(res, result.status >= 400 && result.status < 600 ? result.status : 502, {
        error: { message: result.message || '上游请求失败', type: 'upstream_error' },
      });
    }

    noteSuccess(result.uid);
    const elapsed = nowMs() - startedAt;
    log(`[credit-proxy] 命中账号 ${shortUid(result.uid)}（排队+首字节 ${elapsed}ms，第 ${stats.served} 次）`);

    if (wantsStream) {
      await pipeStream(result.response, res);
    } else {
      const aggregated = await aggregate(result.response);
      sendJson(res, 200, aggregated);
    }
  }

  function handleModels(res) {
    // 只描述本代理能转发的模型族；真实可用模型由官方账号下发，这里给最小信息集。
    const ids = (deps.modelIds && deps.modelIds.length ? deps.modelIds : ['deepseek-v4.1-flash']);
    sendJson(res, 200, {
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', owned_by: 'credit-rotation' })),
    });
  }

  function handleHealth(res) {
    const list = candidates();
    sendJson(res, 200, {
      ok: true,
      port,
      uptimeMs: nowMs() - stats.startedAt,
      served: stats.served,
      failed: stats.failed,
      rotations: stats.rotations,
      lastUid: stats.lastUid ? shortUid(stats.lastUid) : null,
      lastError: stats.lastError,
      accounts: stats.byUid,
      queue: { serial: true },
      recent: stats.recent.slice(-12),
      candidates: list.map((row) => ({
        uid: shortUid(row.uid),
        nickname: row.nickname,
        isCurrent: row.isCurrent,
        remaining: row.remaining,
        expiresAt: row.expiresAt,
      })),
    });
  }

  function authorized(req) {
    const header = String(req.headers.authorization || '');
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    // 兼容把 apiKey 放进 x-api-key 的客户端
    const alt = String(req.headers['x-api-key'] || '').trim();
    const token = bearer || alt;
    return !!token && token === apiToken;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}:${port}`);
    const pathname = url.pathname;

    // CORS 预检：直接放行，不做鉴权（浏览器不会在预检里带 Authorization）。
    if (req.method === 'OPTIONS') {
      recordRequest(req, pathname, 'preflight');
      res.writeHead(204, { ...CORS_HEADERS, 'Content-Length': '0' });
      return res.end();
    }

    if (pathname === '/healthz') return handleHealth(res);
    if (pathname === '/v1/models' && req.method === 'GET') {
      recordRequest(req, pathname, 'models');
      return handleModels(res);
    }

    if (pathname !== '/v1/chat/completions' || req.method !== 'POST') {
      recordRequest(req, pathname, 'unknown-path');
      return sendJson(res, 404, { error: { message: `未知路径 ${pathname}`, type: 'invalid_request_error' } });
    }
    if (!authorized(req)) {
      recordRequest(req, pathname, 'unauthorized');
      stats.failed += 1;
      stats.lastError = 'unauthorized';
      return sendJson(res, 401, { error: { message: '本地代理未授权', type: 'authentication_error' } });
    }
    recordRequest(req, pathname, 'accepted');
    handleChat(req, res).catch((error) => {
      stats.failed += 1;
      stats.lastError = error.message;
      log(`[credit-proxy] 未处理异常: ${error && error.message}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: error.message || '代理内部错误', type: 'proxy_error' } });
      } else {
        try { res.end(); } catch (_) {}
      }
    });
  });

  return {
    server,
    port,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', (error) => {
          // 端口被占时明确报错，不静默改端口——models.json 里写死了这个端口。
          reject(error);
        });
        server.listen(port, HOST, () => {
          log(`[credit-proxy] 已监听 http://${HOST}:${port}（串行模式，候选账号 ${candidates().length} 个）`);
          resolve({ port, host: HOST });
        });
      });
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    stats,
  };
}

module.exports = { createCreditProxy, rankAccounts, normalizeModel, MODEL_PREFIX, DEFAULT_PORT };
