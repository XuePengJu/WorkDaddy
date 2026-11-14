'use strict';

/**
 * 积分轮换代理的独立启动器（不依赖 daemon、不改安装包）。
 *
 * 为什么独立：安装包里的 daemon 与仓库工作副本存在版本落差，
 * 把代理挂进 daemon 就需要整体部署，会把仓库里其它未发布改动一起带上线。
 * 这个启动器只做三件事：读账号、读积分缓存、起代理，全程只读，不写任何账号文件。
 *
 * 账号 token 由既有 daemon 负责刷新，本进程每次请求都重新读盘，所以能拿到最新 token。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require(path.join(__dirname, 'lib.js'));
const { createAccountCreditCache } = require(path.join(__dirname, 'account-credit-cache.js'));
const { createUsageStore } = require(path.join(__dirname, 'proxy-usage.js'));
const { createCreditProxy, DEFAULT_PORT } = require(path.join(__dirname, 'credit-proxy.js'));

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

const dataDir = process.env.WBSWITCH_DATA_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'WorkDaddy');
const accountsDir = path.join(dataDir, 'accounts');
const apiTokenFile = path.join(dataDir, '.api-token');
const port = Number(process.env.WBSWITCH_CREDIT_PROXY_PORT) || 47900;
// 用户在面板里主动终止网关后留下的标记。判断放在代理自己的入口，
// 这样 daemon 看门狗、app 启动器（编译好的二进制）、手动执行，都拦得住。
const disabledFile = path.join(dataDir, 'credit-proxy.disabled');

function isDisabled() {
  try {
    return fs.existsSync(disabledFile);
  } catch (_) {
    return false;
  }
}

function markDisabled() {
  try {
    fs.writeFileSync(disabledFile, `${new Date().toISOString()}\n`);
    return true;
  } catch (error) {
    log(`[credit-proxy] 写禁用标记失败: ${error && error.message}`);
    return false;
  }
}

function readApiToken() {
  try {
    const token = fs.readFileSync(apiTokenFile, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(token)) return token;
  } catch (_) {}
  return '';
}

function profileOf() {
  try {
    const { getProfile } = require(path.join(__dirname, 'profiles.js'));
    return getProfile(process.env.WBSWITCH_PROFILE || 'workbuddy-cn');
  } catch (_) {
    return {};
  }
}

function decryptFile(file) {
  return lib.wdCompatDecryptAuthJson(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** 当前登录账号：只用于把它排在候选队列最后（兜底），不参与优先消耗。 */
function currentUid() {
  const candidates = [];
  if (process.env.WBSWITCH_AUTH_FILE) candidates.push(process.env.WBSWITCH_AUTH_FILE);
  const profile = profileOf();
  if (profile && profile.authFile) candidates.push(profile.authFile);
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const root = decryptFile(file);
      const account = root.account || (Array.isArray(root.accounts) && root.accounts[0]);
      if (account && account.uid) return String(account.uid);
    } catch (_) {}
  }
  return '';
}

/** 取某个备份账号的明文字节 token；每次都重新读盘，保证跟随 daemon 的刷新结果。 */
async function getToken(uid) {
  const target = String(uid || '');
  let files = [];
  try {
    files = fs.readdirSync(accountsDir).filter((name) => name.endsWith('.info') && !name.endsWith('.tmp'));
  } catch (_) {
    return '';
  }
  const exact = files.find((name) => name === `${target}.info`);
  const matched = exact || files.find((name) => name.startsWith(target.slice(0, 8)));
  if (!matched) return '';
  const root = decryptFile(path.join(accountsDir, matched));
  return lib.wdCompatAuthToken(root.auth || '');
}

function listAccounts() {
  try {
    return lib.listAccounts(dataDir) || [];
  } catch (error) {
    log(`[credit-proxy] 读取账号列表失败: ${error.message}`);
    return [];
  }
}

/**
 * 本代理能转发的模型清单：models.json 里 url 指向本机网关端口的那些。
 * 必须按 url 过滤——同一份 models.json 里也可能存在直连第三方 API 的模型，
 * 把它们算进「经网关可用」会误导看板。
 * 端口同时接受「当前监听端口」和「默认端口」：配置里写的是 47900，
 * 换端口跑（含隔离测试实例）时不该因此把全部配置过滤成空列表。
 */
function listModelConfigs() {
  try {
    const file = lib.workbuddyModelsFile();
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) return [];
    const selfPorts = new Set([String(port), String(DEFAULT_PORT)]);
    return rows
      .filter((row) => {
        if (!row || !row.id) return false;
        let parsed;
        try {
          parsed = new URL(String(row.url || ''));
        } catch (_) {
          return false;
        }
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false;
        const targetPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
        return selfPorts.has(String(targetPort));
      })
      .map((row) => ({ id: String(row.id), name: String(row.name || row.id) }));
  } catch (error) {
    log(`[credit-proxy] 读取模型配置失败: ${error && error.message}`);
    return [];
  }
}

function main() {
  if (isDisabled()) {
    log(`[credit-proxy] 已被用户终止（${disabledFile} 存在），本次不启动`);
    process.exit(0);
  }

  const apiToken = readApiToken();
  if (!apiToken) {
    log(`[credit-proxy] 未找到可用的本地 API token（${apiTokenFile}），启动中止`);
    process.exit(1);
  }

  const usageStore = createUsageStore(dataDir);
  const purged = usageStore.cleanup();
  if (purged) log(`[credit-proxy] 清理过期用量记录 ${purged} 个文件`);

  const proxy = createCreditProxy({
    apiToken,
    port,
    log,
    listAccounts,
    creditCache: createAccountCreditCache(dataDir),
    currentUid,
    getToken,
    usageStore,
    disable: markDisabled,
    listModelConfigs,
  });

  proxy.start().then(
    (info) => log(`[credit-proxy] 就绪: http://127.0.0.1:${info.port}（数据目录 ${dataDir}）`),
    (error) => {
      log(`[credit-proxy] 启动失败: ${error && error.message}`);
      process.exit(1);
    },
  );

  const shutdown = (signal) => {
    log(`[credit-proxy] 收到 ${signal}，正在退出`);
    proxy.stop().then(() => process.exit(0), () => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
