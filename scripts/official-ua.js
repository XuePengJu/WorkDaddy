'use strict';

/**
 * 上游请求的 User-Agent 解析。
 *
 * 为什么需要它：本代理用 Node 的 fetch 转发，undici 默认会发 `user-agent: node` ——
 * 等于主动告诉上游「这一发是脚本发的」。实测上游 /v2/chat/completions 并不校验 UA
 * （node / curl / 浏览器 / 官方 Electron 四种 UA 全是 200，见 2026-11-07 探针），
 * 所以换 UA 不解决任何报错，只去掉一个最廉价的机器指纹。
 *
 * 它不构成「伪装官方客户端」：官方请求真正无法伪造的东西（X-Device-Token 那类
 * 设备指纹头）本模块一概不碰，这里只把「我是 node」换成「我是这台机器上真实装着的
 * 那个客户端」。
 *
 * 取值链（按可信度排，前一级拿到就停）：
 *  1. cdp     —— 运行中的官方客户端自报（127.0.0.1:<port>/json/version），最权威
 *  2. package —— 从本机安装包版本推导（app 版本 / Chromium / Electron），无需客户端在跑
 *  3. cache   —— 上一次成功取到的值（落盘），这次两级都取不到时用它兜底
 *  4. builtin —— 出厂常量，最后一道保险，保证永远有 UA
 *
 * 1 或 2 成功都会写缓存，所以「启动时取不到」只会临时退到第 3 级，不会退化成不发 UA。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DATA_DIR = process.env.WBSWITCH_DATA_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'WorkDaddy');
const UA_CACHE_FILE = path.join(DATA_DIR, 'credit-proxy-ua.json');

// 2026-11-07 从运行中的 WorkBuddy 5.9.3 客户端 CDP 自报值。仅作最后兜底：
// 版本号会随客户端升级过期，正常情况下永远走前两级，轮不到它。
const BUILTIN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) WorkBuddy/5.9.3 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36';

const DEFAULT_CDP_PORT = Number(process.env.WBSWITCH_CDP_PORT) || 9226;
const DEFAULT_CDP_TIMEOUT_MS = 800;
const DEFAULT_MEMORY_TTL_MS = 10 * 60 * 1000;

// 客户端产品令牌。国际版可能是 WorkBuddyAI/ 或 WorkBuddy AI/。
const PRODUCT_TOKEN = /\bWorkBuddy(?:AI|[- ]AI)?\/(\d+(?:\.\d+){1,3})(?=\s|$)/i;

/** 只放行「像正常浏览器 UA」的字符串，避免把 HTML 报错页或空串写进缓存。 */
function saneUa(value) {
  const ua = String(value || '').trim();
  if (ua.length < 40 || ua.length > 400) return '';
  if (/[\r\n\t]/.test(ua)) return '';
  if (!/^Mozilla\/5\.0/.test(ua)) return '';
  if (!/AppleWebKit\//.test(ua)) return '';
  return ua;
}

/**
 * 从运行中的客户端自报 UA 里取。
 * 只认产品令牌是 WorkBuddy 的：9222 这类端口也可能被用户的 Chrome 占着，
 * 拿 Chrome 的 UA 去冒充官方客户端，比 node 更糟。
 */
async function detectFromCdp(options = {}) {
  const port = options.port || DEFAULT_CDP_PORT;
  const fetchImpl = options.fetchImpl || fetch;
  let timer = null;
  try {
    const timeout = options.timeoutMs || DEFAULT_CDP_TIMEOUT_MS;
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    if (!res || !res.ok) return null;
    const info = await res.json();
    const ua = saneUa(info && (info['User-Agent'] || info.userAgent));
    if (!ua) return null;
    const product = PRODUCT_TOKEN.exec(ua);
    if (!product) return null;
    return { ua, appVersion: product[1] || '' };
  } catch (_) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 用 plutil / strings 读安装包版本，拼出与官方客户端一致的 UA。非 macOS 直接放弃。 */
function detectFromPackage(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return null;
  const appPaths = options.appPaths
    || ['/Applications/WorkBuddy.app', '/Applications/WorkBuddyAI.app', '/Applications/WorkDaddy.app'];
  const run = options.exec || ((file, args) => {
    const out = spawnSync(file, args, { encoding: 'utf8', timeout: 8000, maxBuffer: 32 * 1024 * 1024 });
    if (out.error || out.status !== 0) return '';
    return String(out.stdout || '');
  });

  for (const app of appPaths) {
    try {
      const appVersion = run('plutil', [
        '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
        path.join(app, 'Contents', 'Info.plist'),
      ]).trim();
      if (!appVersion) continue;
      const framework = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A');
      const electron = run('plutil', [
        '-extract', 'CFBundleVersion', 'raw', '-o', '-',
        path.join(framework, 'Resources', 'Info.plist'),
      ]).trim();
      // Chromium 版本只写在框架二进制里（strings 扫一遍约 0.1s），
      // 且只有 CDP 取不到时才会走到这一步，所以不进热路径。
      const chromeMatch = /Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(
        run('strings', [path.join(framework, 'Electron Framework')]),
      );
      const chrome = chromeMatch ? chromeMatch[1] : '';
      if (!electron || !chrome) continue;
      const ua = saneUa(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
        + `(KHTML, like Gecko) WorkBuddy/${appVersion} Chrome/${chrome} Electron/${electron} Safari/537.36`,
      );
      if (ua) return { ua, appVersion };
    } catch (_) { /* 换下一个候选包 */ }
  }
  return null;
}

/**
 * 探测包内 Agent CLI 版本。
 *
 * 为什么要它：官方 node 客户端发往上游的 UA 是
 *   `WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0`
 * 后段来自 app 包内自带的 @genie/agent-cli 版本（实测在
 * `<app>/Contents/Resources/app.asar.unpacked/cli/package.json`）。
 * 只写死前段会随客户端升级立刻过期，所以两段都从安装包里读。
 */
function detectCliVersion(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return '';
  const appPaths = options.appPaths
    || ['/Applications/WorkBuddy.app', '/Applications/WorkBuddyAI.app', '/Applications/WorkDaddy.app'];
  const readFile = options.readFile || ((file) => fs.readFileSync(file, 'utf8'));
  for (const app of appPaths) {
    try {
      const raw = readFile(path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'package.json'));
      const version = String((JSON.parse(raw) || {}).version || '').trim();
      if (/^\d+(?:\.\d+){1,3}$/.test(version)) return version;
    } catch (_) { /* 换下一个候选包 */ }
  }
  return '';
}

/**
 * 拼官方 node 客户端形态的 UA。
 * 缺版本就返回空串：宁可退到上一级取值，也不要拼一个 `WorkBuddy/undefined` 出去。
 */
function nodeUa(appVersion, cliVersion) {
  const app = String(appVersion || '').trim();
  if (!/^\d+(?:\.\d+){1,3}$/.test(app)) return '';
  const cli = String(cliVersion || '').trim();
  const head = `WorkBuddy/${app} WorkBuddy/${app}`;
  const ua = /^\d+(?:\.\d+){1,3}$/.test(cli) ? `${head} CLI/${cli}` : head;
  return saneNodeUa(ua);
}

/** node 客户端 UA 不是浏览器形态，不能用 saneUa（它只放行 Mozilla/AppleWebKit）。 */
function saneNodeUa(value) {
  const ua = String(value || '').trim();
  if (ua.length < 16 || ua.length > 200) return '';
  if (/[\r\n\t]/.test(ua)) return '';
  if (!/^WorkBuddy\/\d/.test(ua)) return '';
  return ua;
}

function readUaCache(file = UA_CACHE_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ua = saneUa(raw && raw.ua);
    if (!ua) return null;
    return {
      ua,
      source: String(raw.source || 'cache'),
      appVersion: String(raw.appVersion || ''),
      cliVersion: String(raw.cliVersion || ''),
      at: raw.at || '',
    };
  } catch (_) {
    return null;
  }
}

