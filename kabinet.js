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
create table if not exists practice (token text not null, id text not null, ok integer not null, last integer not null,
  tries integer not null, at integer not null, primary key (token, id));
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
const knorm = x => String(x == null ? '' : x).trim().toLowerCase().replace(/[−–—]/g, '-').replace(/,/g, '.').replace(/\s+/g, '');
const NUM = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
// выбор вариантов: буквы в любом порядке, кириллица и латиница считаются одинаково
const LAT = { 'а': 'a', 'в': 'b', 'с': 'c', 'д': 'd', 'е': 'e', 'ф': 'f', 'б': 'b', 'г': 'g' };
const cnorm = x => [...String(x == null ? '' : x).toLowerCase().replace(/[^a-zа-яё]/g, '')].map(c => LAT[c] || c).sort().join('');

function checkOne(kind, key, given) {
  for (const alt of String(key == null ? '' : key).split('|')) {
    const x = kind === 'choice' ? cnorm(alt) : knorm(alt), y = kind === 'choice' ? cnorm(given) : knorm(given);
    if (x !== '' && (x === y || (NUM.test(x) && NUM.test(y) && Number(x) === Number(y)))) return true;
  }
  return false;
}

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
      const good = checkOne(kind, k.ans[n], given);
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

/* ---------------- тренажёр для учеников ---------------- */
// Задания берутся из базы репетитора (его данные на сервере). Ответы ученику не отдаются, проверка — здесь.
const PQ = {
  get: db.prepare('select ok, last, tries, at from practice where token = ? and id = ?'),
  put: db.prepare(`insert into practice (token, id, ok, last, tries, at) values (?, ?, ?, ?, 1, ?)
    on conflict (token, id) do update set ok = max(practice.ok, excluded.ok), last = excluded.last, tries = practice.tries + 1, at = excluded.at`),
  all: db.prepare('select id, ok, last, tries, at from practice where token = ?'),
  asg: db.prepare("select item, body from data where token = ? and substr(item, 1, 4) = 'asg:'"),
  sub: db.prepare("select 1 from data where token = ? and item = ?"),
};
// задания из несданных домашек ученика в тренажёре не показываются, чтобы нельзя было подсмотреть ответ
function hwIds(token) {
  const s = new Set();
  for (const r of PQ.asg.all(token)) {
    if (PQ.sub.get(token, 'sub:' + r.item.slice(4))) continue;
    try { for (const t of JSON.parse(r.body).tasks || []) s.add(t.id); } catch (e) {}
  }
  return s;
}
/* готовая база: файлы packs/<экзамен>.json на сервере, загружает репетитор */
const PACK_DIR = path.join(DATA, 'packs');
fs.mkdirSync(PACK_DIR, { recursive: true });
const PK = { v: 0, byExam: new Map(), byId: new Map() };
function packsLoad() {
  PK.byExam = new Map(); PK.byId = new Map();
  const files = fs.readdirSync(PACK_DIR).filter(f => /^[a-z_]+(\.[a-z0-9_]+)?\.json$/.test(f)).sort();
  for (const f of files) {
    try { const d = JSON.parse(fs.readFileSync(path.join(PACK_DIR, f), 'utf8')); const ex = f.split('.')[0], tag = f.split('.').length > 2 ? f.split('.')[1] : '';
      const tasks = (d.tasks || []).filter(t => t && t.id && t.exam === ex && !PK.byId.has(t.id)).map(t => ({ ...t, pack: true }));
      const cur = PK.byExam.get(ex) || { exam: ex, name: d.name || 'Готовая база', made: d.made || '', tasks: [], parts: [] };
      cur.tasks = cur.tasks.concat(tasks); cur.parts.push({ tag, name: d.name || 'Готовая база', n: tasks.length, made: d.made || '' }); PK.byExam.set(ex, cur);
      for (const t of tasks) PK.byId.set(t.id, t);
    } catch (e) { console.error('pack', f, e.message); }
  }
  try { PK.mt = fs.statSync(PACK_DIR).mtimeMs; } catch (e) {}
  PK.v++;
}
function packsFresh() { try { if (fs.statSync(PACK_DIR).mtimeMs !== PK.mt) packsLoad(); } catch (e) {} }
packsLoad();
const packMeta = t => { const { img, solh, sol, ...rest } = t; return { ...rest, img: img ? true : false, sol: !!(sol || solh) }; };

