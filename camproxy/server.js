'use strict';
/*
  Сервер трансляций «Титан» для Trassir.
  Работает на компьютере в сети арены: сам входит в Trassir, берёт живое видео камер (HLS)
  и отдаёт его приложению. Логин и пароль Trassir остаются только здесь, в config.json.
  Один поток с Trassir раздаётся сразу всем родителям (кусочки видео кэшируются на минуту).
  Без внешних библиотек: нужен только Node.js 18 или новее.  Запуск: node server.js
*/
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CFG_FILE = process.env.TITAN_CAM_CONFIG || path.join(__dirname, 'config.json');
const fileCfg = fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) : {};
const cfg = {
  trassir: process.env.TRASSIR_URL || fileCfg.trassir || 'https://127.0.0.1:8080',
  user: process.env.TRASSIR_USER || fileCfg.user || '',
  password: process.env.TRASSIR_PASSWORD || fileCfg.password || '',
  viewKey: process.env.VIEW_KEY || fileCfg.viewKey || '',
  port: +(process.env.PORT || fileCfg.port || 8090),
  cams: fileCfg.cams || [],           // [{id:'GUID', name:'Лёд, общий план'}]; пусто — все камеры пользователя
  hours: process.env.HOURS || fileCfg.hours || '', // '06:30-23:00' — в остальное время видео не отдаётся
  insecure: fileCfg.insecure !== false, // у Trassir обычно самоподписанный сертификат
};
if (!cfg.user || !cfg.password) { console.error('Заполните user и password в config.json (пользователь Trassir с правом просмотра камер)'); process.exit(1); }
if (!cfg.viewKey || cfg.viewKey.length < 12) { console.error('Задайте viewKey в config.json: длинная случайная строка, не короче 12 символов'); process.exit(1); }

