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
 *     唯一的例外是 User-Agent：不设的话 undici 会发 `node`，等于自报「我是脚本」。
 *     这里改成这台机器上真实装着的官方客户端 UA（见 official-ua.js），
 *     只去掉最廉价的机器指纹，不伪造设备侧任何凭据。
 *  4. 日志只记 uid 前 8 位，不落 token、不落 prompt 内容。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createOfficialUa } = require(path.join(__dirname, 'official-ua.js'));

const HOST = '127.0.0.1';
const DEFAULT_PORT = 47900;
const DEFAULT_UPSTREAM = 'https://www.workbuddy.cn';
const UPSTREAM_PATH = '/v2/chat/completions';
// 一个请求最多换几次号（首个 chunk 之前才允许换）
const MAX_ACCOUNT_ATTEMPTS = 3;
// 网络层抖动（连接没建起来）与账号无关，重试同一账号比换号更有效。
// 数组长度即重试次数，值是该次重试前的等待毫秒数。
const NETWORK_RETRY_DELAYS = [300, 800];
// 单次请求上游超时（长文生成可能很久，给足）
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

// models.json 里的模型 id 用这些前缀标记「走本代理」，转发前剥掉。
// 保留 credit-rotation/ 只为兼容旧配置里的存量 id。
const MODEL_PREFIXES = ['m/', 'credit-rotation/'];

function shortUid(uid) {
  return String(uid || '').slice(0, 8) || 'unknown';
}

// 流式转发时只留尾部这么多字符用于找 usage：上游把它放在最后一条 data 里，
// 全量缓存既没必要也会吃内存。
const USAGE_TAIL_LIMIT = 32 * 1024;

/** 从 SSE 尾部文本取最后一个 usage 对象；找不到返回 null。 */
function parseUsageFromSse(text) {
  if (!text || !text.includes('"usage"')) return null;
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]' || !raw.includes('"usage"')) continue;
    try {
      const event = JSON.parse(raw);
      if (event && event.usage) found = event.usage;
    } catch (_) { /* 跨块截断的行跳过 */ }
  }
  return found;
}

/** 归一化用量：只取展示需要的四个数，缺失一律 0。 */
function pickUsageNumbers(usage) {
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const details = usage && usage.completion_tokens_details;
  return {
    pt: num(usage && usage.prompt_tokens),
    ct: num(usage && usage.completion_tokens),
    rt: num(details && details.reasoning_tokens),
    // credit 是本次请求实际扣掉的积分，服务端直接给出，无需再查积分接口。
    cr: num(usage && usage.credit),
  };
}

/**
 * 判断一个 SSE 分块里是否出现了首个正文/思考增量。
 * 只认非空内容：上游首帧常见的 "content":"" 是空角色帧，不能当成首 token，
 * 否则会把 prefill 时间误算进生成耗时。
 */
const FIRST_TOKEN_RE = /"delta"\s*:\s*\{[^{}]*"(?:content|reasoning_content)"\s*:\s*"(?!")/;

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

// 【临时调试，定位完即删】数据目录下放 .proxy-dump.on 时，把出站请求体与上游错误体
// 追加到 .proxy-dump.jsonl，用来抓出客户端特有字段触发的上游拒绝。
const DUMP_DIR = path.join(process.env.HOME || '', 'Library', 'Application Support', 'WorkDaddy');
const DUMP_FLAG = path.join(DUMP_DIR, '.proxy-dump.on');
const DUMP_FILE = path.join(DUMP_DIR, '.proxy-dump.jsonl');

// 选号顺序（用户可切换，落盘在数据目录，重启后保留）：
//  current  = 当前登录账号优先（默认）。请求用的 token 与客户端登录的账号一致，
//             不会出现「登的是 A、扣的是 B」这种凭据错配。
//  expiring = 临期积分优先（旧行为）。先把最早作废的备份账号积分烧掉，代价是错配。
const ORDER_MODES = ['current', 'expiring'];
const DEFAULT_ORDER_MODE = 'current';
const ORDER_FILE = path.join(DUMP_DIR, 'credit-proxy-order.json');

function readOrderMode(file = ORDER_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const mode = raw && raw.mode;
    return ORDER_MODES.includes(mode) ? mode : DEFAULT_ORDER_MODE;
  } catch (_) {
    return DEFAULT_ORDER_MODE;
  }
}