function writeUaCache(entry, file = UA_CACHE_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      ua: entry.ua,
      source: entry.source,
      appVersion: entry.appVersion || '',
      cliVersion: entry.cliVersion || '',
      at: new Date().toISOString(),
    };
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 建一个带内存缓存的解析器。
 *  - resolve(): 需要时探一次，TTL 内直接返回内存值；
 *  - current(): 同步拿「上一次解析结果」，供 /healthz 与看板展示；
 *  - warmup() : 启动时先探一次，避免首个请求承担探测延迟。
 */
function createOfficialUa(options = {}) {
  const cacheFile = options.cacheFile || UA_CACHE_FILE;
  const ttlMs = options.ttlMs || DEFAULT_MEMORY_TTL_MS;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const detectCdp = options.detectCdp || detectFromCdp;
  const detectPackage = options.detectPackage || detectFromPackage;
  const readCache = options.readCache || ((file) => readUaCache(file));
  const writeCache = options.writeCache || ((entry, file) => writeUaCache(entry, file));

  let memo = null;
  let memoAt = 0;
  let inflight = null;
  let lastLoggedSource = '';

  async function probe() {
    const detectCli = options.detectCli || ((opts) => detectCliVersion(opts));
    const cliOpts = { platform: options.platform, appPaths: options.appPaths, readFile: options.readFile };
    let cliVersion = '';
    try {
      cliVersion = detectCli(cliOpts) || '';
    } catch (_) { /* CLI 版本只是锦上添花，探测失败不影响主链路 */ }

    const fromCdp = await detectCdp({ port: options.port });
    if (fromCdp && fromCdp.ua) {
      const entry = { ua: fromCdp.ua, source: 'cdp', appVersion: fromCdp.appVersion, cliVersion };
      writeCache(entry, cacheFile);
      return { ...entry, nodeUa: nodeUa(fromCdp.appVersion, cliVersion) };
    }
    const fromPackage = detectPackage({ platform: options.platform });
    if (fromPackage && fromPackage.ua) {
      const entry = { ua: fromPackage.ua, source: 'package', appVersion: fromPackage.appVersion, cliVersion };
      writeCache(entry, cacheFile);
      return { ...entry, nodeUa: nodeUa(fromPackage.appVersion, cliVersion) };
    }
    const cached = readCache(cacheFile);
    if (cached && cached.ua) {
      const cli = cached.cliVersion || cliVersion;
      return { ...cached, cliVersion: cli, nodeUa: nodeUa(cached.appVersion, cli) };
    }
    const builtinVersion = PRODUCT_TOKEN.exec(BUILTIN_UA)?.[1] || '';
    return {
      ua: BUILTIN_UA,
      source: 'builtin',
      appVersion: builtinVersion,
      cliVersion,
      nodeUa: nodeUa(builtinVersion, cliVersion),
    };
  }

  async function resolve() {
    if (memo && Date.now() - memoAt < ttlMs) return memo.ua;
    if (inflight) return inflight;
    inflight = (async () => {
      let result;
      try {
        result = await probe();
      } catch (_) {
        // 探测异常绝不能影响转发：内存值 > 缓存 > 出厂常量。
        result = memo || readCache(cacheFile) || { ua: BUILTIN_UA, source: 'builtin' };
      }
      memo = result;
      memoAt = Date.now();
      if (result.source !== lastLoggedSource) {
        lastLoggedSource = result.source;
        log(`[credit-proxy] 上游 UA 采用 ${result.source}（${result.ua.slice(0, 96)}）`);
      }
      return result.ua;
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  /**
   * 出站身份：UA + 客户端版本，供请求头构造使用（见 upstream-headers.js）。
   * ua 优先用官方 node 客户端形态（`WorkBuddy/x WorkBuddy/x CLI/y`）：
   * 那才是客户端真正发往上游的形态，浏览器 UA 只有 Electron 渲染进程才用。
   * node 形态拼不出来时退回探测到的原始 ua，保证永远有值。
   */
  async function identity() {
    const fallbackUa = await resolve();
    const meta = memo || {};
    const appVersion = String(meta.appVersion || '').trim();
    const cliVersion = String(meta.cliVersion || '').trim();
    const official = String(meta.nodeUa || '').trim() || nodeUa(appVersion, cliVersion);
    return {
      ua: official || fallbackUa,
      appVersion,
      cliVersion,
      source: meta.source || 'builtin',
      nodeShaped: !!official,
    };
  }

  function current() {
    if (!memo) return null;
    return { ...memo, ageMs: Date.now() - memoAt };
  }

  return { resolve, identity, current, warmup: () => resolve().catch(() => '') };
}

module.exports = {
  BUILTIN_UA,
  UA_CACHE_FILE,
  DEFAULT_CDP_PORT,
  saneUa,
  saneNodeUa,
  nodeUa,
  detectCliVersion,
  detectFromCdp,
  detectFromPackage,
  readUaCache,
  writeUaCache,
  createOfficialUa,
};