const UP = new URL(cfg.trassir);
const agent = new (UP.protocol === 'https:' ? https : http).Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: !cfg.insecure });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function upstream(pathAndQuery, timeout = 10000) {
  const u = new URL(pathAndQuery, UP);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(u, { agent, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
// Trassir иногда дописывает к JSON комментарии /* ... */
const tjson = buf => JSON.parse(buf.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '').trim() || '{}');

/* ---------- сессия Trassir ---------- */
let sid = null, sidAt = 0, loginP = null;
async function login() {
  if (loginP) return loginP;
  loginP = (async () => {
    const r = await upstream(`/login?username=${encodeURIComponent(cfg.user)}&password=${encodeURIComponent(cfg.password)}`);
    const j = tjson(r.body);
    if (!j.sid) throw new Error('Trassir не пустил: проверьте пользователя, пароль и что SDK включён (' + r.status + ')');
    sid = j.sid; sidAt = Date.now(); log('вошли в Trassir');
    return sid;
  })().finally(() => { loginP = null; });
  return loginP;
}
async function api(pathNoSid) { // запрос к Trassir с повторным входом, если сессия истекла
  for (let i = 0; i < 2; i++) {
    if (!sid || i > 0) await login();
    const r = await upstream(pathNoSid + (pathNoSid.includes('?') ? '&' : '?') + 'sid=' + encodeURIComponent(sid));
    let j = null; try { j = tjson(r.body); } catch (e) { }
    if (r.status === 200 && j && !(j.success === 0 || j.error_code)) return j;
    sid = null;
    if (i) throw new Error('Trassir ответил ошибкой: ' + r.status + ' ' + r.body.toString('utf8').slice(0, 200));
  }
}

/* ---------- список камер ---------- */
let camsCache = null, camsAt = 0;
async function cams() {
  if (cfg.cams.length) return cfg.cams.map(c => ({ id: String(c.id), name: c.name || String(c.id) }));
  if (camsCache && Date.now() - camsAt < 60000) return camsCache;
  const j = await api('/channels');
  camsCache = (j.channels || []).map(c => ({ id: String(c.guid), name: c.name || String(c.guid) }));
  camsAt = Date.now();
  return camsCache;
}

/* ---------- токены видео: один на камеру и качество, Trassir держит его ~10 секунд без запросов ---------- */
const tokens = new Map(); // `${ch}|${q}` -> {token, used}
async function token(ch, q, fresh) {
  const k = ch + '|' + q, t = tokens.get(k);
  if (t && !fresh && Date.now() - t.used < 8000) { t.used = Date.now(); return t.token; }
  const j = await api(`/get_video?channel=${encodeURIComponent(ch)}&container=hls&stream=${q}`);
  if (!j.token) throw new Error('Trassir не выдал видео для камеры ' + ch);
  tokens.set(k, { token: j.token, used: Date.now() });
  return j.token;
}

/* ---------- кэш: один запрос в Trassir на всех зрителей ---------- */
const cache = new Map(), inflight = new Map();
function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttl) return Promise.resolve(c.v);
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().then(v => {
    cache.set(key, { v, at: Date.now() });
    if (cache.size > 400) { const old = Date.now() - 60000; for (const [kk, vv] of cache) if (vv.at < old) cache.delete(kk); }
    return v;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ---------- перепись плейлиста: все ссылки ведут через этот сервер ---------- */
const b64 = s => Buffer.from(s).toString('base64url');
function rewrite(text, baseUrl) {
  const map = ref => {
    const abs = new URL(ref, baseUrl);
    if (abs.origin !== UP.origin) return ref;
    return '/seg/' + b64(abs.pathname + abs.search) + '?k=' + encodeURIComponent(cfg.viewKey);
  };
  return text.split(/\r?\n/).map(line => {
    const l = line.trim();
    if (!l) return line;
    if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${map(u)}"`);
    return map(l);
  }).join('\n');
}
async function playlist(upPath) {
  const r = await upstream(upPath);
  if (r.status !== 200) { const e = new Error('upstream ' + r.status); e.status = r.status; throw e; }
  return Buffer.from(rewrite(r.body.toString('utf8'), new URL(upPath, UP)));
}

/* ---------- доступ ---------- */
function keyOk(k) {
  const a = Buffer.from(String(k || '')), b = Buffer.from(cfg.viewKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function openNow() {
  if (!cfg.hours) return true;
  const m = cfg.hours.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return true;
  const d = new Date(), now = d.getHours() * 60 + d.getMinutes();
  return now >= +m[1] * 60 + +m[2] && now <= +m[3] * 60 + +m[4];
}

function send(res, code, body, type, extra) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...(extra || {}) });
  res.end(body);
}
const M3U8 = 'application/vnd.apple.mpegurl';

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '', undefined, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' });
  if (req.method !== 'GET') return send(res, 405, 'method');
  if (u.pathname === '/health') return send(res, 200, 'ok');
  if (!keyOk(u.searchParams.get('k'))) return send(res, 401, 'Неверный ключ доступа');
  try {
    if (u.pathname === '/api/cams') {
      return send(res, 200, JSON.stringify({ cams: await cams(), open: openNow(), hours: cfg.hours || null }), 'application/json; charset=utf-8');
    }
    let m = u.pathname.match(/^\/live\/([^/]+)\/index\.m3u8$/);
    if (m) {
      if (!openNow()) return send(res, 403, 'Трансляции сейчас закрыты');
      const ch = decodeURIComponent(m[1]), q = u.searchParams.get('q') === 'sub' ? 'sub' : 'main';
      if (!(await cams()).some(c => c.id === ch)) return send(res, 404, 'Нет такой камеры');
      const body = await cached('live|' + ch + '|' + q, 1000, async () => {
        try { return await playlist(`/hls/${await token(ch, q)}/master.m3u8`); }
        catch (e) { return await playlist(`/hls/${await token(ch, q, true)}/master.m3u8`); } // токен истёк — берём новый
      });
      return send(res, 200, body, M3U8);
    }
    m = u.pathname.match(/^\/seg\/([A-Za-z0-9_-]+)$/);
    if (m) {
      if (!openNow()) return send(res, 403, 'Трансляции сейчас закрыты');
      const upPath = Buffer.from(m[1], 'base64url').toString('utf8');
      if (!upPath.startsWith('/hls/') || upPath.includes('..')) return send(res, 400, 'bad path');
      const isList = /\.m3u8$/i.test(new URL(upPath, UP).pathname);
      if (isList) return send(res, 200, await cached('pl|' + upPath, 1000, () => playlist(upPath)), M3U8);
      const seg = await cached('seg|' + upPath, 60000, async () => {
        const r = await upstream(upPath, 20000);
        if (r.status !== 200) { const e = new Error('upstream ' + r.status); e.status = r.status; throw e; }
        return r;
      });
      return send(res, 200, seg.body, seg.type || 'video/mp2t', { 'Cache-Control': 'public, max-age=60' });
    }
    send(res, 404, 'not found');
  } catch (e) {
    log('ошибка', req.url.replace(/k=[^&]+/, 'k=***'), e.message);
    send(res, e.status === 404 ? 404 : 502, 'Камера сейчас не отвечает');
  }
}).listen(cfg.port, () => {
  log(`сервер трансляций запущен: http://localhost:${cfg.port}  (Trassir: ${UP.origin})`);
  login().then(cams).then(c => log('камеры:', c.map(x => `${x.name} [${x.id}]`).join(', ') || 'нет'))
    .catch(e => log('не удалось подключиться к Trassir:', e.message));
});
