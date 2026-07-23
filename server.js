'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { init } = require('./lib/db');
const { startScheduler } = require('./lib/snapshot');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const ingestRoutes = require('./routes/ingest');

const BASE = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8'));
const dataDir = path.resolve(BASE, config.dataDir || './data');

init(dataDir);
publicRoutes.loadBannedWords(BASE);
startScheduler(config);

const PUBLIC_DIR = path.join(BASE, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};
// 页面路由 → 静态文件
const PAGES = {
  '/': 'index.html',
  '/leaderboard': 'index.html', // 已合并为单页 hub，旧链接/Banner 仍可用
  '/admin': 'admin.html'
};

function serveStatic(res, filePath) {
  const resolved = path.resolve(PUBLIC_DIR, filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/admin/')) {
      return await adminRoutes.handle(req, res, url, config);
    }
    if (url.pathname.startsWith('/api/ingest/')) {
      const handled = await ingestRoutes.handle(req, res, url, config);
      if (handled === false) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"msg":"接口不存在"}'); }
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const handled = await publicRoutes.handle(req, res, url, config);
      if (handled === false) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"msg":"接口不存在"}'); }
      return;
    }
    if (PAGES[url.pathname]) return serveStatic(res, PAGES[url.pathname]);
    return serveStatic(res, url.pathname.slice(1));
  } catch (e) {
    console.error(`[error] ${req.method} ${url.pathname}:`, e.message);
    if (!res.headersSent) {
      res.writeHead(e.message === 'bad json' || e.message === 'body too large' ? 400 : 500,
        { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ ok: false, msg: '服务器开小差了，请稍后再试' }));
  }
});

server.listen(config.port, () => {
  console.log(`Goodnotes极速版 邀请活动服务已启动`);
  console.log(`  登记页    http://localhost:${config.port}/`);
  console.log(`  排行榜    http://localhost:${config.port}/leaderboard`);
  console.log(`  后台      http://localhost:${config.port}/admin`);
  console.log(`  数据目录  ${dataDir}`);
});
