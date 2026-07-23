'use strict';
// 每日榜单快照：真实用户积分 = 激活次数 + 人工修正；含激励号自动配分
// 2.0：每小时从后端接口拉取写入 codes.pending（待发布），错峰延迟后 publish 到 codes.activations（前台）。
const { getDb, getSetting, setSetting, log } = require('./db');
const { todayStr, nowHM, nowStr } = require('./util');
const { pullBatches } = require('./apiPull');
const { activityPhase } = require('./phase');

function batchIdList() {
  return (getSetting('sync_batch_ids') || '').split(/[\s,，]+/).map(s => s.trim()).filter(Boolean);
}

function realScores() {
  const db = getDb();
  return db.prepare(`
    SELECT p.id, p.nickname, p.created_at, p.code, c.assigned_at,
           (c.activations + c.manual_delta) AS score
    FROM participants p JOIN codes c ON c.assigned_to = p.id
    WHERE p.status = 'active' AND p.deleted_at IS NULL AND p.code IS NOT NULL
  `).all();
}

// 按报名顺序发放邀请码：仅活动进行中执行，给已报名但还没码的账号从码池依次分配。
function assignPendingCodes() {
  if (activityPhase() !== 'running') return 0;
  const db = getDb();
  const codeless = db.prepare("SELECT id FROM participants WHERE status='active' AND deleted_at IS NULL AND code IS NULL ORDER BY id").all();
  if (!codeless.length) return 0;
  const today = todayStr();
  const pick = db.prepare(`
    SELECT code FROM codes WHERE assigned_to IS NULL AND shadow_id IS NULL
      AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)
    ORDER BY rowid LIMIT 1`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of codeless) {
      const c = pick.get(today, today);
      if (!c) break; // 码池已空
      db.prepare('UPDATE participants SET code=? WHERE id=?').run(c.code, p.id);
      db.prepare("UPDATE codes SET assigned_to=?, assigned_at=datetime('now','localtime') WHERE code=?").run(p.id, c.code);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (n) log('assign_codes', `按报名顺序发放邀请码 ${n} 个`);
  return n;
}

// 彻底清除超过5天的软删除记录（回收站到期）
function purgeDeletions() {
  const db = getDb();
  const old = db.prepare("SELECT id, kind, participant_id, label FROM deletions WHERE deleted_at <= datetime('now','localtime','-5 days')").all();
  for (const d of old) {
    if (d.kind === 'account' && d.participant_id) {
      const pc = db.prepare('SELECT code FROM participants WHERE id=?').get(d.participant_id);
      if (pc && pc.code) db.prepare("UPDATE codes SET assigned_to=NULL, activations=0, manual_delta=0, pending=NULL WHERE code=?").run(pc.code);
      db.prepare('DELETE FROM participants WHERE id=?').run(d.participant_id);
    } else if (d.kind === 'code' && d.label) {
      db.prepare("UPDATE codes SET assigned_to=NULL WHERE code=?").run(d.label); // 被暂扣的码彻底放回码池
    }
    db.prepare('DELETE FROM deletions WHERE id=?').run(d.id);
  }
  if (old.length) log('purge', `彻底清除 ${old.length} 条超期(>5天)删除记录`);
  return old.length;
}

// 从码池分配一个真实邀请码给激励号：占用后该码退出真实分配池、且不走 CC 同步（激活数由排行榜算法/人工决定）。
// 成功返回码字符串，池中无可用码返回 null。调用方需自行处理事务边界。
function assignCodeForShadow(shadowId) {
  const db = getDb();
  const today = todayStr();
  const row = db.prepare(`
    SELECT code FROM codes
    WHERE assigned_to IS NULL AND shadow_id IS NULL
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_to IS NULL OR valid_to >= ?)
    ORDER BY rowid LIMIT 1
  `).get(today, today);
  if (!row) return null;
  db.prepare('UPDATE codes SET shadow_id = ? WHERE code = ?').run(shadowId, row.code);
  db.prepare('UPDATE shadows SET code = ? WHERE id = ?').run(row.code, shadowId);
  return row.code;
}

// 兜底：给历史/导入时未分配到真实码的激励号补一个真实码（码池不足则留空并告警）
function ensureShadowCodes() {
  const db = getDb();
  const rows = db.prepare("SELECT id, nickname FROM shadows WHERE code IS NULL OR code = ''").all();
  for (const r of rows) {
    const code = assignCodeForShadow(r.id);
    if (!code) { log('shadow_code_warn', `激励号「${r.nickname}」暂无可用邀请码可占用（码池不足），本轮展示为空`); break; }
  }
}

// 激励号自动配分：目标名次落在 [rank_lo, rank_hi] 区间内
function autoTuneShadows(sortedRealScores) {
  const db = getDb();
  if (getSetting('shadow_enabled') !== '1') return;
  const autoShadows = db.prepare('SELECT id, score FROM shadows WHERE auto = 1').all();
  if (!autoShadows.length || !sortedRealScores.length) return;

  const lo = Math.max(1, parseInt(getSetting('shadow_rank_lo'), 10) || 1);
  const hi = Math.max(lo, parseInt(getSetting('shadow_rank_hi'), 10) || 4);
  const top = sortedRealScores.slice(0, hi).map(r => r.score);
  const first = top[0] ?? 0;
  // 下限需严格高于目标区间末位的分数，否则同分会因领码时间排到区间之外
  const floor = (top[Math.min(hi, top.length) - 1] ?? 0) + 1;
  const ceil = Math.max(lo === 1 ? first + 1 : first, floor); // 区间含第1名时可微超第一名

  const upd = db.prepare('UPDATE shadows SET score = ? WHERE id = ?');
  for (const s of autoShadows) {
    const target = floor + Math.floor(Math.random() * (ceil - floor + 1));
    // 积分只涨不跌：自动配分永不低于当前分（人工在后台仍可直接改低）
    const score = Math.max(Math.round(s.score), Math.round(target));
    upd.run(score, s.id);
    if (score !== s.score) log('shadow_auto', `激励号#${s.id} 自动配分 ${s.score} → ${score}（目标区间 ${floor}-${ceil}）`);
  }
}

function runSnapshot(dateStr) {
  const db = getDb();
  const snapDate = dateStr || todayStr();
  const real = realScores().sort((a, b) => b.score - a.score || (a.assigned_at < b.assigned_at ? -1 : 1));
  autoTuneShadows(real);
  ensureShadowCodes();
  const shadows = db.prepare('SELECT id, nickname, score, code, created_at FROM shadows').all();

  const entries = [
    // 本期报名只收 UID、无昵称；snapshots.nickname 非空，用邀请码兜底（公开榜也只展示邀请码）
    ...real.map(r => ({ type: 'p', ref: r.id, nickname: r.nickname || r.code || ('#' + r.id), score: r.score, code: r.code, tie: r.assigned_at })),
    ...shadows.map(s => ({ type: 's', ref: s.id, nickname: s.nickname, score: s.score, code: s.code, tie: s.created_at }))
  ].sort((a, b) => b.score - a.score || (a.tie < b.tie ? -1 : 1));

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM snapshots WHERE snap_date = ?').run(snapDate);
    const ins = db.prepare('INSERT INTO snapshots(snap_date, entry_type, ref_id, nickname, score, rank, code) VALUES(?,?,?,?,?,?,?)');
    entries.forEach((e, i) => ins.run(snapDate, e.type, e.ref, e.nickname, e.score, i + 1, e.code || null));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  setSetting('last_snapshot_at', nowStr());
  log('snapshot', `生成 ${snapDate} 榜单快照，共 ${entries.length} 条`);
  return entries.length;
}

function latestSnapshotDate() {
  const row = getDb().prepare('SELECT snap_date FROM snapshots ORDER BY snap_date DESC LIMIT 1').get();
  return row ? row.snap_date : null;
}

// 拉取一次：接口①②写入 codes.pending 与明细表；并安排"错峰发布"时间。
async function pullNow(config, { withDetail = true } = {}) {
  const ids = batchIdList();
  if (!ids.length) return { ok: false, msg: '未配置 batchId（活动设置里填）' };
  const r = await pullBatches(config, ids, { withDetail });
  setSetting('last_pull_at', nowStr());
  setSetting('last_pull_ts', String(Date.now()));
  // 安排 publish_delay_min 分钟后发布到前台（错峰，给运营反应时间）
  const delayMin = Math.max(0, parseInt(getSetting('publish_delay_min'), 10) || 0);
  setSetting('pending_ready_ts', String(Date.now() + delayMin * 60000));
  const total = r.batches.reduce((s, b) => s + (b.totalRedemptions || 0), 0);
  log('api_pull', `拉取 ${ids.length} 个批次，兑换合计 ${total}` + (r.errors.length ? `；${r.errors.length} 处告警` : '') + `；将于 ${delayMin} 分钟后发布`);
  return r;
}

// CC（飞书+Claude Code）每小时把风控清洗后的“码→净邀请人数”推进来：
// 写入 codes.pending（只更新已存在的码；未提及的码保留原值，不清零），并安排错峰发布。
// 返回 { updated, skipped }：skipped=推来的码在码池里不存在（多为激励号假码或输错）。
function ingestScores(scoreMap) {
  const db = getDb();
  // 激励号占用的码(shadow_id 非空)不接受 CC 同步：其激活数由排行榜算法/人工决定
  const upd = db.prepare('UPDATE codes SET pending = ? WHERE code = ? AND shadow_id IS NULL');
  let updated = 0;
  const skipped = [];
  db.exec('BEGIN');
  try {
    for (const [code, n] of Object.entries(scoreMap)) {
      const val = Math.max(0, Math.round(Number(n) || 0));
      const r = upd.run(val, String(code).trim());
      if (r.changes > 0) updated += 1; else skipped.push(code);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  setSetting('last_ingest_at', nowStr());
  const delayMin = Math.max(0, parseInt(getSetting('publish_delay_min'), 10) || 0);
  setSetting('pending_ready_ts', String(Date.now() + delayMin * 60000));
  log('ingest', `CC 推入 ${updated} 个码的净人数` + (skipped.length ? `；${skipped.length} 个码不存在（已忽略）` : '') + `；将于 ${delayMin} 分钟后发布`);
  return { updated, skipped };
}

// 发布：把待发布(pending)落到正式分数(activations)，manual_delta 保留（人工扣分不被覆盖），再生成前台榜单。
function publishPending() {
  const db = getDb();
  const n = db.prepare('UPDATE codes SET activations = COALESCE(pending, activations), synced_at = ? WHERE pending IS NOT NULL').run(nowStr()).changes;
  setSetting('last_publish_at', nowStr());
  setSetting('pending_ready_ts', '');
  const count = runSnapshot();
  log('publish', `发布到前台：更新 ${n} 个码的分数，榜单 ${count} 条`);
  return { updated: n, snapshotCount: count };
}

// 调度：每分钟 tick。① 到点拉取（间隔 sync_interval_min）→ 写 pending；② 到 pending_ready_ts → 发布到前台。
let pulling = false;
function startScheduler(config) {
  const tick = async () => {
    try {
      // ① 定时拉取
      const ids = batchIdList();
      if (ids.length && !pulling) {
        const intervalMs = Math.max(1, parseInt(getSetting('sync_interval_min'), 10) || 60) * 60000;
        const lastTs = parseInt(getSetting('last_pull_ts'), 10) || 0;
        if (Date.now() - lastTs >= intervalMs) {
          pulling = true;
          try { await pullNow(config, { withDetail: true }); }
          catch (e) { log('api_pull_fail', e.message); }
          finally { pulling = false; }
        }
      }
      // ② 错峰发布
      const readyTs = parseInt(getSetting('pending_ready_ts'), 10) || 0;
      if (readyTs && Date.now() >= readyTs) publishPending();
      // ③ 活动进行中：按报名顺序给还没码的账号发码
      assignPendingCodes();
      // ④ 每日兜底刷新 + 清理超期删除
      const today = todayStr();
      if (nowHM() >= (getSetting('snapshot_time') || '00:00') && getSetting('snapshot_done_date') !== today) {
        runSnapshot(today);
        purgeDeletions();
        setSetting('snapshot_done_date', today);
      }
    } catch (e) {
      console.error('[scheduler]', e);
    }
  };
  tick();
  setInterval(tick, 60 * 1000).unref();
}

module.exports = { runSnapshot, latestSnapshotDate, startScheduler, pullNow, publishPending, ingestScores, assignCodeForShadow, assignPendingCodes, purgeDeletions };