let PC = { bu: -1, su: -1, pv: -1, tasks: [], byId: new Map(), tokens: new Set(), off: false };
function practiceData() {
  packsFresh();
  const b = Q.vGet.get('bank'), st = Q.vGet.get('state');
  const bu = b ? b.u : 0, su = st ? st.u : 0;
  if (bu === PC.bu && su === PC.su && PK.v === PC.pv) return PC;
  let tasks = [], tokens = new Set(), off = false, phide = new Set();
  try { const a = b && b.body ? JSON.parse(b.body) : []; if (Array.isArray(a)) tasks = a.filter(t => t && t.id && t.exam && !t.hide); } catch (e) {}
  try { const sj = st && st.body ? JSON.parse(st.body) : null; if (sj) { for (const x of sj.students || []) if (x && x.token) tokens.add(x.token); off = !!(sj.settings && sj.settings.practiceOff); for (const id of (sj.settings && sj.settings.packHide) || []) phide.add(id); } } catch (e) {}
  for (const p of PK.byExam.values()) for (const t of p.tasks) if (!phide.has(t.id)) tasks.push(t);
  const byId = new Map(tasks.map(t => [t.id, t]));
  PC = { bu, su, pv: PK.v, tasks, byId, tokens, off };
  return PC;
}
const pub = t => ({ id: t.id, exam: t.exam, num: t.num, kind: t.kind || 'short', text: t.img === false || t.fig || (t.pack && !t.img) ? (t.text || '') : '', img: t.pack ? !!t.img : t.img !== false, fig: !!t.fig, file: t.file || null, src: t.src || '', sub: t.sub || '', ...(t.html ? { html: t.html } : {}), ...(t.files ? { files: t.files } : {}) });
const numKey = n => { const m = /^(\d+)(?:\.(\d+))?/.exec(n || ''); return m ? +m[1] * 100 + (+m[2] || 0) : 1e6; };
async function practice(req, res, url) {
  const ip = clientIp(req);
  if (!allow('pr:' + ip, 15, 300)) return fail(res, 429, 'slow down');
  const q = url.searchParams;
  const body = req.method === 'POST' ? await readJson(req, 64 * 1024) : {};
  const token = String(body.t || q.get('t') || '');
  const D = practiceData();
  // доступ: ученик по своей ссылке или репетитор после входа
  const tutor = !!session(req);
  if (!tutor && (!D.tokens.has(token) || D.off)) return fail(res, 403, D.off ? 'Тренажёр выключен репетитором' : 'forbidden');
  const p = url.pathname;
  const hide = tutor ? new Set() : hwIds(token);
  const T = D.tasks.filter(t => !hide.has(t.id));
  if (p === '/api/practice/catalog') {
    const ex = {}, vars = {};
    for (const t of T) {
      (ex[t.exam] = ex[t.exam] || {})[t.num] = (ex[t.exam][t.num] || 0) + 1;
      const vn = t.pack ? t.var : (t.src && t.src !== 'Своя база' ? t.src : ''); if (vn) { const k = t.exam + '|' + vn; vars[k] = vars[k] || { exam: t.exam, name: vn, n: 0, nums: new Set() }; vars[k].n++; vars[k].nums.add(t.num); }
    }
    const prog = {}; for (const r of PQ.all.all(token)) { const t = D.byId.get(r.id); if (t) prog[r.id] = [r.ok, r.last, r.tries, r.at, t.exam, t.num]; }
    return sendJson(res, 200, { exams: ex, variants: Object.values(vars).filter(v => v.n >= 2 && v.nums.size >= 2).map(v => ({ exam: v.exam, name: v.name, n: v.n })), progress: prog });
  }
  if (p === '/api/practice/list') {
    const ex = q.get('ex'), num = q.get('num');
    return sendJson(res, 200, T.filter(t => t.exam === ex && t.num === num).sort((a, b) => String(a.id) < String(b.id) ? -1 : 1).map(pub));
  }
  if (p === '/api/practice/variant') {
    const ex = q.get('ex'), name = q.get('name');
    let list;
    if (name) {
      list = T.filter(t => t.exam === ex && (t.pack ? t.var === name : t.src === name));
      // вариант прошлых лет из готовой базы: по одному заданию на номер, как на экзамене
      if (list.length && list.every(t => t.pack)) { const by = new Map(); for (const t of list.sort((a, b) => String(a.id) < String(b.id) ? -1 : 1)) if (!by.has(t.num)) by.set(t.num, t); list = [...by.values()]; }
    }
    else {
      const done = new Set(PQ.all.all(token).filter(r => r.ok).map(r => r.id));
      const by = {}; for (const t of T) if (t.exam === ex) (by[t.num] = by[t.num] || []).push(t);
      list = Object.values(by).map(a => { const fresh = a.filter(t => !done.has(t.id)); const pool = fresh.length ? fresh : a; return pool[crypto.randomInt(pool.length)]; });
    }
    list.sort((a, b) => numKey(a.num) - numKey(b.num) || (a.at || 0) - (b.at || 0));
    return sendJson(res, 200, list.slice(0, 60).map(pub));
  }
  if (p === '/api/practice/img') {
    const id = q.get('id') || '';
    const pk = PK.byId.get(id);
    if (!D.byId.has(id) && !(tutor && pk)) return fail(res, 404, 'not found');
    let d;
    if (pk) d = pk.img; else { const r = Q.vGet.get('timg:' + id); if (!r || !r.body) return fail(res, 404, 'not found'); d = JSON.parse(r.body); }
    const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(String(d || ''));
    if (!m) return fail(res, 404, 'not found');
    const buf = Buffer.from(m[2], 'base64');
    res.writeHead(200, { 'Content-Type': m[1], 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400', ...CORS });
    return res.end(buf);
  }
  if (p === '/api/practice/check' && req.method === 'POST') {
    if (tutor && !token) { const out = {}; for (const it of (Array.isArray(body.items) ? body.items : [])) { const t = PK.byId.get(String(it.id || '')); if (t) out[t.id] = { ans: t.ans || '', sol: t.sol || '', solh: t.solh || '' }; } return sendJson(res, 200, out); }
    const out = {};
    const items = Array.isArray(body.items) ? body.items.slice(0, 80) : [];
    for (const it of items) {
      const t = D.byId.get(String(it.id || ''));
      if (!t || hide.has(t.id)) continue;
      const kind = t.kind || 'short';
      const r = { ans: t.ans || '', sol: t.sol || '', solh: t.solh || '' };
      if (kind === 'photo' || it.reveal) {
        if (typeof it.self === 'boolean' && token && !tutor) PQ.put.run(token, t.id, +it.self, +it.self, Date.now());
      } else {
        r.ok = checkOne(kind, t.ans, String(it.answer == null ? '' : it.answer).slice(0, 300));
        if (token && D.tokens.has(token)) PQ.put.run(token, t.id, +r.ok, +r.ok, Date.now());
      }
      out[t.id] = r;
    }
    return sendJson(res, 200, out);
  }
  return fail(res, 404, 'not found');
}

async function packsApi(req, res, url) {
  if (!session(req)) return fail(res, 401, 'Нужно войти');
  packsFresh();
  const ex = url.searchParams.get('exam') || '';
  if (url.pathname === '/api/packs' && req.method === 'GET') {
    return sendJson(res, 200, [...PK.byExam.values()].map(p => { const nums = {}, subs = {}; for (const t of p.tasks) { nums[t.num] = (nums[t.num] || 0) + 1; } return { exam: p.exam, name: p.name, made: p.made, n: p.tasks.length, nums, parts: p.parts }; }));
  }
  if (url.pathname === '/api/packs/tasks') { const p = PK.byExam.get(ex); return sendJson(res, 200, p ? p.tasks.map(packMeta) : []); }
  if (url.pathname === '/api/packs/upload' && req.method === 'POST') {
    if (!/^[a-z_]{2,20}$/.test(ex)) return fail(res, 400, 'bad exam');
    const body = await readBody(req, 90e6);
    let d; try { d = JSON.parse(body); } catch (e) { return fail(res, 400, 'Файл повреждён'); }
    const tasks = (Array.isArray(d) ? d : d.tasks || []).filter(t => t && t.id && t.exam === ex);
    if (!tasks.length) return fail(res, 400, 'В файле нет заданий этого экзамена');
    const tmp = path.join(PACK_DIR, ex + '.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, exam: ex, name: d.name || 'Готовая база', made: d.made || '', tasks }));
    fs.renameSync(tmp, path.join(PACK_DIR, ex + '.json'));
    packsLoad();
    return sendJson(res, 200, { ok: true, n: tasks.length });
  }
  if (url.pathname === '/api/packs' && req.method === 'DELETE') {
    if (!/^[a-z_]{2,20}$/.test(ex)) return fail(res, 400, 'bad exam');
    const tag = url.searchParams.get('tag') || '';
    if (tag && !/^[a-z0-9_]{1,20}$/.test(tag)) return fail(res, 400, 'bad tag');
    try { fs.unlinkSync(path.join(PACK_DIR, ex + (tag ? '.' + tag : '') + '.json')); } catch (e) {}
    packsLoad(); return sendJson(res, 200, { ok: true });
  }
  return fail(res, 404, 'not found');
}

/* ---------------- картинки и файлы заданий Школково ---------------- */
// Формулы и рисунки из базы Школково подгружаются через наш сервер и кэшируются на диске.
const SK_DIR = path.join(DATA, 'shkolkovo', 'cache');
const SK_PATH = /^\/api\/sk(\/(?:api\/latex-service\/v1\/GetSession\/\d{1,12}\/[\w.\-]{1,120}|st\/[^?#]{1,300}|public\/[^?#]{1,300}|upload[s]?\/[^?#]{1,300}|files?\/[^?#]{1,300}))$/;
const SK_TYPES = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', ods: 'application/vnd.oasis.opendocument.spreadsheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', zip: 'application/zip', pdf: 'application/pdf', py: 'text/plain; charset=utf-8' };
const skWait = new Map();
async function skProxy(req, res, url) {
  if (!allow('sk:' + clientIp(req), 60, 600)) return fail(res, 429, 'slow down');
  const m = SK_PATH.exec(url.pathname); if (!m || m[1].includes('..')) return fail(res, 404, 'not found');
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(m[1]) || [])[1]; const type = SK_TYPES[(ext || '').toLowerCase()];
  if (!type) return fail(res, 404, 'not found');
  fs.mkdirSync(SK_DIR, { recursive: true });
  const f = path.join(SK_DIR, crypto.createHash('sha1').update(m[1]).digest('hex') + '.' + ext.toLowerCase());
  const send = buf => { res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=2592000, immutable', 'X-Content-Type-Options': 'nosniff', ...(type === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}), ...(/^image\//.test(type) ? {} : { 'Content-Disposition': 'attachment' }) }); res.end(buf); };
  try { return send(fs.readFileSync(f)); } catch (e) {}
  try {
    if (!skWait.has(f)) skWait.set(f, (async () => {
      const r = await fetch((process.env.SK_BASE || 'https://3.shkolkovo.online') + m[1], { headers: { 'User-Agent': 'Mozilla/5.0 (kabinet tutor)' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 30e6) throw new Error('too big');
      fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f); return buf;
    })().finally(() => setTimeout(() => skWait.delete(f), 1000)));
    return send(await skWait.get(f));
  } catch (e) { return fail(res, 502, 'Не удалось получить файл'); }
}

/* ---------------- материалы ФИПИ для репетитора ---------------- */
// Сервер скачивает страницу или файл с сайта ФИПИ по просьбе репетитора (браузер сам не может из-за CORS).
const FIPI_HOSTS = /^(www\.)?(fipi\.ru|doc\.fipi\.ru|oge\.fipi\.ru|ege\.fipi\.ru)$/i;
async function fetchFipi(u, limit) {
  let url; try { url = new URL(u); } catch (e) { throw new HttpErr(400, 'Неверная ссылка'); }
  if (!/^https?:$/.test(url.protocol) || !FIPI_HOSTS.test(url.hostname)) throw new HttpErr(400, 'Можно только ссылки с сайта fipi.ru');
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (kabinet)' } });
    if (!r.ok) throw new HttpErr(502, 'ФИПИ ответил ошибкой ' + r.status);
    const fin = new URL(r.url); if (!FIPI_HOSTS.test(fin.hostname)) throw new HttpErr(400, 'Ссылка ведёт не на fipi.ru');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > limit) throw new HttpErr(413, 'Файл слишком большой');
    return { buf, type: r.headers.get('content-type') || '', url: r.url };
  } catch (e) { if (e instanceof HttpErr) throw e; throw new HttpErr(502, 'Сайт ФИПИ не отвечает'); } finally { clearTimeout(tm); }
}
function unzipList(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new HttpErr(400, 'Архив повреждён');
  const n = buf.readUInt16LE(e + 10); let o = buf.readUInt32LE(e + 16); const out = [];
  const dec866 = new TextDecoder('ibm866');
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(o + 8), method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20), size = buf.readUInt32LE(o + 24);
    const nl = buf.readUInt16LE(o + 28), xl = buf.readUInt16LE(o + 30), cl = buf.readUInt16LE(o + 32), lo = buf.readUInt32LE(o + 42);
    const raw = buf.subarray(o + 46, o + 46 + nl);
    const name = flags & 0x800 ? raw.toString('utf8') : dec866.decode(raw);
    out.push({ name, method, csize, size, lo });
    o += 46 + nl + xl + cl;
  }
  return out;
}
function unzipGet(buf, ent) {
  const lo = ent.lo; if (buf.readUInt32LE(lo) !== 0x04034b50) throw new HttpErr(400, 'Архив повреждён');
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const data = buf.subarray(start, start + ent.csize);
  if (ent.method === 0) return Buffer.from(data);
  if (ent.method === 8) return require('node:zlib').inflateRawSync(data);
  throw new HttpErr(400, 'Неизвестное сжатие в архиве');
}
const fipiCache = new Map();
async function fipi(req, res, url) {
  if (!session(req)) return fail(res, 401, 'Нужно войти');
  if (!allow('fipi', 2, 30)) return fail(res, 429, 'slow down');
  const u = url.searchParams.get('url') || '';
  if (url.pathname === '/api/fipi/links') {
    const { buf, url: fin } = await fetchFipi(u, 8e6);
    const html = buf.toString('utf8'); const links = []; const seen = new Set();
    const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
    while ((m = re.exec(html))) {
      let href; try { href = new URL(m[1].replace(/&amp;/g, '&'), fin).href; } catch (e) { continue; }
      if (!/\.(zip|pdf)(\?|$)/i.test(href) || seen.has(href)) continue; seen.add(href);
      const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
      links.push({ url: href, text: text || decodeURIComponent(href.split('/').pop()) });
    }
    return sendJson(res, 200, { links });
  }
  if (url.pathname === '/api/fipi/file') {
    let got = fipiCache.get(u);
    if (!got) { got = await fetchFipi(u, 120e6); fipiCache.set(u, got); if (fipiCache.size > 6) fipiCache.delete(fipiCache.keys().next().value); }
    const isZip = got.buf.readUInt32LE(0) === 0x04034b50;
    if (!isZip) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': got.buf.length, ...CORS }); return res.end(got.buf); }
    const list = unzipList(got.buf);
    const entry = url.searchParams.get('entry');
    if (entry == null) return sendJson(res, 200, { zip: true, files: list.filter(f => /\.pdf$/i.test(f.name)).map(f => ({ name: f.name, size: f.size })) });
    const ent = list.find(f => f.name === entry); if (!ent) return fail(res, 404, 'Нет такого файла в архиве');
    const out = unzipGet(got.buf, ent);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': out.length, ...CORS }); return res.end(out);
  }
  return fail(res, 404, 'not found');
}

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
  const sid = session(req);
  if (!allow(sid ? 'apit' : 'api:' + ip, sid ? 300 : 20, sid ? 3000 : 100)) return fail(res, 429, 'slow down');
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
    if (p.startsWith('/api/practice/')) return await practice(req, res, url);
    if (p.startsWith('/api/fipi/')) return await fipi(req, res, url);
    if (p === '/api/packs' || p.startsWith('/api/packs/')) return await packsApi(req, res, url);
    if (p.startsWith('/api/sk/')) return await skProxy(req, res, url);
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
