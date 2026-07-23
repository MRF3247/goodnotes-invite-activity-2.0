'use strict';
// 活动阶段：默认 auto（按后台北京时间自动判断），也可手动强制。public.js 与 snapshot.js 共用。
const { getSetting } = require('./db');
const { nowStr } = require('./util');

function activityPhase() {
  const s = (getSetting('activity_status') || 'auto').trim();
  if (s === 'notstarted') return 'not_started';
  if (s === 'running') return 'running';
  if (s === 'ended') return 'ended';
  // auto：按 activity_start/activity_end（北京 "YYYY-MM-DD HH:MM"）判断，字符串等宽可直接比较
  const now = nowStr().slice(0, 16);
  const start = (getSetting('activity_start') || '').trim();
  const end = (getSetting('activity_end') || '').trim();
  if (start && now < start) return 'not_started';
  if (end && now >= end) return 'ended';
  return 'running';
}

module.exports = { activityPhase };
