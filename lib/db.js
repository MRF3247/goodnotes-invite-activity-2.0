'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let db = null;

// 可在后台修改的运行时配置，全部存数据库 settings 表
const DEFAULT_SETTINGS = {
  capacity: '9999',                 // 参与人数上限
  activity_status: 'auto',           // 活动阶段：auto=按 activity_start/end 北京时间自动判断；也可手动强制 notstarted/running/ended 兜底
  snapshot_time: '00:00',           // 每日兜底刷新榜单时间 HH:MM（北京时间）
  fail_threshold: '0',              // 连续失败多少次触发锁定（0=不限制）
  lock_steps: '15,60,180',          // 阶梯锁定时长（分钟），逐级递进
  query_limit_hour: '0',            // 查询成功：每UID每小时次数（0=不限制）
  ip_limit_hour: '0',               // 每IP每小时请求总闸（0=不限制）
  // 达标奖（拉N人得N月）—— 后台可自定义、可增删档位；leaderboard/战绩/奖励一览均读它
  milestones: JSON.stringify([
    { count: 2,  name: '2 个月会员' },
    { count: 3,  name: '3 个月会员' },
    { count: 6,  name: '6 个月会员' },
    { count: 9,  name: '9 个月会员' },
    { count: 12, name: '12 个月会员（一整年）' }
  ]),
  // 名次奖（按最终排名）—— 后台可自定义上架；排行榜右侧按名次展示
  rank_prizes: JSON.stringify([
    { from: 1, to: 1,  label: '🏆 冠军', prize: '3000 元愿望金' },
    { from: 2, to: 2,  label: '🥈 亚军', prize: '2000 元愿望金' },
    { from: 3, to: 3,  label: '🥉 季军', prize: '1000 元愿望金' },
    { from: 4, to: 10, label: '🎁 十强奖', prize: '200 元京东卡' }
  ]),
  // —— 旧版三档（保留作兜底，milestones 存在时不再使用） ——
  tier1_score: '5',  tier1_name: '🌱 萌芽奖·3个月会员',
  tier2_score: '10', tier2_name: '🌿 种草奖·6个月会员',
  tier3_score: '15', tier3_name: '🌳 成林奖·12个月会员',
  shadow_enabled: '1',              // 激励号自动配分开关
  shadow_rank_lo: '1',              // 激励号目标名次区间（含）
  shadow_rank_hi: '4',
  hero_title: '「Goodnotes极速版」推荐计划 第二期',  // 前台主标题（后台可改）
  hero_slogan: '成为推荐官，你的愿望我买单！',          // 前台标语（后台可改）
  update_note: '每小时更新',        // 页面上展示给用户的更新频率文案
  risk_device_min: '2',             // 风控预警：同一设备下参与兑换的UID数 ≥ 此值即列入报告（0=不预警）
  risk_ip_min: '5',                 // 风控预警：同一IP下参与兑换的UID数 ≥ 此值即列入报告（0=不预警）
  // —— 2.0 新增：接口拉取与错峰发布 ——
  sync_batch_ids: '',               // 本次活动的 batchId，多个用逗号分隔
  sync_interval_min: '60',          // 拉取频率（分钟）
  publish_delay_min: '30',          // 拉取后延迟多少分钟再更新到前台（错峰，给运营反应时间）
  activity_start: '',               // 活动开始时间（北京时间 YYYY-MM-DD HH:MM，留空=不用时间控制、纯手动）
  activity_end: ''                  // 活动结束时间（北京时间 YYYY-MM-DD HH:MM，留空=不用时间控制）
};

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'data.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE NOT NULL,
      xhs_id TEXT,
      nickname TEXT,
      code TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY,
      batch_id TEXT,
      valid_from TEXT,
      valid_to TEXT,
      assigned_to INTEGER,
      assigned_at TEXT,
      activations INTEGER NOT NULL DEFAULT 0,
      pending INTEGER,
      manual_delta INTEGER NOT NULL DEFAULT 0,
      max_redemptions INTEGER,
      synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_codes_batch ON codes(batch_id);
    CREATE TABLE IF NOT EXISTS shadows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT UNIQUE NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      auto INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snap_date TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      score INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_snap_date ON snapshots(snap_date);
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- 兑换明细：由接口②拉取，每笔兑换一行（含 IP/设备/时间），供风控预警与地区分布
    CREATE TABLE IF NOT EXISTS redemptions (
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      redeemed_at INTEGER,
      PRIMARY KEY (code, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_red_code ON redemptions(code);
    CREATE INDEX IF NOT EXISTS idx_red_user ON redemptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_red_ip ON redemptions(ip);
    CREATE INDEX IF NOT EXISTS idx_red_device ON redemptions(device);
    CREATE TABLE IF NOT EXISTS excluded_users (
      user_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    -- 软删除回收站：账号删除 / 邀请码清除，5天内可恢复，之后由调度器彻底清除
    CREATE TABLE IF NOT EXISTS deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,               -- 'account'（删账号）| 'code'（清除账号的邀请码）
      participant_id INTEGER,
      label TEXT NOT NULL DEFAULT '',    -- 展示用（uid / 邀请码）
      payload TEXT NOT NULL DEFAULT '{}',-- 恢复所需的原始数据（JSON）
      deleted_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
  // —— 轻量迁移：老库补列（IF NOT EXISTS 不会给已存在的表加列，故手动补） ——
  ensureColumn('shadows', 'code', 'TEXT');      // 激励号占用的真实邀请码（从码池分配，展示在公开榜）
  ensureColumn('snapshots', 'code', 'TEXT');    // 快照时冻结每行展示的邀请码
  ensureColumn('codes', 'shadow_id', 'INTEGER'); // 该码被哪个激励号占用（非空=激励号占用，不参与真实分配/CC同步）
  relaxParticipantsConstraints();               // 老库：放开 xhs_id/nickname 的 NOT NULL/UNIQUE（本期只收 UID）
  // 中奖信息（中奖后由中奖者在领奖页填写；xhs_id 复用已有列）
  ensureColumn('participants', 'recipient_name', 'TEXT');
  ensureColumn('participants', 'phone', 'TEXT');
  ensureColumn('participants', 'address', 'TEXT');
  ensureColumn('participants', 'prize_info_at', 'TEXT');
  ensureColumn('participants', 'deleted_at', 'TEXT'); // 软删除时间（非空=已删，回收站可恢复）
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

// 若表缺少某列则补上（用于老数据库平滑升级）
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// 老库 participants 表原本 xhs_id/nickname 是 NOT NULL + UNIQUE；本期只收 UID，需放开。
// SQLite 不能直接改列约束，检测到旧约束则重建表并迁移数据。
function relaxParticipantsConstraints() {
  const cols = db.prepare('PRAGMA table_info(participants)').all();
  const xhs = cols.find(c => c.name === 'xhs_id');
  if (!xhs || xhs.notnull === 0) return; // 已是新结构
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE participants_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE NOT NULL,
        xhs_id TEXT,
        nickname TEXT,
        code TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO participants_new(id,uid,xhs_id,nickname,code,status,note,created_at)
        SELECT id,uid,xhs_id,nickname,code,status,note,created_at FROM participants;
      DROP TABLE participants;
      ALTER TABLE participants_new RENAME TO participants;
    `);
    db.exec('COMMIT');
    log('migrate', 'participants 表已放开 xhs_id/nickname 约束（本期只收 UID）');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getDb() { return db; }

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : (DEFAULT_SETTINGS[key] ?? '');
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function allSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key,value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function log(action, detail) {
  db.prepare('INSERT INTO logs(action,detail) VALUES(?,?)').run(action, detail || '');
}

// 已报名人数（用于名额上限）：本期已登记、未删除、未取消资格的账号数（与是否已发码无关）
function claimedCount() {
  return db.prepare("SELECT COUNT(*) c FROM participants WHERE status='active' AND deleted_at IS NULL").get().c;
}

module.exports = { init, getDb, getSetting, setSetting, allSettings, log, claimedCount };
