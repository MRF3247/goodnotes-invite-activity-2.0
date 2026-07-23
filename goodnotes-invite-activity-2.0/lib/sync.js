'use strict';
// 激活数据应急导入：手动粘贴 CSV（邀请码,累计激活次数）直接覆盖写库。
// 正常流程请使用后台「数据与风控」页：导入后端两张表 → 审核 → 发布榜单。
const { getDb } = require('./db');

// 简单CSV解析：支持带引号字段，返回行数组（每行是字段数组）
function parseCsv(text) {
  const rows = [];
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { fields.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    fields.push(cur.trim());
    rows.push(fields);
  }
  return rows;
}

// 写入激活次数（[邀请码, 累计激活次数] 数组；绝对值覆盖）
function applyPairs(rows) {
  const db = getDb();
  let updated = 0; const unknown = [];
  const upd = db.prepare("UPDATE codes SET activations=?, synced_at=datetime('now','localtime') WHERE code=?");
  db.exec('BEGIN');
  try {
    for (const [code, count] of rows) {
      if (!code || code === '邀请码') continue; // 跳过表头/空行
      const n = parseInt(count, 10);
      if (Number.isNaN(n) || n < 0) continue;
      const r = upd.run(n, code);
      r.changes ? updated++ : unknown.push(code);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { updated, unknown };
}

// CSV文本入口（应急手动导入用）
function applyActivations(csvText) {
  return applyPairs(parseCsv(csvText));
}

module.exports = { parseCsv, applyPairs, applyActivations };
