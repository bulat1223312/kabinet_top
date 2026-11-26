#!/usr/bin/env node
// Кабинет репетитора: сервер. Node.js 22+, без сторонних пакетов.
// Отдаёт сайт, хранит данные (SQLite), проверяет домашки, передаёт сообщения урока
// (WebSocket, совместим с клиентом Supabase Realtime), выдаёт пароли к TURN для видео,
// хранит данные репетитора для входа с любого устройства и делает ежедневные копии базы.
'use strict';
process.removeAllListeners('warning');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const VERSION = '1.0.0';
const env = process.env;
const PORT = +env.KAB_PORT || 8080;
const HOST = env.KAB_HOST || '127.0.0.1';
const SITE = path.resolve(env.KAB_SITE || path.join(__dirname, '..'));
const DATA = path.resolve(env.KAB_DATA || path.join(__dirname, 'data'));
const PY_DIR = path.join(DATA, 'py');
const BACKUPS = path.join(DATA, 'backups');
const KEEP_BACKUPS = +env.KAB_KEEP_BACKUPS || 14;
const TRUST_PROXY = env.KAB_TRUST_PROXY !== '0';
const TURN_SECRET = env.KAB_TURN_SECRET || '';
const TURN_HOST = env.KAB_TURN_HOST || '';
const TURN_PORT = +env.KAB_TURN_PORT || 3478;
const CF_ID = env.CF_TURN_KEY_ID || '';
const CF_TOKEN = env.CF_TURN_KEY_TOKEN || '';
const PUBLIC_KEY = 'self';

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(BACKUPS, { recursive: true });

/* ---------------- база ---------------- */
const db = new DatabaseSync(path.join(DATA, 'kabinet.db'));
db.exec(`
pragma journal_mode = wal;
pragma synchronous = normal;
pragma busy_timeout = 5000;
pragma foreign_keys = on;
create table if not exists owner (token text primary key, key_hash text not null);
create table if not exists data (token text not null, item text not null, body text not null,
  updated integer not null, primary key (token, item));
create table if not exists vault (k text primary key, body text, u integer not null, size integer not null default 0);
create table if not exists session (id text primary key, exp integer not null, ip text, ua text, created integer not null);
create table if not exists meta (k text primary key, v text);
`);
const Q = {
  ownerGet: db.prepare('select key_hash from owner where token = ?'),
  ownerAdd: db.prepare('insert into owner (token, key_hash) values (?, ?)'),
  ownerDel: db.prepare('delete from owner where token = ?'),
  put: db.prepare(`insert into data (token, item, body, updated) values (?, ?, ?, ?)
    on conflict (token, item) do update set body = excluded.body, updated = excluded.updated`),
  get: db.prepare('select body from data where token = ? and item = ?'),
  delOne: db.prepare('delete from data where token = ? and item = ?'),
  delAll: db.prepare('delete from data where token = ?'),
  delPrefix: db.prepare('delete from data where token = ? and substr(item, 1, ?) = ?'),
  vList: db.prepare('select k, u, size, body is null as d from vault order by k'),
  vGet: db.prepare('select body, u from vault where k = ?'),
  vPut: db.prepare(`insert into vault (k, body, u, size) values (?, ?, ?, ?)
    on conflict (k) do update set body = excluded.body, u = excluded.u, size = excluded.size`),
  sGet: db.prepare('select exp from session where id = ?'),
  sAdd: db.prepare('insert into session (id, exp, ip, ua, created) values (?, ?, ?, ?, ?)'),
  sDel: db.prepare('delete from session where id = ?'),
  sClean: db.prepare('delete from session where exp < ?'),
  sAll: db.prepare('delete from session'),
  mGet: db.prepare('select v from meta where k = ?'),
  mSet: db.prepare('insert into meta (k, v) values (?, ?) on conflict (k) do update set v = excluded.v'),
};
function tx(fn) {
  db.exec('begin immediate');
  try { const r = fn(); db.exec('commit'); return r; } catch (e) { db.exec('rollback'); throw e; }
}

