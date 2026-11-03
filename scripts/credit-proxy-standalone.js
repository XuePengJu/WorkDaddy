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
const { createCreditProxy } = require(path.join(__dirname, 'credit-proxy.js'));

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

const dataDir = process.env.WBSWITCH_DATA_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'WorkDaddy');
const accountsDir = path.join(dataDir, 'accounts');
const apiTokenFile = path.join(dataDir, '.api-token');
const port = Number(process.env.WBSWITCH_CREDIT_PROXY_PORT) || 47900;

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

function main() {
  const apiToken = readApiToken();
  if (!apiToken) {
    log(`[credit-proxy] 未找到可用的本地 API token（${apiTokenFile}），启动中止`);
    process.exit(1);
  }

  const proxy = createCreditProxy({
    apiToken,
    port,
    log,
    listAccounts,
    creditCache: createAccountCreditCache(dataDir),
    currentUid,
    getToken,
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
