'use strict';

/**
 * 出站请求头构造。
 *
 * 背景：代理原先只发 accept / content-type / authorization / user-agent 四个头，
 * 而上游存在两个明确的「形态校验」错误码（10085 客户端身份校验、11128 渠道校验），
 * 说明上游确实会看请求长什么样。官方客户端直连上游时带的是一整套身份头
 * （X-Ide-* / X-Product / X-Domain / X-Codebuddy-Request / X-Agent-* / X-Stainless-* …），
 * 本模块负责把这一套补齐，让出站请求的形状与官方客户端一致。
 *
 * 三条边界：
 *  1. 只补「官方客户端本来就发」的头，不造新的指纹字段，也不碰设备级凭据。
 *  2. 会话类头（X-Conversation-* / X-Request-Id / Traceparent）只透传、不伪造：
 *     编一个不存在的会话 id，反而会制造上游侧查无此会话的痕迹。
 *  3. X-User-Id 必须等于本次实际使用的账号 uid，不能透传客户端登录的那个 ——
 *     「token 是 B 的、用户头写 A」比不带这个头更可疑。
 *
 * 为什么这些头在入站请求里通常拿不到：客户端走的是自定义 OpenAI 兼容通道
 * （入站 UA 是 `OpenAI/JS x.y.z`），X-Ide-* 这一组是 WorkBuddy 自己在官方通道里加的。
 */

// 绝不透传：要么由 fetch/undici 自己管，要么会把本机凭据外发，要么会破坏流式转发。
const BLOCKED = new Set([
  // 传输层：由 undici 按实际连接自己决定
  'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'expect', 'proxy-connection',
  // 压缩协商：透传 br/gzip 后 undici 不保证解压，流式转发会吐乱码
  'accept-encoding',
  // 本机与凭据：入站的 authorization / x-api-key 是本地代理凭据，绝不能发到上游
  'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'cookie2',
  // 浏览器侧上下文：官方 node 客户端不会带这些
  'origin', 'referer', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user',
  'x-forwarded-for', 'x-forwarded-proto', 'forwarded', 'via',
  // 由本模块自行填写，不吃入站值
  'user-agent', 'x-user-id',
]);

// 入站有就原样透传：这些是本次调用链的真实上下文，照抄才自然。
const FORWARD_EXACT = [
  'accept-language',
  'sec-fetch-mode',
  'traceparent', 'b3', 'x-trace-id',
  'x-b3-traceid', 'x-b3-spanid', 'x-b3-parentspanid', 'x-b3-sampled',
  'acp-connection-id',
  'x-conversation-id', 'x-conversation-message-id', 'x-conversation-request-id',
  'x-request-id', 'x-root-request-id',
];

// 官方 SDK 指纹，随客户端版本变化，原样透传最真实。
const FORWARD_PREFIXES = ['x-stainless-'];

// 固定身份头：官方客户端每一个请求都带，值由本机客户端版本与请求上下文决定。
const IDE_NAME = 'WorkBuddy';

function isForwardable(name) {
  if (BLOCKED.has(name)) return false;
  if (FORWARD_EXACT.includes(name)) return true;
  return FORWARD_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * 把 Node 的 req.headers 压平成「小写名 → 字符串」。
 * 多值头（除 set-cookie 外 Node 会给数组）按 HTTP 语义用逗号合并。
 */
function flattenInbound(headers) {
  const out = Object.create(null);
  if (!headers || typeof headers !== 'object') return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName || '').trim().toLowerCase();
    if (!name) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (!text || /[\r\n]/.test(text)) continue;
    out[name] = text;
  }
  return out;
}

/** 从上游地址取域名，填 X-Domain；取不到就退回官方域名。 */
function domainOf(upstreamOrigin) {
  try {
    const host = new URL(String(upstreamOrigin || '')).hostname;
    return host || 'www.workbuddy.cn';
  } catch (_) {
    return 'www.workbuddy.cn';
  }
}

/**
 * 构造发往上游的完整请求头。
 *
 * @param {object} input
 * @param {object} input.inbound      Node 原始 req.headers（可为空，如看板「测试」按钮）
 * @param {string} input.uid          本次实际使用的账号 uid（写进 X-User-Id）
 * @param {string} input.token        该账号的 accessToken（写进 Authorization）
 * @param {object} input.client       { ua, appVersion } —— 来自 official-ua 的身份探测
 * @param {string} input.upstreamOrigin  上游源，仅用于推导 X-Domain
 * @returns {object} 可直接交给 fetch 的小写键头对象
 */
function buildUpstreamHeaders(input = {}) {
  const {
    inbound = null,
    uid = '',
    token = '',
    client = null,
    upstreamOrigin = '',
  } = input;

  const fromInbound = flattenInbound(inbound);
  const headers = Object.create(null);

  // 1) 透传本次调用链的真实上下文（会话 id、trace、SDK 指纹）
  for (const [name, value] of Object.entries(fromInbound)) {
    if (isForwardable(name)) headers[name] = value;
  }

  // 2) 补齐官方客户端固定身份头
  headers.accept = 'text/event-stream';
  headers['content-type'] = 'application/json';
  if (!headers['accept-language']) headers['accept-language'] = 'zh-CN,zh;q=0.9';
  headers['x-ide-name'] = IDE_NAME;
  headers['x-ide-type'] = IDE_NAME;
  const appVersion = String((client && client.appVersion) || '').trim();
  if (appVersion) headers['x-ide-version'] = appVersion;
  headers['x-product'] = 'SaaS';
  headers['x-codebuddy-request'] = '1';
  headers['x-requested-with'] = 'XMLHttpRequest';
  // 官方 Agent 侧语义：craft 意图、对话用途、本机 agent 运行时、主会话
  headers['x-agent-intent'] = 'craft';
  headers['x-agent-purpose'] = 'conversation';
  headers['x-agent-runtime'] = 'local-agent';
  headers['x-agent-type'] = 'main';
  // X-Domain 必须和实际上游域名一致，写死会在切换国际版时对不上
  headers['x-domain'] = domainOf(upstreamOrigin);

  // 3) 身份一致性：UA 用官方客户端形态，X-User-Id 用本次实际用号
  const ua = String((client && client.ua) || '').trim();
  if (ua && !/[\r\n]/.test(ua)) headers['user-agent'] = ua;
  if (uid) headers['x-user-id'] = String(uid);
  if (token) headers.authorization = `Bearer ${token}`;

  return headers;
}

module.exports = {
  BLOCKED,
  FORWARD_EXACT,
  FORWARD_PREFIXES,
  isForwardable,
  flattenInbound,
  domainOf,
  buildUpstreamHeaders,
};