'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { replaceFileWithRetry } = require('./atomic-file-write');

// Public balance projection only; never persist an API response or auth data.
function projection(result) {
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    credits: number(result.credits),
    creditUnlimited: result.unlimited === true,
    creditSegments: (Array.isArray(result.segments) ? result.segments : []).filter(segment => segment && number(segment.remaining) !== null).map(segment => ({
      remaining: number(segment.remaining), total: number(segment.total), expiresAt: number(segment.expiresAt),
      source: typeof segment.source === 'string' ? segment.source : '',
      packageCode: typeof segment.packageCode === 'string' ? segment.packageCode : '',
    })),
  };
}
function nearestExpiry(account) {
  let nearest = Infinity;
  for (const segment of account.creditSegments || []) {
    if (segment.remaining > 0 && typeof segment.expiresAt === 'number' && Number.isFinite(segment.expiresAt)) nearest = Math.min(nearest, segment.expiresAt);
  }
  return nearest;
}
function createAccountCreditCache(dataDir) {
  const file = path.join(dataDir, 'account-credit-cache.json');
  const entries = new Map();
  // 磁盘版本的 mtime，用来判断别的进程是否改写过这个文件。
  let stamp = -1;

  function loadFromDisk() {
    try {
      // 先取 mtime 再读内容：若读出后文件又被改写，stamp 落后于实际，
      // 下一次 refresh 会再读一次，宁可多读也不漏更新。
      const { mtimeMs } = fs.statSync(file);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      entries.clear();
      for (const [uid, value] of Object.entries(parsed)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !value || typeof value !== 'object') continue;
        entries.set(uid, projection({ credits: value.credits, unlimited: value.creditUnlimited, segments: value.creditSegments }));
      }
      stamp = mtimeMs;
    } catch (_) { /* A missing or corrupt optional cache is safe to discard. */ }
  }
  loadFromDisk();

  /**
   * 跟随磁盘更新。daemon 是另一个进程，定时刷新余额后会重写这个文件；
   * 代理若只在启动时读一次，就会一直用陈旧的余额排序，直到进程重启。
   * 只有 mtime 变化时才真正重新解析，平时只是一次 stat。
   */
  function refresh() {
    try {
      if (fs.statSync(file).mtimeMs !== stamp) loadFromDisk();
    } catch (_) { /* 文件暂时不可读时保留上一次的内容 */ }
  }

  function get(uid) { return entries.has(uid) ? structuredClone(entries.get(uid)) : {}; }
  function set(uid, result) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return;
    entries.set(uid, projection(result));
    fs.mkdirSync(dataDir, { recursive: true });
    replaceFileWithRetry(file, JSON.stringify(Object.fromEntries(entries)), 0o600);
    try { stamp = fs.statSync(file).mtimeMs; } catch (_) { /* 交给下一次 refresh 对齐 */ }
  }
  function order(accounts) {
    // Capture all keys before the first request; refreshed balances cannot move
    // remaining accounts while this loop is running. Unknown expiry goes last.
    return accounts.map((account, index) => ({ account, index, expiry: nearestExpiry(get(account.uid)) }))
      .sort((a, b) => a.expiry === b.expiry ? a.index - b.index : a.expiry - b.expiry)
      .map(item => item.account);
  }
  return { get, set, order, refresh };
}
module.exports = { createAccountCreditCache };
