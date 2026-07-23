'use strict';
// 奖励配置的统一读取口：达标奖(milestones) 与 名次奖(rank_prizes)。
// 均存 settings 表（JSON 字符串），后台可自定义；前台榜单/战绩/奖励一览都从这里取，保证一处改处处一致。
const { getSetting } = require('./db');

function parseArr(key) {
  try {
    const v = JSON.parse(getSetting(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// 达标奖 → [{ score, name }]（按门槛升序）；兼容旧版 tier1/2/3 兜底
function milestones() {
  const arr = parseArr('milestones');
  if (arr.length) {
    return arr
      .map(x => ({ score: parseInt(x.count ?? x.score, 10) || 0, name: String(x.name || '').trim() }))
      .filter(x => x.score > 0 && x.name)
      .sort((a, b) => a.score - b.score);
  }
  return [1, 2, 3]
    .map(i => ({ score: parseInt(getSetting(`tier${i}_score`), 10) || 0, name: getSetting(`tier${i}_name`) }))
    .filter(t => t.score > 0);
}

// 名次奖 → [{ from, to, label, prize }]（按名次升序）
function rankPrizes() {
  return parseArr('rank_prizes')
    .map(x => ({
      from: parseInt(x.from, 10) || 0,
      to: parseInt(x.to, 10) || 0,
      label: String(x.label || '').trim(),
      prize: String(x.prize ?? x.name ?? '').trim()
    }))
    .filter(x => x.from > 0 && x.to >= x.from && x.prize)
    .sort((a, b) => a.from - b.from);
}

// 给定名次，返回对应名次奖（label+prize），无则 null
function prizeForRank(rank, list) {
  const arr = list || rankPrizes();
  const hit = arr.find(x => rank >= x.from && rank <= x.to);
  return hit ? { label: hit.label, prize: hit.prize } : null;
}

module.exports = { milestones, rankPrizes, prizeForRank };