/* ---------------- пароль репетитора ---------------- */
// В базе хранится scrypt-хеш. Задаётся командой: node kabinet.js passwd
function hashPass(p) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(p, salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
function checkPass(p) {
  const row = Q.mGet.get('pass');
  if (!row || !row.v) return false;
  const [kind, s, h] = row.v.split('$');
  if (kind !== 'scrypt') return false;
  const got = crypto.scryptSync(String(p || ''), Buffer.from(s, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ---------------- команды из консоли ---------------- */
if (process.argv[2] === 'passwd') {
  const p = process.argv[3] || env.KAB_NEW_PASS || '';
  if (p.length < 8) { console.error('Пароль должен быть не короче 8 символов'); process.exit(1); }
  Q.mSet.run('pass', hashPass(p));
  Q.sAll.run();
  console.log('Пароль репетитора сохранён. Все входы на других устройствах сброшены.');
  process.exit(0);
}
if (process.argv[2] === 'backup') {
  console.log('Копия: ' + backupNow());
  process.exit(0);
}
if (process.argv[2] === 'check') {
  console.log(JSON.stringify({ ok: true, version: VERSION, pass: !!(Q.mGet.get('pass') || {}).v }));
  process.exit(0);
}

/* ---------------- ограничители частоты ---------------- */
const buckets = new Map();
function allow(key, rate, burst) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { t: burst, at: now }; buckets.set(key, b); }
  b.t = Math.min(burst, b.t + (now - b.at) / 1000 * rate);
  b.at = now;
  if (b.t < 1) return false;
  b.t -= 1;
  return true;
}
setInterval(() => { const old = Date.now() - 600000; for (const [k, b] of buckets) if (b.at < old) buckets.delete(k); }, 60000).unref();

/* ---------------- HTTP-помощники ---------------- */
function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  if (TRUST_PROXY && (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1')) {
    const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (x) return x;
  }
  return ra;
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-updated',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'x-updated',
};
function send(res, code, body, type, extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body));
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length,
    'Cache-Control': 'no-store', ...CORS, ...(extra || {}) });
  res.end(buf);
}
const sendJson = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), null, extra);
const fail = (res, code, msg) => sendJson(res, code, { message: msg, code: String(code) });
class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = +req.headers['content-length'];
    if (len > limit) { reject(new HttpErr(413, 'too large')); req.resume(); return; }
    const parts = []; let n = 0; let done = false;
    req.on('data', c => {
      if (done) return;
      n += c.length;
      if (n > limit) { done = true; reject(new HttpErr(413, 'too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts).toString('utf8')); } });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}
async function readJson(req, limit) {
  const t = await readBody(req, limit);
  try { return t ? JSON.parse(t) : {}; } catch (e) { throw new HttpErr(400, 'bad json'); }
}

/* ---------------- RPC (те же функции, что в supabase.sql) ---------------- */
const sha = s => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
const isStr = v => typeof v === 'string';
function ownerOk(token, key) {
  const r = Q.ownerGet.get(token);
  return !!r && isStr(key) && crypto.timingSafeEqual(Buffer.from(r.key_hash), Buffer.from(sha(key)));
}
function need(cond, code, msg) { if (!cond) throw new HttpErr(code, msg); }
const knorm = x => String(x == null ? '' : x).trim().toLowerCase().replace(/,/g, '.').replace(/\s+/g, '');
const NUM = /^-?[0-9]+(\.[0-9]+)?$/;

const RPC = {
  kab_put(a) {
    const { p_token: t, p_key: k, p_item: it, p_data: d } = a;
    need(isStr(t) && t.length >= 16 && t.length <= 80 && isStr(k) && k.length >= 16 &&
      isStr(it) && it.length > 0 && it.length <= 120 && d !== undefined && d !== null, 400, 'bad request');
    const body = JSON.stringify(d);
    need(body.length <= 9e6, 413, 'too large');
    tx(() => {
      const r = Q.ownerGet.get(t);
      if (!r) Q.ownerAdd.run(t, sha(k));
      else need(ownerOk(t, k), 403, 'forbidden');
      Q.put.run(t, it, body, Date.now());
    });
    return '';
  },
  kab_get(a) {
    const { p_token: t, p_item: it } = a;
    if (!isStr(t) || !isStr(it) || it.startsWith('key:')) return 'null';
    const r = Q.get.get(t, it);
    return r ? r.body : 'null';
  },
  kab_get_own(a) {
    const { p_token: t, p_key: k, p_item: it } = a;
    need(isStr(t) && ownerOk(t, k), 403, 'forbidden');
    const r = isStr(it) ? Q.get.get(t, it) : null;
    return r ? r.body : 'null';
  },
  kab_del(a) {
    const { p_token: t, p_key: k, p_item: it } = a;
    need(isStr(t) && ownerOk(t, k), 403, 'forbidden');
    tx(() => {
      if (it == null) { Q.delAll.run(t); Q.ownerDel.run(t); }
      else if (isStr(it) && it.endsWith('*')) { const p = it.slice(0, -1); Q.delPrefix.run(t, p.length, p); }
      else if (isStr(it)) Q.delOne.run(t, it);
    });
    return '';
  },
  kab_photo(a) {
    const { p_token: t, p_item: it, p_data: d } = a;
    need(isStr(t) && !!Q.ownerGet.get(t), 403, 'forbidden');
    need(isStr(it) && /^ph:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{1,40}:[0-9]{1,2}$/.test(it), 400, 'bad item');
    need(isStr(d) && d.length <= 2000000 && /^data:image\/(jpeg|png|webp);base64,/.test(d), 400, 'bad photo');
    Q.put.run(t, it, JSON.stringify(d), Date.now());
    return '';
  },
  kab_submit(a) {
    const { p_token: t, p_asg: asg, p_answers: ans } = a;
    need(isStr(asg) && /^[A-Za-z0-9_-]{1,40}$/.test(asg) && ans && typeof ans === 'object' && !Array.isArray(ans), 400, 'bad request');
    need(isStr(t), 400, 'bad request');
    const kr = Q.get.get(t, 'key:' + asg);
    need(kr, 400, 'no assignment');
    const k = JSON.parse(kr.body) || {};
    const pr = Q.get.get(t, 'sub:' + asg);
    const prev = pr ? JSON.parse(pr.body) : null;
    const res = {}, right = {};
    let score = 0, total = 0;
    const show = k.show === true || k.show === 'true';
    for (const n of Object.keys(k.ans || {})) {
      const kind = (k.kind && k.kind[n]) || 'short';
      const given = String(ans[n] == null ? '' : ans[n]).slice(0, 300);
      if (kind === 'photo') { res[n] = null; continue; }
      total++;
      let good = false;
      for (const alt of String(k.ans[n] == null ? '' : k.ans[n]).split('|')) {
        const x = knorm(alt), y = knorm(given);
        if (x !== '' && (x === y || (NUM.test(x) && NUM.test(y) && Number(x) === Number(y)))) good = true;
      }
      if (good) score++;
      res[n] = good;
      if (show) right[n] = k.ans[n] == null ? null : String(k.ans[n]);
    }
    const clean = {};
    for (const n of Object.keys(ans).slice(0, 200)) clean[String(n).slice(0, 40)] = String(ans[n] == null ? '' : ans[n]).slice(0, 300);
    const out = { answers: clean, res, score, total, right, at: new Date().toISOString(),
      tries: ((prev && +prev.tries) || 0) + 1 };
    Q.put.run(t, 'sub:' + asg, JSON.stringify(out), Date.now());
    return JSON.stringify(out);
  },
};

/* ---------------- вход репетитора и его данные ---------------- */
const SESSION_DAYS = 120;
function session(req) {
  const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
  if (!m || m[1] === PUBLIC_KEY) return null;
  const r = Q.sGet.get(sha(m[1]));
  return r && r.exp > Date.now() ? m[1] : null;
}
const VKEY = /^(state|bank|board:[A-Za-z0-9_-]{1,60}|timg:[A-Za-z0-9_-]{1,60})$/;

async function api(req, res, url) {
  const ip = clientIp(req);
  const p = url.pathname;
  if (p === '/api/health') return sendJson(res, 200, { ok: true, version: VERSION, pass: !!(Q.mGet.get('pass') || {}).v });
  if (p === '/api/login' && req.method === 'POST') {
    if (!allow('login:' + ip, 5 / 900, 8) || !allow('login', 1, 20)) return fail(res, 429, 'Слишком много попыток. Подождите 15 минут.');
    const b = await readJson(req, 4096);
    if (!(Q.mGet.get('pass') || {}).v) return fail(res, 503, 'Пароль репетитора ещё не задан на сервере');
    if (!checkPass(b.password)) return fail(res, 401, 'Неверный пароль');
    const id = crypto.randomBytes(32).toString('base64url');
    const exp = Date.now() + SESSION_DAYS * 864e5;
    Q.sClean.run(Date.now());
    Q.sAdd.run(sha(id), exp, ip, String(req.headers['user-agent'] || '').slice(0, 200), Date.now());
    return sendJson(res, 200, { token: id, exp });
  }
  if (!allow('api:' + ip, 40, 400)) return fail(res, 429, 'slow down');
  const sid = session(req);
  if (!sid) return fail(res, 401, 'Нужно войти');
  if (p === '/api/logout' && req.method === 'POST') { Q.sDel.run(sha(sid)); return sendJson(res, 200, { ok: true }); }
  if (p === '/api/vault' && req.method === 'GET') {
    return sendJson(res, 200, { now: Date.now(), items: Q.vList.all().map(r => ({ k: r.k, u: r.u, n: r.size, d: r.d ? 1 : 0 })) });
  }
  if (p === '/api/vault/item') {
    const k = url.searchParams.get('k') || '';
    if (!VKEY.test(k)) return fail(res, 400, 'bad key');
    if (req.method === 'GET') {
      const r = Q.vGet.get(k);
      if (!r || r.body == null) return sendJson(res, 404, { message: 'not found', u: r ? r.u : 0 }, { 'x-updated': String(r ? r.u : 0) });
      return send(res, 200, r.body, null, { 'x-updated': String(r.u) });
    }
    // base — версия, от которой клиент делал изменения. Если на сервере уже другая, отвечаем 409,
    // клиент сливает изменения и присылает снова. Без base запись принимается как есть.
    const bp = url.searchParams.get('base');
    const base = bp == null || bp === '' ? null : Math.floor(+bp);
    if (req.method === 'PUT' || req.method === 'DELETE') {
      const body = req.method === 'PUT' ? await readBody(req, 40e6) : null;
      if (body != null) { try { JSON.parse(body); } catch (e) { return fail(res, 400, 'bad json'); } }
      const out = tx(() => {
        const cur = Q.vGet.get(k);
        const cu = cur ? cur.u : 0;
        if (base != null && base !== cu) return { conflict: cu };
        const u = Math.max(Date.now(), cu + 1);
        Q.vPut.run(k, body, u, body ? body.length : 0);
        return { u };
      });
      if (out.conflict != null) return sendJson(res, 409, { message: 'conflict', u: out.conflict });
      return sendJson(res, 200, { ok: true, u: out.u });
    }
  }
  return fail(res, 404, 'not found');
}

/* ---------------- TURN ---------------- */
let cfCache = null;
async function cloudflareIce() {
  if (!CF_ID || !CF_TOKEN) return [];
  if (cfCache && cfCache.exp > Date.now()) return cfCache.list;
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${CF_ID}/credentials/generate-ice-servers`, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }) });
    clearTimeout(tm);
    const j = await r.json();
    const list = Array.isArray(j.iceServers) ? j.iceServers : (j.iceServers ? [j.iceServers] : []);
    cfCache = { exp: Date.now() + 6 * 36e5, list };
    return list;
  } catch (e) { console.warn('cloudflare turn:', e.message); return []; }
}
async function turn(req, res) {
  const ip = clientIp(req);
  if (!allow('turn:' + ip, 1, 20)) return fail(res, 429, 'slow down');
  const ice = [];
  if (TURN_SECRET && TURN_HOST) {
    const user = Math.floor(Date.now() / 1000 + 86400) + ':kab';
    const cred = crypto.createHmac('sha1', TURN_SECRET).update(user).digest('base64');
    ice.push({ urls: [`stun:${TURN_HOST}:${TURN_PORT}`] });
    ice.push({ urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`],
      username: user, credential: cred });
  }
  ice.push(...await cloudflareIce());
  return sendJson(res, 200, { iceServers: ice });
}

/* ---------------- сайт ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip',
  '.whl': 'application/zip', '.tar': 'application/x-tar', '.data': 'application/octet-stream', '.pdf': 'application/pdf' };
function configJs() {
  const py = fs.existsSync(path.join(PY_DIR, 'pyodide.js'));
  return `// Создано сервером кабинета, править не нужно.
window.KABINET_CLOUD = { url: location.origin, key: ${JSON.stringify(PUBLIC_KEY)} };
window.KABINET_SERVER = { version: ${JSON.stringify(VERSION)} };
${py ? 'window.KABINET_PYODIDE = location.origin + "/py/";' : ''}
`;
}
async function serveFile(req, res, root, rel, cache) {
  const full = path.join(root, rel);
  if (!full.startsWith(root + path.sep) && full !== root) return fail(res, 404, 'not found');
  let st;
  try { st = await fsp.stat(full); } catch (e) { return null; }
  if (!st.isFile()) return null;
  const etag = '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
  const h = { 'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', ETag: etag,
    'Cache-Control': cache, ...CORS };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
  h['Content-Length'] = st.size;
  res.writeHead(200, h);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  return true;
}
async function site(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return fail(res, 400, 'bad path'); }
  if (rel.includes('\0')) return fail(res, 400, 'bad path');
  if (rel === '/config.js') return send(res, 200, configJs(), 'text/javascript; charset=utf-8');
  if (rel.startsWith('/py/')) {
    const r = await serveFile(req, res, PY_DIR, path.normalize(rel.slice(4)), 'public, max-age=2592000, immutable');
    return r === null ? fail(res, 404, 'not found') : r;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const parts = rel.split('/').filter(Boolean);
  // закрытые места репозитория
  if (parts.some(x => x.startsWith('.')) || ['server', 'node_modules', 'kabinet.js'].includes(parts[0]) ||
      /\.(sql|ts|sh|md|txt|env|db)$/i.test(rel)) return fail(res, 404, 'not found');
  const cache = /\.(woff2?|mjs|wasm)$/i.test(rel) ? 'public, max-age=604800' : 'no-cache';
  const r = await serveFile(req, res, SITE, path.normalize(parts.join('/')), cache);
  if (r === null) return fail(res, 404, 'not found');
}

/* ---------------- маршрутизация ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
    const p = url.pathname;
    if (p.startsWith('/rest/v1/rpc/') && req.method === 'POST') {
      const fn = p.slice(13);
      if (!Object.hasOwn(RPC, fn)) return fail(res, 404, 'no function');
      const ip = clientIp(req);
      const heavy = fn === 'kab_photo' || fn === 'kab_submit';
      if (!allow('rpc:' + ip, 40, 400) || (heavy && !allow('rpch:' + ip, 2, 60))) return fail(res, 429, 'slow down');
      const a = await readJson(req, 12e6);
      return send(res, 200, RPC[fn](a));
    }
    if (p === '/functions/v1/turn') return await turn(req, res);
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return await site(req, res, url);
    return fail(res, 405, 'method not allowed');
  } catch (e) {
    if (e instanceof HttpErr) return res.headersSent ? res.destroy() : fail(res, e.code, e.message);
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'server error'); else res.destroy();
  }
});
server.requestTimeout = 120000;
server.headersTimeout = 20000;
server.keepAliveTimeout = 65000;

/* ---------------- WebSocket: каналы урока ---------------- */
// Протокол Phoenix v1 (как у Supabase Realtime): phx_join, heartbeat, broadcast, phx_leave.
const MAX_MSG = 4 * 1024 * 1024;
const topics = new Map();
let wsCount = 0;
class Ws {
  constructor(sock) {
    this.s = sock; this.buf = Buffer.alloc(0); this.frag = null; this.fragOp = 0; this.dead = false;
    this.topics = new Set(); this.last = Date.now(); this.tok = 300; this.tokAt = Date.now();
    sock.on('data', d => this.feed(d));
    sock.on('close', () => this.gone());
    sock.on('error', () => this.gone());
    sock.setNoDelay(true);
    sock.setTimeout(0);
  }
  feed(d) {
    if (this.dead) return;
    this.last = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const hi = b.readUInt32BE(2); if (hi) return this.close(1009); len = b.readUInt32BE(6); off = 10; }
      if (!masked) return this.close(1002);
      if (len > MAX_MSG) return this.close(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const pl = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < pl.length; i++) pl[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) return this.close(1000);
      if (op === 9) { this.frame(10, pl); continue; }
      if (op === 10) continue;
      if (op === 0) {
        if (!this.frag) return this.close(1002);
        this.frag.push(pl);
        if (this.frag.reduce((a, x) => a + x.length, 0) > MAX_MSG) return this.close(1009);
        if (fin) { const m = Buffer.concat(this.frag); this.frag = null; if (this.fragOp === 1) this.msg(m.toString('utf8')); }
        continue;
      }
      if (op === 1 || op === 2) {
        if (!fin) { this.frag = [pl]; this.fragOp = op; continue; }
        if (op === 1) this.msg(pl.toString('utf8'));
        continue;
      }
      return this.close(1002);
    }
  }
  frame(op, data) {
    if (this.dead) return;
    const pl = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    let h;
    if (pl.length < 126) h = Buffer.from([0x80 | op, pl.length]);
    else if (pl.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(pl.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(pl.length, 6); }
    if (this.s.writableLength > 16 * 1024 * 1024) return this.close(1008);
    this.s.write(Buffer.concat([h, pl]));
  }
  send(obj) { this.frame(1, typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  close(code) {
    if (this.dead) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code || 1000, 0);
    try { this.frame(8, b); } catch (e) {}
    this.gone();
    try { this.s.end(); } catch (e) {}
    setTimeout(() => { try { this.s.destroy(); } catch (e) {} }, 2000).unref();
  }
  gone() {
    if (this.dead) return;
    this.dead = true; wsCount--;
    for (const t of this.topics) { const set = topics.get(t); if (set) { set.delete(this); if (!set.size) topics.delete(t); } }
    this.topics.clear();
  }
  msg(text) {
    const now = Date.now();
    this.tok = Math.min(600, this.tok + (now - this.tokAt) / 1000 * 200); this.tokAt = now;
    if (this.tok < 1) return;
    this.tok--;
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const topic = typeof m.topic === 'string' ? m.topic : '';
    const ok = r => this.send({ topic, event: 'phx_reply', payload: { status: 'ok', response: r || {} }, ref: m.ref ?? null });
    if (m.event === 'heartbeat') return ok();
    if (!topic || topic.length > 200) return;
    if (m.event === 'phx_join') {
      if (!this.topics.has(topic)) {
        if (this.topics.size >= 50) return this.send({ topic, event: 'phx_reply', payload: { status: 'error', response: { reason: 'too many' } }, ref: m.ref ?? null });
        this.topics.add(topic);
        let set = topics.get(topic); if (!set) { set = new Set(); topics.set(topic, set); }
        set.add(this);
      }
      return ok({ postgres_changes: [] });
    }
    if (m.event === 'phx_leave') {
      this.topics.delete(topic);
      const set = topics.get(topic); if (set) { set.delete(this); if (!set.size) topics.delete(topic); }
      return ok();
    }
    if (m.event === 'broadcast' && this.topics.has(topic)) {
      const out = JSON.stringify({ topic, event: 'broadcast', payload: m.payload, ref: null });
      for (const c of topics.get(topic) || []) if (c !== this) c.frame(1, out);
    }
  }
}
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/realtime/v1/websocket' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return;
  }
  const ip = clientIp(req);
  if (!allow('ws:' + ip, 1, 30) || wsCount > 5000) { sock.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  wsCount++;
  const c = new Ws(sock);
  if (head && head.length) c.feed(head);
});
// закрываем молчащие соединения (клиент шлёт heartbeat раз в 25 секунд)
setInterval(() => {
  const old = Date.now() - 90000;
  for (const set of topics.values()) for (const c of set) if (c.last < old) c.close(1001);
}, 30000).unref();

/* ---------------- ежедневные копии базы ---------------- */
function backupNow() {
  const d = new Date();
  const name = 'kabinet-' + d.toISOString().slice(0, 10) + '.db';
  const file = path.join(BACKUPS, name);
  try { fs.unlinkSync(file); } catch (e) {}
  db.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
  const all = fs.readdirSync(BACKUPS).filter(f => /^kabinet-\d{4}-\d\d-\d\d\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUPS, f));
  Q.mSet.run('backup', d.toISOString());
  return file;
}
function backupTick() {
  const last = (Q.mGet.get('backup') || {}).v;
  if (!last || Date.now() - Date.parse(last) > 23 * 36e5) {
    try { console.log('backup:', backupNow()); } catch (e) { console.error('backup failed:', e); }
  }
  Q.sClean.run(Date.now());
}
setTimeout(backupTick, 60000).unref();
setInterval(backupTick, 36e5).unref();

/* ---------------- запуск ---------------- */
server.listen(PORT, HOST, () => console.log(`kabinet ${VERSION} on ${HOST}:${PORT}, site ${SITE}, data ${DATA}`));
const stop = () => { console.log('stopping'); server.close(); for (const set of topics.values()) for (const c of set) c.close(1001); try { db.close(); } catch (e) {} process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
