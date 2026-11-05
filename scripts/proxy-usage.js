'use strict';
/**
 * 代理用量记录：每次请求落一行 JSON，按本地自然日分文件。
 *
 * 只存转发结果里的公开计量字段（token、积分、耗时、模型名、账号短 id），
 * 不存任何请求内容、token 或账户凭证。
 */

const fs = require('node:fs');
const path = require('node:path');

const KEEP_DAYS = 30;
const FILE_RE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 本地时区自然日，形如 2026-11-05。跨天按本机时间切，与用户认知一致。 */
function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function createUsageStore(dataDir) {
  const dir = path.join(dataDir, 'usage');

  function fileOf(key) {
    return path.join(dir, `usage-${key}.jsonl`);
  }

  function record(entry) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(fileOf(dayKey()), `${JSON.stringify(entry)}\n`);
      return true;
    } catch (_) {
      // 看板是旁路功能，写盘失败不能影响转发。
      return false;
    }
  }

  function readDay(key) {
    let text = '';
    try {
      text = fs.readFileSync(fileOf(key), 'utf8');
    } catch (_) {
      return [];
    }
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (_) { /* 半行写入时跳过，不整体丢弃 */ }
    }
    return rows;
  }

  function lastDays(days) {
    const out = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i -= 1) {
      out.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    }
    return out;
  }

  function summarize(rows) {
    const agg = { requests: 0, failed: 0, prompt: 0, completion: 0, reasoning: 0, credit: 0, ms: 0, genMs: 0, genTokens: 0, prefillMs: 0, prefillTokens: 0 };
    for (const row of rows) {
      agg.requests += 1;
      if (row.ok === 0) {
        agg.failed += 1;
        continue;
      }
      agg.prompt += Number(row.pt) || 0;
      agg.completion += Number(row.ct) || 0;
      agg.reasoning += Number(row.rt) || 0;
      agg.credit += Number(row.cr) || 0;
      agg.ms += Number(row.ms) || 0;
      // 只有带首字计时的新记录才能拆出「生成窗口」，旧记录不参与速度聚合，
      // 否则会把 prefill 时间算进生成耗时，把平均速度拉低到失真。
      const ft = Number(row.ft) || 0;
      const total = Number(row.ms) || 0;
      if (ft > 0 && total > ft) {
        agg.prefillMs += ft;
        // 分子必须是同一批行的输入 token，混进没有 ft 的行会把速度算成天量。
        agg.prefillTokens += Number(row.pt) || 0;
        agg.genMs += total - ft;
        agg.genTokens += Math.max(0, (Number(row.ct) || 0) - (Number(row.rt) || 0));
      }
    }
    agg.credit = Number(agg.credit.toFixed(2));
    agg.avgMs = agg.requests ? Math.round(agg.ms / Math.max(1, agg.requests - agg.failed)) : 0;
    agg.output = agg.completion - agg.reasoning;
    // tokps = 生成速度（不含等待上下文）；prefillTps = 上下文吞吐，用来解释长输入为什么慢。
    agg.tokps = agg.genMs > 0 ? Number((agg.genTokens / (agg.genMs / 1000)).toFixed(1)) : 0;
    agg.prefillTps = agg.prefillMs > 0 ? Number((agg.prefillTokens / (agg.prefillMs / 1000)).toFixed(0)) : 0;
    return agg;
  }

  function summary(days = 1) {
    const span = Math.max(1, Math.min(KEEP_DAYS, Number(days) || 1));
    const keys = lastDays(span);
    const daily = keys.map((key) => ({ date: key, ...summarize(readDay(key)) }));
    const todayRows = readDay(keys[keys.length - 1]);

    const byModel = new Map();
    const byAccount = new Map();
    for (const row of todayRows) {
      if (row.ok === 0) continue;
      const model = String(row.m || 'unknown');
      const account = String(row.u || 'unknown');
      const m = byModel.get(model) || { model, requests: 0, prompt: 0, completion: 0, credit: 0 };
      m.requests += 1;
      m.prompt += Number(row.pt) || 0;
      m.completion += Number(row.ct) || 0;
      m.credit = Number((m.credit + (Number(row.cr) || 0)).toFixed(2));
      byModel.set(model, m);
      const a = byAccount.get(account) || { account, requests: 0, credit: 0 };
      a.requests += 1;
      a.credit = Number((a.credit + (Number(row.cr) || 0)).toFixed(2));
      byAccount.set(account, a);
    }

    return {
      days: span,
      today: daily[daily.length - 1],
      daily,
      byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests),
      byAccount: [...byAccount.values()].sort((a, b) => b.requests - a.requests),
      keepDays: KEEP_DAYS,
    };
  }

  /** 最近 N 条，跨天回落：今天不够就补昨天，保证一开机也有内容。 */
  function recent(limit = 20) {
    const take = Math.max(1, Math.min(200, Number(limit) || 20));
    const keys = lastDays(2).reverse();
    const rows = [];
    for (const key of keys) {
      const dayRows = readDay(key);
      for (let i = dayRows.length - 1; i >= 0 && rows.length < take; i -= 1) rows.push(dayRows[i]);
      if (rows.length >= take) break;
    }
    return rows;
  }

  function cleanup() {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      return 0;
    }
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    let removed = 0;
    for (const name of names) {
      const matched = FILE_RE.exec(name);
      if (!matched) continue;
      const at = new Date(`${matched[1]}T00:00:00`).getTime();
      if (!Number.isFinite(at) || at >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
        removed += 1;
      } catch (_) { /* 文件被占用时下次再清 */ }
    }
    return removed;
  }

  return { record, summary, recent, cleanup, dir };
}

module.exports = { createUsageStore, dayKey, KEEP_DAYS };