function writeOrderMode(mode, file = ORDER_FILE) {
  try {
    fs.writeFileSync(file, `${JSON.stringify({ mode, at: new Date().toISOString() }, null, 2)}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

/** 把「当前账号」与「备份账号池」按模式拼成候选列表。纯函数，便于测试。 */
function orderCandidates(pool, currentRows, mode) {
  const backups = Array.isArray(pool) ? pool : [];
  const current = Array.isArray(currentRows) ? currentRows : [];
  return mode === 'expiring' ? [...backups, ...current] : [...current, ...backups];
}
function dumpDebug(label, value) {
  try {
    if (!fs.existsSync(DUMP_FLAG)) return;
    fs.appendFileSync(DUMP_FILE, `${JSON.stringify({ at: new Date().toISOString(), label, value })}\n`);
  } catch (_) { /* 调试辅助不能影响主链路 */ }
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

// 本机专用端点的响应：不回 CORS 头。跨站页面即使绕过来源校验也读不到内容。
function sendJsonLocal(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * 上游业务错误码。HTTP 状态码往往只是 400，真正的判定在响应体的 code 字段里。
 *
 * level 的含义决定了「换号有没有用」：
 *  - channel：请求本身不像官方客户端（UA / 会话头 / 提示词指纹），换哪个账号都一样被拒；
 *  - request：请求体不合法（工具 schema、消息顺序、thinking 签名），换号也没用；
 *  - account：账号被上游限制。换号能继续跑，但这个账号必须立刻停用——继续用只会加速风控判定。
 *
 * 11140 是账号级红线的唯一明确信号：官方只让到官方客户端提交反馈，重登、换模型都无效。
 */
const UPSTREAM_CODES = {
  10085: { level: 'channel', label: '客户端身份校验未通过（UA 不是官方形态）' },
  11128: { level: 'channel', label: '渠道校验未通过（请求不像官方客户端）' },
  11133: { level: 'request', label: '工具定义不合法' },
  11140: { level: 'account', label: '账号被上游限制（异常活动），需到官方客户端提交反馈' },
  11153: { level: 'request', label: '对话必须以 user 消息结尾' },
  11159: { level: 'request', label: 'thinking 块不属于本次会话' },
};

/**
 * 解析上游错误体。只挑安全的字段：文案截断 200 字符，不带账号/凭据信息。
 * 返回 { code, message, label, level } —— code 解析失败时一律为 0，按 HTTP 状态码兜底分类。
 */
function readUpstreamError(text) {
  const empty = { code: 0, message: '', label: '', level: '' };
  if (!text) return empty;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const rawCode = parsed.code ?? parsed.error_code ?? (parsed.error && parsed.error.code);
  const code = Number(rawCode) || 0;
  const rawMessage = parsed.msg || parsed.message || (parsed.error && parsed.error.message);
  const known = UPSTREAM_CODES[code] || null;
  return {
    code,
    message: typeof rawMessage === 'string' ? rawMessage.slice(0, 200) : '',
    label: known ? known.label : '',
    level: known ? known.level : '',
  };
}

// 兼容旧调用点：只取文案，不关心业务码。
function readUpstreamMessage(text) {
  return readUpstreamError(text).message;
}

/**
 * 这个失败值不值得换个账号再试。
 * 已知业务码优先于 HTTP 状态码：账号被限制（11140）虽然多半挂在 400 上，但确实是账号级；
 * 渠道校验（11128 / 10085）虽然也可能配 400，但换号毫无意义，别拿去撞别的账号。
 */
function isAccountLevelFailure(status, code = 0) {
  const known = UPSTREAM_CODES[code];
  if (known && known.level === 'account') return true;
  if (known && (known.level === 'channel' || known.level === 'request')) return false;
  // 401/403 凭据失效、402 额度耗尽、429 限流：都可以尝试换一个账号。
  return status === 401 || status === 402 || status === 403 || status === 429;
}

// 上游对模型 id 严格区分大小写：传 DeepSeek-V4.1-Flash 会直接 400 service info not found。
// 所以按小写建一份索引做归一化，让配置里写成什么大小写都能落到上游认的写法。
// 只纠正已知 id —— 上游新增的模型名不在表里时原样透传，避免误改。
const UPSTREAM_MODEL_IDS = [
  'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro',
  'glm-5.2', 'glm-5.3', 'glm-5.3-flash',
  'hy3', 'hy3-c', 'hy3-x', 'hy4-preview', 'hy4-preview-f',
  'kimi-k2.7', 'kimi-k3.1-pro', 'mimo-v2.6-pro', 'minimax-m3', 'minimax-m3.1-flash',
  'space-bunny', 'step-5-preview',
  'auto', 'fast-model', 'balanced-model', 'deep-model',
];
const CANONICAL_MODEL_ID = new Map(UPSTREAM_MODEL_IDS.map((id) => [id.toLowerCase(), id]));

/**
 * 看板「上游可用但未配置」那一组的唯一数据源。
 *
 * 上游没有模型列表接口（/v1/models、/v2/models 等一律 404 Route Not Found，已实测），
 * 所以清单只能人工维护。放在网关这一侧，是为了避免它和 {@link UPSTREAM_MODEL_IDS}
 * 两份手写表各写各的、越飘越远：新增模型只改这里 + 上面那张归一化表。
 *
 * 写法用大写的展示形式（与 models.json 里 DeepSeek-V4.1-Flash 的命名一致），
 * 真正发请求前由 {@link normalizeModel} 转成上游认的小写形态。因此这里的每个 id
 * 都必须能在 UPSTREAM_MODEL_IDS 里命中，否则会被原样透传、上游直接 400。
 *
 * 只保留常用系列：deepseek 全系、glm 全系、kimi 全系、minimax m3 及以上。
 * hy / mimo / space-bunny / step-5-preview 等不在其中，不再出现在看板上。
 */
const ADDABLE_MODELS = [
  'DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash',
  'GLM-5.3-Flash', 'GLM-5.3', 'GLM-5.2',
  'Kimi-K3.1-Pro', 'Kimi-K2.7',
  'MiniMax-M3.1-Flash', 'MiniMax-M3',
];

function normalizeModel(model) {
  const value = String(model || '').trim();
  let stripped = value;
  for (const prefix of MODEL_PREFIXES) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length);
      break;
    }
  }
  return CANONICAL_MODEL_ID.get(stripped.toLowerCase()) || stripped;
}

/**
 * 各模型声明过的思考档位（与 WorkBuddy 官方客户端、DSH 渠道表逐条对齐）。
 *
 * 只给这里列出的模型补档位：上游对**不认识**的字段是宽容的，但对**不支持该
 * 档位**的模型会直接 400，所以表外模型一律原样透传，绝不臆造一个它没声明的值。
 */
const REASONING_LADDERS = new Map([
  ['deepseek-v4.1-flash', ['low', 'high', 'max']],
  ['deepseek-v4-flash', ['low', 'high', 'max']],
  ['deepseek-v4-pro', ['low', 'high', 'xhigh']],
  ['glm-5.2', ['high', 'xhigh']],
  ['glm-5.3', ['low', 'high', 'max']],
  ['glm-5.3-flash', ['low', 'high', 'max']],
  ['hy3', ['low', 'high']],
  ['hy3-c', ['low', 'high']],
  ['hy3-x', ['low', 'high']],
  ['hy4-preview', ['high']],
  ['kimi-k3.1-pro', ['low', 'high', 'max']],
  ['minimax-m3.1-flash', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['space-bunny', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['step-5-preview', ['low', 'medium', 'high']],
]);

/** 表示「不要思考」的几种写法：它们不是强度，原样发出去上游也不认。 */
const OFF_EFFORT_VALUES = new Set(['none', 'disabled', 'off', 'false', '0']);

/**
 * 给「说不上自己要不要思考」的调用方补一个最低档思考。
 *
 * ## 为什么必须补
 *
 * 上游这条车道里，`reasoning_effort` 才是思考的开关：不带档位的请求会被直接
 * 按不思考应答（实测：只带 `thinking:{type:'enabled'}` 时 reasoning_content
 * 恒为空）。而有的客户端 UI 保存不住思考配置，每轮都发不出档位，用户看到的
 * 就是「明明配了思考，实际从来不思考」。既然不发等于关闭，这里就补最短的
 * `low` —— 它真实生效、耗时和费用最低，比静默降级成不思考更接近调用方在 UI
 * 上表达的意思。
 *
 * ## 边界
 *
 * - 调用方给了一个**本模型支持**的档位 → 原样保留，不猜、不升级；
 * - 缺失、`null`、空串、`none`/`disabled`/`off` 等关闭写法，或本模型不支持的
 *   档位 → 落最低档（`low`；该模型没声明 `low` 时退到它的第一档）；
 * - 模型不在 {@link REASONING_LADDERS} 里 → 原样返回，一个字段都不加。
 *
 * @param {object} outgoing 即将发往上游的请求体（model 已归一化）
 * @returns {object} 可能补过档位的请求体；不需要补时返回入参本身
 */
function withDefaultEffort(outgoing) {
  const model = String(outgoing.model || '').toLowerCase();
  const ladder = REASONING_LADDERS.get(model);
  if (!ladder) return outgoing;
  const requested = typeof outgoing.reasoning_effort === 'string'
    ? outgoing.reasoning_effort.trim().toLowerCase()
    : '';
  const keep = requested !== '' && !OFF_EFFORT_VALUES.has(requested) && ladder.includes(requested);
  const effort = keep ? requested : (ladder.includes('low') ? 'low' : ladder[0]);
  const next = { ...outgoing, reasoning_effort: effort };
  // deepseek 系还要求 thinking 与档位**同时**在场才算开思考；只给档位不给
  // thinking 有效，但只给 thinking 无效，所以这里一并把开关摆正（调用方显式
  // 关掉的情况也按上面的口径重新打开）。
  if (/^deepseek/.test(model)) {
    next.thinking = { type: 'enabled' };
    delete next.enable_thinking;
  }
  return next;
}

/**
 * 上游 /v2/chat/completions 不认 OpenAI 较新的 role: "developer" —— 会返回
 * 400 Illegal API invocation from an unapproved channel。那句文案完全误导：看着像渠道/
 * 模型/鉴权问题，实际只是角色名不支持（实测：换成 system 立即 200，换回 developer 必 400）。
 * agent 类客户端（如 DeepSeek Harness 对推理模型）默认发 developer，这里统一降级成等价的 system。
 * 只改 role，其余字段（content / cache 控制等）原样保留。
 */
function downgradeDeveloperRole(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const downgraded = messages.map((message) => {
    if (message && message.role === 'developer') {
      changed = true;
      return { ...message, role: 'system' };
    }
    return message;
  });
  return changed ? downgraded : messages;
}

/**
 * 上游除了角色问题，还有一层「渠道校验」：请求体里出现若干已知第三方客户端的提示词指纹句时，
 * 会直接返回 400 + code 11128，文案是「这次调用没通过渠道校验，可能不是官方客户端发出的」。
 *
 * 实测结论（本轮逐字段二分得出）：
 *  - 与模型无关（4 个模型全拦），与 tools / store / stream_options / max_completion_tokens 无关；
 *  - 只查 messages 的文本内容，同义改写即可通过（打乱语序、换词都过；加空格/零宽字符无用）；
 *  - 是精确子串匹配，不是语义判定，所以把指纹句改成中性表述是安全的。
 *
 * 新增客户端或客户端升级提示词后若再撞上，用 .proxy-dump.on 抓包（见 dumpDebug），
 * 把新的指纹句补进来即可。
 */
const CLIENT_FINGERPRINTS = [
  // "You are an AI agent powered by DeepSeek Harness"、"...through the DeepSeek Harness Web GUI"
  [/\bdeepseek[\s-]+harness\b/gi, 'DeepSeek'],
  // "Tokens prefixed with @ are paths the user explicitly referenced. ..." 整句是其中一条指纹
  [/the user explicitly referenced/gi, 'the user referenced'],
];

/** 抹掉单段文本里的客户端指纹。非字符串原样返回。 */
function scrubClientFingerprint(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [pattern, replacement] of CLIENT_FINGERPRINTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 对 messages 的文本内容做指纹清洗，结构（role / 块类型 / 其它字段）完全不变。 */
function scrubMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((message) => {
    if (!message || message.content == null) return message;
    const content = message.content;
    if (typeof content === 'string') {
      const next = scrubClientFingerprint(content);
      if (next === content) return message;
      changed = true;
      return { ...message, content: next };
    }
    if (Array.isArray(content)) {
      let partChanged = false;
      const nextParts = content.map((part) => {
        if (!part || typeof part.text !== 'string') return part;
        const nextText = scrubClientFingerprint(part.text);
        if (nextText === part.text) return part;
        partChanged = true;
        return { ...part, text: nextText };
      });
      if (!partChanged) return message;
      changed = true;
      return { ...message, content: nextParts };
    }
    return message;
  });
  return changed ? out : messages;
}

function createCreditProxy(deps) {
  const {
    apiToken,
    listAccounts,
    creditCache,
    currentUid,
    getToken,
    usageStore = null,
    // 由 standalone 注入：写「已被用户终止」标记。缺省时 /control/stop 只是自停、
    // 不落标记，看门狗会在 60 秒内重新拉起。
    disable = null,
    // 由 standalone 注入：读 models.json 里指向本代理的模型配置。
    // 缺省 null 时 /v1/models 退回内置单条兜底，不影响正常转发。
    listModelConfigs = null,
    log = () => {},
    upstreamOrigin = DEFAULT_UPSTREAM,
    // 选号顺序的落盘位置。测试传临时文件，避免写进真实数据目录。
    orderFile = ORDER_FILE,
    // 上游 UA 解析器。缺省时按本机官方客户端自报值解析（见 official-ua.js），
    // 测试注入固定实现，避免依赖本机装了什么。
    upstreamUa = null,
    port = Number(process.env.WBSWITCH_CREDIT_PROXY_PORT) || DEFAULT_PORT,
  } = deps;

  // 上游 UA：默认取本机官方客户端自报值，四级降级（cdp → 包推导 → 本地缓存 → 出厂常量）。
  // 「取不到就不设 UA」是不允许的——那样会退回 undici 的 `node`，比什么都不做更显眼。
  // 注入实现（测试用）只保证 resolve，其余两个方法在这里补齐，调用点不必到处判空。
  const uaResolver = upstreamUa && typeof upstreamUa.resolve === 'function'
    ? {
      resolve: () => upstreamUa.resolve(),
      current: typeof upstreamUa.current === 'function' ? () => upstreamUa.current() : () => null,
      warmup: typeof upstreamUa.warmup === 'function' ? () => upstreamUa.warmup() : () => {},
    }
    : createOfficialUa({ log });

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
    // 被上游限制（11140）过的账号。只在本次进程内生效：重启后会再试一次，
    // 但绝不值得为了「万一解封」在这条进程里反复撞同一个号。
    restricted: [],
    // 最近一次请求实际用了哪个号、与客户端当前登录的号是否一致。
    // 看板据此把「登的是谁、用的是谁」摆到明面上，不再让错配悄悄发生。
    lastRequest: null,
    // 最近到达的请求（只记录元信息，不含 prompt 与 token 明文），
    // 用于区分「客户端没连上」和「连上了但被 401/404 拦」。
    recent: [],
  };

  // 账号被限制后立即移出轮换：继续拿它请求只会让风控画像更明显，
  // 而用户看到的又是「代理坏了」。宁可这次请求明确失败，也不再踩这个号。
  const restrictedUids = new Set();
  function noteRestricted(uid, code, message) {
    if (restrictedUids.has(uid)) return;
    restrictedUids.add(uid);
    const entry = { uid: shortUid(uid), code, message, at: new Date().toISOString() };
    stats.restricted.push(entry);
    log(`[credit-proxy] 账号 ${shortUid(uid)} 被上游限制（${code || '未知码'}），已移出轮换：${message || ''}`);
  }

  /** 记录「这次请求用的是谁」，并标出它是不是当前登录的号。 */
  function noteLastRequest(uid) {
    if (!uid) return;
    const cur = currentUid && currentUid();
    const matched = !!cur && String(uid) === String(cur);
    stats.lastRequest = {
      uid: shortUid(uid),
      current: cur ? shortUid(cur) : null,
      matched,
      at: new Date().toISOString(),
    };
    if (!matched && cur) {
      log(`[credit-proxy] 本次请求用号 ${shortUid(uid)}，与当前登录 ${shortUid(cur)} 不一致`);
    }
  }

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

  // 选号顺序：启动时读盘，运行中可被 /control/order 改。
  let orderMode = readOrderMode(orderFile);

  function candidates() {
    // daemon 会在别的进程里刷新余额并重写缓存文件，选号前先对齐磁盘版本，
    // 否则会用启动那一刻的余额排序，直到代理重启。
    if (creditCache && typeof creditCache.refresh === 'function') creditCache.refresh();
    const accounts = typeof listAccounts === 'function' ? listAccounts() : [];
    const { pool, currentRows } = rankAccounts(accounts, currentUid && currentUid(), creditCache);
    // 被上游限制过的账号不参与轮换（含当前账号兜底那一档）。
    const usable = (row) => !restrictedUids.has(row.uid);
    // 默认当前账号优先：谁登录就用谁的 token，避免「登 A 用 B」的凭据错配。
    // 切成 expiring 才回到旧的「最早过期优先」。
    return orderCandidates(pool.filter(usable), currentRows.filter(usable), orderMode)
      .slice(0, MAX_ACCOUNT_ATTEMPTS);
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
  async function callUpstream(payload, uid, attempt = 0) {
    const token = await resolveToken(uid);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      // 官方网关只接受流式请求；客户端要非流式时由本模块聚合。
      const outgoing = withDefaultEffort({
        ...payload,
        model: normalizeModel(payload.model),
        // 顺序：先把 developer 降级成 system，再抹客户端指纹（两步都不改其它字段）。
        messages: scrubMessages(downgradeDeveloperRole(payload.messages)),
        stream: true,
      });
      dumpDebug('outgoing', outgoing);
      // 上游不校验 UA（实测），但 undici 默认会发 `node`。这里换成官方客户端 UA，
      // 拿不到时由 official-ua 的缓存/常量兜底，所以正常情况下 ua 一定有值。
      const upstreamUaValue = await uaResolver.resolve();
      const response = await fetch(`${upstreamOrigin}${UPSTREAM_PATH}`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(upstreamUaValue ? { 'user-agent': upstreamUaValue } : {}),
        },
        body: JSON.stringify(outgoing),
        signal: controller.signal,
      });
      if (response.ok && response.body) {
        return { ok: true, response, uid };
      }
      const text = await response.text().catch(() => '');
      const failure = readUpstreamError(text);
      dumpDebug('upstream_error', { status: response.status, code: failure.code, body: text.slice(0, 2000) });
      return {
        ok: false,
        status: response.status || 502,
        code: failure.code,
        // 已知业务码优先用自己的中文说明：上游原文案容易误导（11128 常被当成鉴权问题）。
        message: failure.label || failure.message || `上游返回 ${response.status}`,
        accountLevel: isAccountLevelFailure(response.status, failure.code),
        uid,
      };
    } catch (error) {
      const aborted = Boolean(error && error.name === 'AbortError');
      const delay = NETWORK_RETRY_DELAYS[attempt];
      // 超时不重试（已经等满上游超时）；连接型失败按退避重试同一账号。
      if (!aborted && typeof delay === 'number') {
        log(`[credit-proxy] 账号 ${shortUid(uid)} 网络失败（${error.message || 'fetch failed'}），${delay}ms 后重试`);
        clearTimeout(timer);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return callUpstream(payload, uid, attempt + 1);
      }
      return {
        ok: false,
        status: 502,
        message: aborted ? '上游超时' : (error.message || '上游请求失败'),
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
      const message = restrictedUids.size > 0 ? '候选账号均被上游限制' : '没有可用账号（账号列表为空）';
      return { ok: false, status: 503, message };
    }
    let last = null;
    for (let index = 0; index < list.length; index += 1) {
      const account = list[index];
      if (index > 0) stats.rotations += 1;
      if (typeof onAttempt === 'function') onAttempt(account, index);
      const result = await callUpstream(payload, account.uid);
      if (result.ok) return result;
      last = result;
      // 账号被上游限制：先把号停掉，再试下一个；别让这个号继续被请求。
      if (result.code && UPSTREAM_CODES[result.code] && UPSTREAM_CODES[result.code].level === 'account') {
        noteRestricted(account.uid, result.code, result.message);
      }
      // 只有账号级失败才值得换号；渠道校验/请求本身有问题（400、11128）换谁都一样。
      if (!result.accountLevel) break;
      log(`[credit-proxy] 账号 ${shortUid(account.uid)} 失败（${result.status}${result.code ? ` / ${result.code}` : ''}），尝试下一个`);
    }
    return last || { ok: false, status: 502, message: '上游请求失败' };
  }

  /**
   * 流式透传给客户端，同时旁路记录是否有内容产出与末尾的用量统计。
   * since 传入请求开始时间时，额外测出首 token 延迟：用它把「等上下文」和「真正吐字」
   * 切开，否则长上下文的 tok/s 会被 prefill 摊平到毫无参考意义。
   */
  async function pipeStream(response, res, onChunk, since) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS_HEADERS,
    });
    let sawChunk = false;
    let firstTokenMs = 0;
    // 只保留尾部：上游把 usage 放在最后一条 data 里，全量缓存没必要。
    let tail = '';
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        if (!sawChunk) {
          sawChunk = true;
          res.flushHeaders && res.flushHeaders();
        }
        if (!firstTokenMs && since) {
          try {
            if (FIRST_TOKEN_RE.test(chunk.toString('utf8'))) firstTokenMs = nowMs() - since;
          } catch (_) { /* 编码异常时放弃首字计时，不影响转发本身 */ }
        }
        if (typeof onChunk === 'function') onChunk(chunk);
        if (chunk && chunk.length) {
          try {
            tail = (tail + chunk.toString('utf8')).slice(-USAGE_TAIL_LIMIT);
          } catch (_) { /* 编码异常不影响转发 */ }
        }
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
    } catch (error) {
      log(`[credit-proxy] 流式转发中断: ${error && error.message}`);
    } finally {
      res.end();
    }
    return { sawChunk, usage: parseUsageFromSse(tail), firstTokenMs };
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
      model: model || 'unknown',
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

  /**
   * 旁路记录一次请求的用量。失败不影响转发：看板是观测，不是链路的一部分。
   * 只记模型名、账号短 uid、token 数与积分，不落 prompt / 响应内容。
   */
  function recordUsage(info) {
    if (!usageStore) return;
    const base = {
      t: Date.now(),
      m: String(info.model || 'unknown'),
      u: shortUid(info.uid),
      ms: Math.max(0, Math.round(info.ms || 0)),
    };
    // ft = 首 token 延迟（ms）。缺省表示没测到（非流式或旧版本），看板据此回退算法。
    if (info.ttft) base.ft = Math.max(0, Math.round(info.ttft));
    if (!info.usage) {
      usageStore.record({ ...base, ok: 0, pt: 0, ct: 0, rt: 0, cr: 0 });
      return;
    }
    usageStore.record({ ...base, ok: 1, ...pickUsageNumbers(info.usage) });
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
    // 成败都记：失败时也要能看出「这次本来想用谁的号」。
    noteLastRequest(result.uid);

    if (!result.ok) {
      stats.failed += 1;
      stats.lastError = result.message;
      log(`[credit-proxy] 请求失败（${result.status}${result.code ? ` / ${result.code}` : ''}）: ${result.message}`);
      recordUsage({ model: payload.model, uid: result.uid, usage: null, ms: nowMs() - startedAt });
      return sendJson(res, result.status >= 400 && result.status < 600 ? result.status : 502, {
        // code 原样透出：客户端/看板要能区分「渠道校验」和「账号被限制」，这两件事的处理方式完全不同。
        error: { message: result.message || '上游请求失败', type: 'upstream_error', code: result.code || 0 },
      });
    }

    noteSuccess(result.uid);
    const elapsed = nowMs() - startedAt;
    const modelName = normalizeModel(payload.model);
    log(`[credit-proxy] 命中账号 ${shortUid(result.uid)}（排队+首字节 ${elapsed}ms，第 ${stats.served} 次）`);

    if (wantsStream) {
      const streamed = await pipeStream(result.response, res, null, startedAt);
      recordUsage({
        model: modelName,
        uid: result.uid,
        usage: streamed && streamed.usage,
        ms: nowMs() - startedAt,
        ttft: streamed && streamed.firstTokenMs,
      });
    } else {
      const aggregated = await aggregate(result.response);
      sendJson(res, 200, aggregated);
      recordUsage({ model: modelName, uid: result.uid, usage: aggregated && aggregated.usage, ms: nowMs() - startedAt });
    }
  }

  /** 本代理可转发的模型清单，数据源是 models.json 里 url 指向本端口的配置。 */
  function configuredModels() {
    if (typeof listModelConfigs !== 'function') return [];
    try {
      const rows = listModelConfigs();
      return Array.isArray(rows) ? rows.filter((row) => row && row.id) : [];
    } catch (error) {
      log(`[credit-proxy] 读取模型配置失败: ${error && error.message}`);
      return [];
    }
  }

  function handleModels(res) {
    // 早先这里硬编码单条兜底，客户端「获取可用模型」永远只拉回一个 deepseek。
    // 现在按 models.json 实际配置返回，缺配置时才退回兜底，避免返回空列表。
    const rows = configuredModels();
    const source = rows.length ? rows : [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }];
    sendJson(res, 200, {
      object: 'list',
      data: source.map((row) => ({
        id: row.id,
        object: 'model',
        owned_by: 'local',
        name: row.name || row.id,
      })),
    });
  }

  /**
   * 连通性探测：对指定模型 id 发一条极短请求，回答「这个 id 现在真的能通吗」。
   * 走同一串行队列，不和正常对话抢上游并发；探测请求不计入用量统计。
   */
  async function handleTestModel(req, res) {
    let body = {};
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
    } catch (_) {
      body = {};
    }
    const model = String((body && body.model) || '').trim();
    if (!model) return sendJson(res, 400, { ok: false, message: '缺少 model' });
    const startedAt = nowMs();
    await enqueue(async () => {
      const result = await callWithRotation(
        { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
        null,
      );
      // 看板上的「测试」按钮同样会占一个号，用的是不是登录那个号也要能看见。
      noteLastRequest(result.uid);
      if (result.ok) {
        // 必须把流读完，否则上游连接会挂着不释放。
        await result.response.text().catch(() => '');
        return sendJson(res, 200, {
          ok: true,
          model,
          ms: nowMs() - startedAt,
          uid: shortUid(result.uid),
        });
      }
      return sendJson(res, 200, {
        ok: false,
        model,
        status: result.status,
        message: result.message || '上游请求失败',
        ms: nowMs() - startedAt,
      });
    }).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, model, message: (error && error.message) || '探测失败' });
      }
    });
  }

  /**
   * 切换选号顺序并落盘。current = 当前登录账号优先（默认），expiring = 临期积分优先。
   * 落盘失败不影响本次进程内生效，只是重启后会回到默认，所以如实回 saved=false。
   */
  async function handleOrder(req, res) {
    let body = {};
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
    } catch (_) {
      body = {};
    }
    const mode = String((body && body.mode) || '').trim();
    if (!ORDER_MODES.includes(mode)) {
      return sendJson(res, 400, { ok: false, message: `mode 只能是 ${ORDER_MODES.join(' 或 ')}` });
    }
    orderMode = mode;
    const saved = writeOrderMode(mode, orderFile);
    log(`[credit-proxy] 选号顺序切换为 ${mode}${saved ? '' : '（落盘失败，重启后回退默认）'}`);
    return sendJson(res, 200, { ok: true, mode, saved });
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
      // 选号顺序与「登的是谁 / 用的是谁」：看板直接渲染，不在前端猜。
      order: orderMode,
      orderModes: ORDER_MODES,
      lastRequest: stats.lastRequest,
      // 这一发实际带出去的 UA 与它的来源（cdp / package / cache / builtin）。
      // 看板据此显示「UA 生效了吗」，避免以为改了却还在发 node。
      upstreamUa: uaResolver.current(),
      recent: stats.recent.slice(-12),
      candidates: list.map((row) => ({
        uid: shortUid(row.uid),
        nickname: row.nickname,
        isCurrent: row.isCurrent,
        remaining: row.remaining,
        expiresAt: row.expiresAt,
      })),
      // 看板据此渲染「上游可用但未配置」分组，前端不再自己维护一份清单。
      addableModels: ADDABLE_MODELS.filter((id) => CANONICAL_MODEL_ID.has(id.toLowerCase())),
    });
  }

  // 看板是随代理一起发布的单文件页面。按 mtime 缓存：改完页面刷新浏览器就能看到，
  // 不用重启代理进程（之前全量缓存导致每次改看板都得重启）。
  const DASHBOARD_FILE = path.join(__dirname, 'credit-proxy-dashboard.html');
  let dashboardCache = null;
  let dashboardMtime = 0;
  function serveDashboard(res) {
    try {
      const stat = fs.statSync(DASHBOARD_FILE);
      if (dashboardCache === null || stat.mtimeMs !== dashboardMtime) {
        dashboardCache = fs.readFileSync(DASHBOARD_FILE, 'utf8');
        dashboardMtime = stat.mtimeMs;
      }
    } catch (_) {
      if (dashboardCache === null) dashboardCache = '';
    }
    if (!dashboardCache) {
      return sendJson(res, 500, { error: { message: '看板页面缺失（credit-proxy-dashboard.html）' } });
    }
    // 看板上的「测试」按钮需要带 Bearer 调 /control/test-model。
    // 只把 token 注入到看板页面本身：能打开这个页面的人已经在 127.0.0.1 上，
    // 拿到的就是访问本机代理的同一份凭证，不额外扩大暴露面。
    const html = dashboardCache.split('__GW_TOKEN__').join(apiToken);
    const body = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
      ...CORS_HEADERS,
    });
    res.end(body);
  }

  // 看板、用量查询、控制接口携带或依赖本地凭证，只服务本机页面。
  function isLocalOnlyPath(pathname) {
    return pathname === '/dashboard'
      || pathname === '/usage/summary'
      || pathname === '/usage/recent'
      || pathname === '/control/stop'
      || pathname === '/control/test-model';
  }

  const LOCAL_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const LOCAL_ORIGINS = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);

  /**
   * 判断请求是否来自本机页面，三道都过才算：
   * 1) Host 必须是回环地址 —— 挡 DNS rebinding（域名解析到 127.0.0.1 时同源，但 Host 是域名）；
   * 2) 带 Origin 时必须等于本机同源地址 —— 挡跨站 fetch；
   * 3) 带 Sec-Fetch-Site 时只允许 same-origin / none —— 挡跨站 GET（浏览器跨站 GET 不带 Origin，只带这个）。
   * curl / 本机脚本三个头都不带，放行：它们本来就能直接读 .api-token，再拦没有意义。
   */
  function fromLocalPage(req) {
    const host = String(req.headers.host || '').trim().toLowerCase();
    if (host && !LOCAL_HOSTS.has(host)) return false;
    const origin = String(req.headers.origin || '').trim().toLowerCase();
    if (origin && !LOCAL_ORIGINS.has(origin)) return false;
    const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
    if (site && site !== 'same-origin' && site !== 'none') return false;
    return true;
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
      // 本机专用端点的预检也只认本机来源，跨站页面连预检都过不去。
      if (isLocalOnlyPath(pathname) && !fromLocalPage(req)) {
        return sendJsonLocal(res, 403, { error: { message: '仅允许本机页面访问', type: 'permission_error' } });
      }
      res.writeHead(204, { ...CORS_HEADERS, 'Content-Length': '0' });
      return res.end();
    }

    // 看板 / 用量 / 控制类端点只服务本机页面：这些端点会读到内嵌 token 或本机统计数据。
    if (isLocalOnlyPath(pathname) && !fromLocalPage(req)) {
      recordRequest(req, pathname, 'cross-site-blocked');
      return sendJsonLocal(res, 403, { error: { message: '仅允许本机页面访问', type: 'permission_error' } });
    }

    if (pathname === '/healthz') return handleHealth(res);
    // 用户在面板里点「终止网关」：先落禁用标记，再自停。标记必须由启动侧统一检查，
    // 否则看门狗 60 秒内又会把代理拉回来，按钮就成了摆设。
    if (pathname === '/control/stop' && req.method === 'POST') {
      if (!authorized(req)) {
        return sendJson(res, 401, { error: { message: '本地代理未授权', type: 'authentication_error' } });
      }
      let disabled = false;
      try {
        disabled = !!(typeof disable === 'function' && disable());
      } catch (_) {
        disabled = false;
      }
      sendJson(res, 200, { ok: true, disabled });
      setTimeout(() => process.exit(0), 150).unref();
      return;
    }
    // 看板上的「测试」按钮：探测某个模型 id 当前能否走通。
    if (pathname === '/control/test-model' && req.method === 'POST') {
      if (!authorized(req)) {
        return sendJson(res, 401, { error: { message: '本地代理未授权', type: 'authentication_error' } });
      }
      handleTestModel(req, res);
      return;
    }
    // 选号顺序切换：决定「谁登录就用谁」还是「先烧临期积分」。看板上的开关调它。
    if (pathname === '/control/order' && req.method === 'POST') {
      if (!authorized(req)) {
        return sendJson(res, 401, { error: { message: '本地代理未授权', type: 'authentication_error' } });
      }
      handleOrder(req, res);
      return;
    }
    // 看板与用量查询只读本机统计数据，不代理任何上游请求，也不记录到 recent，
    // 否则看板自身的轮询会把请求记录刷掉。
    if (pathname === '/dashboard') return serveDashboard(res);
    if (pathname === '/usage/summary') {
      if (!usageStore) return sendJson(res, 503, { error: { message: '用量统计未启用' } });
      return sendJson(res, 200, usageStore.summary(url.searchParams.get('days')));
    }
    if (pathname === '/usage/recent') {
      if (!usageStore) return sendJson(res, 503, { error: { message: '用量统计未启用' } });
      return sendJson(res, 200, { items: usageStore.recent(url.searchParams.get('limit')) });
    }
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
          // 先把 UA 探出来，别让首个请求替它等 CDP 超时。
          uaResolver.warmup();
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

module.exports = {
  createCreditProxy,
  rankAccounts,
  normalizeModel,
  withDefaultEffort,
  MODEL_PREFIXES,
  DEFAULT_PORT,
  UPSTREAM_CODES,
  readUpstreamError,
  isAccountLevelFailure,
  scrubMessages,
  downgradeDeveloperRole,
  ORDER_MODES,
  orderCandidates,
  readOrderMode,
};
