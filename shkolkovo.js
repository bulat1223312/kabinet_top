#!/usr/bin/env node
// Загрузка каталога задач Школково в готовую базу кабинета.
// Запуск на сервере: kabinet shkolkovo [ege_inf oge_inf oge_math ege_prof]
// Скачивает аккуратно (одна страница за раз, с паузой), кэширует всё в DATA/shkolkovo,
// поэтому при обрыве можно просто запустить ещё раз — продолжит с того же места.
'use strict';
const fs = require('fs'), path = require('path');

const BASE = process.env.SK_BASE || 'https://3.shkolkovo.online';
const DATA = process.env.KAB_DATA || '/var/lib/kabinet';
const DIR = path.join(DATA, 'shkolkovo'), RAW = path.join(DIR, 'raw');
const PACK_DIR = path.join(DATA, 'packs');
const DELAY = +(process.env.SK_DELAY || 700);
const SUBJECTS = { ege_inf: 30, oge_inf: 34, oge_math: 31, ege_prof: 1 };
const MAXNUM = { ege_inf: 27, oge_inf: 16, oge_math: 25, ege_prof: 19 };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(RAW, { recursive: true }); fs.mkdirSync(PACK_DIR, { recursive: true });

async function get(u, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(BASE + u, { headers: { 'User-Agent': 'Mozilla/5.0 (kabinet tutor import; slow crawler)', 'Accept': 'text/html' }, signal: AbortSignal.timeout(60000) });
      if (r.status === 404) return null;
      if (r.ok) return await r.text();
      if (i >= tries) throw new Error('HTTP ' + r.status);
      await sleep((r.status === 429 ? 30000 : 4000) * (i + 1));
    } catch (e) { if (i >= tries) throw e; log('повтор', u, e.message); await sleep(5000 * (i + 1)); }
  }
}
function nextData(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html || '');
  if (!m) throw new Error('на странице нет данных (__NEXT_DATA__) — сайт поменял вёрстку');
  return JSON.parse(m[1]).props.pageProps;
}
async function page(u) { const h = await get(u); await sleep(DELAY); return h == null ? null : nextData(h); }

/* ---------- очистка HTML ---------- */
const ALLOW = new Set('p br b i u s em strong sub sup span div table thead tbody tr td th pre code ul ol li img center small big hr tt'.split(' '));
const DROP = /<(script|style|noscript|iframe|object|svg|math|head|title)\b[\s\S]*?<\/\1\s*>/gi;
const ent = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|minus|times|middot|laquo|raquo|mdash|ndash);/gi, (m, e) => {
  const k = e.toLowerCase(); const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', minus: '−', times: '×', middot: '·', laquo: '«', raquo: '»', mdash: '—', ndash: '–' };
  if (map[k]) return map[k]; const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
});
const escA = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function attr(a, name) { const m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(a); return m ? ent(m[1] ?? m[2] ?? m[3] ?? '') : null; }
function imgUrl(src, sess) {
  if (!src) return null; src = src.trim();
  if (/^data:image\/(png|jpeg|gif|svg\+xml|webp);base64,/i.test(src)) return src.length < 200000 ? src : null;
  let p = null;
  try { const u = new URL(src, BASE + '/api/latex-service/v1/GetSession/' + sess + '/'); if (/(^|\.)shkolkovo\.(online|net)$/.test(u.hostname) || u.origin === new URL(BASE).origin) p = u.pathname; } catch (e) {}
  return p ? '/api/sk' + p : null;
}
function clean(html, sess) {
  if (!html) return '';
  let s = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(DROP, '');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (m, tag, a) => {
    tag = tag.toLowerCase(); const close = m[1] === '/';
    if (tag === 'a') return close ? '</span>' : '<span>';
    if (!ALLOW.has(tag)) return '';
    if (close) return tag === 'img' || tag === 'br' || tag === 'hr' ? '' : '</' + tag + '>';
    if (tag === 'img') {
      const u = imgUrl(attr(a, 'src'), sess); const alt = (attr(a, 'alt') || '').replace(/\s+/g, ' ').trim();
      if (!u) return alt ? ' ' + escA(alt) + ' ' : '';
      const cls = /\bmath\b/.test(attr(a, 'class') || '') ? ' class="m"' : '';
      return `<img src="${escA(u)}" alt="${escA(alt)}"${cls}>`;
    }
    if (tag === 'br' || tag === 'hr') return '<' + tag + '>';
    const out = [];
    if (tag === 'td' || tag === 'th') { for (const k of ['colspan', 'rowspan']) { const v = attr(a, k); if (v && /^\d{1,2}$/.test(v)) out.push(`${k}="${v}"`); } }
    const c = attr(a, 'class') || '';
    if (/\b(tabular|verbatim|lstlisting|lstinline|center|flushleft|flushright|hline|cline|td11|td00|td01|td10)\b/.test(c)) out.push(`class="${escA(c.split(/\s+/).filter(x => /^[\w-]{1,20}$/.test(x)).join(' '))}"`);
    const st = attr(a, 'style') || ''; const al = /text-align:\s*(left|right|center)/i.exec(st) || /^(left|right|center)$/i.exec(attr(a, 'align') || '');
    if (al) out.push(`style="text-align:${al[1].toLowerCase()}"`);
    return '<' + tag + (out.length ? ' ' + out.join(' ') : '') + '>';
  });
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/<p>\s*<\/p>/g, '').trim();
}
function plain(html) {
  return ent(String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(DROP, '').replace(/<img\b[^>]*>/gi, m => ' ' + (attr(m, 'alt') || '').trim() + ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|pre)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- одна страница темы → задачи ---------- */
function extract(pp) {
  const ql = pp.questionList || {}; const dep = ql.dependencies || {};
  const map = new Map();
  for (const [k, v] of Object.entries(dep.TexSessionsMap || {})) if (v) map.set(String(v.Id || k), v);
  for (const v of Object.values(dep.TexSessions || {})) if (v && v.Id && !map.has(String(v.Id))) map.set(String(v.Id), v);
  const tex = id => { const v = id ? map.get(String(id)) : null; return v ? v.Html || '' : ''; };
  const out = [];
  for (const q of ql.questions || []) {
    if (!q || q.IsDeactivated || q.IsPrivate) continue;
    const qs = q.QuestionTexSessionId, ss = q.SolutionTexSessionId;
    const qh = tex(qs); if (!qh) continue;
    let ans = ''; const A = q.Answer;
    if (A && typeof A === 'object') ans = String(A.text || '').trim() || (A.TexSessionId ? plain(tex(A.TexSessionId)) : '');
    else if (typeof A === 'string') ans = A.trim();
    const files = [];
    for (const f of [].concat(q.QuestionFiles || [], q.Files || [])) {
      if (!f || typeof f !== 'object') continue;
      const name = f.OriginalFilename || f.Name || f.FileName || f.Filename || f.Title || '';
      let src = f.LocationOriginalSrc || f.Src || f.Url || f.Link || f.Path || f.Location || '';
      if (!src && f.File && typeof f.File === 'object') src = f.File.LocationOriginalSrc || f.File.Src || f.File.Url || '';
      const u = src ? imgUrl(src, qs) : null; if (u) files.push({ name: String(name || src.split('/').pop()).slice(0, 120), url: u });
    }
    out.push({ qid: q.Id, name: String(q.Name || '').trim(), qs, html: clean(qh, qs), sol: ss ? clean(tex(ss), ss) : '', ans: ans.slice(0, 200),
      proof: !!q.AnswerIsProof || q.AnswerTypeId === 2 || q.AnswerTypeId === '2', files, diff: q.DifficultyId || 0 });
  }
  return out;
}

/* ---------- обход предмета ---------- */
async function crawl(exam) {
  const sid = SUBJECTS[exam]; const sp = await page('/catalog?SubjectId=' + sid);
  if (!sp) throw new Error('нет каталога предмета ' + sid);
  const parents = new Map(); for (const t of [].concat(sp.firstColumn || [], sp.secondColumn || [])) parents.set(t.Id, t);
  const numOf = t => { const ok = n => n >= 1 && n <= MAXNUM[exam]; if (ok(+t.ExamPosition)) return +t.ExamPosition; const p = parents.get(t.ParentId);
    if (p) { if (ok(+p.ExamPosition)) return +p.ExamPosition; const m = /^(\d{1,2})\s*[.)]/.exec(p.Name || ''); if (m && ok(+m[1])) return +m[1]; } return 0; };
  let themes = (sp.themeList || []).filter(t => !t.IsHidden && !t.IsDeactivated).map(t => ({ id: t.Id, name: t.Name, parent: (parents.get(t.ParentId) || {}).Name || '', num: numOf(t) })).filter(t => t.num);
  // сначала тематические подборки, потом «задачи из прошлых лет» — так у задачи остаётся осмысленный тип
  themes.sort((a, b) => (/прошлых лет|СтатГрад|ФИПИ|ЕГКР|вариант/i.test(a.name) - /прошлых лет|СтатГрад|ФИПИ|ЕГКР|вариант/i.test(b.name)) || a.num - b.num);
  log(exam + ': тем', themes.length);
  const st = path.join(DIR, 'param.json'); let PP = null; try { PP = JSON.parse(fs.readFileSync(st, 'utf8')).p; } catch (e) {}
  let done = 0;
  for (const th of themes) {
    const f = path.join(RAW, exam + '-' + th.id + '.json');
    if (fs.existsSync(f)) { done++; continue; }
    const first = await page('/catalog/' + th.id); if (!first) { fs.writeFileSync(f, '[]'); continue; }
    let qs = extract(first); const pg = first.pagination || {}; const pages = Math.min(+pg.TotalPages || 1, 400);
    for (let n = 2; n <= pages; n++) {
      if (!PP) { // какой параметр отвечает за номер страницы — определяем один раз
        for (const c of ['page', 'Page', 'p', 'pageNumber']) { const t = await page(`/catalog/${th.id}?${c}=2`); if (t && t.pagination && +t.pagination.Page === 2) { PP = c; fs.writeFileSync(st, JSON.stringify({ p: c })); break; } }
        if (!PP) { log('не нашёл, как листать страницы; беру только первые страницы тем'); PP = '-'; }
      }
      if (PP === '-') break;
      const t = await page(`/catalog/${th.id}?${PP}=${n}`); if (!t) break; qs = qs.concat(extract(t));
    }
    fs.writeFileSync(f + '.tmp', JSON.stringify({ theme: th, qs })); fs.renameSync(f + '.tmp', f);
    done++; log(`${exam} ${done}/${themes.length}  №${th.num} ${th.name} — ${qs.length} задач`);
  }
  return themes;
}

/* ---------- сборка набора ---------- */
const VAR = /(досрок|демо|основн|резерв|пробн|статград|егкр|апробац|волна|ЕГЭ|ОГЭ|вариант)/i;
function build(exam, themes) {
  const seen = new Map();
  for (const th of themes) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(RAW, exam + '-' + th.id + '.json'), 'utf8')); } catch (e) { continue; }
    if (!d || !Array.isArray(d.qs)) continue;
    const sub = String(th.name || '').replace(/^Задач[аи]\s*№\s*\d+\s*/i, '').replace(/^\d+(\.\d+)?\s*/, '').trim();
    for (const q of d.qs) {
      if (seen.has(q.qid)) continue;
      const kind = q.proof || !q.ans ? 'photo' : 'short';
      const t = { id: 'sk-' + q.qid, exam, num: String(th.num), kind, text: plain(q.html).slice(0, 3000), html: q.html, ans: kind === 'photo' ? q.ans : q.ans,
        src: 'Школково' + (q.name ? ' · ' + q.name : ''), sub: sub ? sub[0].toUpperCase() + sub.slice(1) : '', img: false };
      if (q.sol) t.solh = q.sol;
      if (q.files && q.files.length) t.files = q.files;
      if (q.name && VAR.test(q.name) && q.name.length < 80) t.var = q.name;
      seen.set(q.qid, t);
    }
  }
  const tasks = [...seen.values()];
  const f = path.join(PACK_DIR, exam + '.shkolkovo.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify({ v: 1, name: 'Школково', made: new Date().toISOString().slice(0, 10), tasks })); fs.renameSync(f + '.tmp', f);
  log(`${exam}: в базу записано ${tasks.length} задач → ${f}`);
  return tasks.length;
}

module.exports = { clean, plain, extract };
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  if (args[0] === 'probe') { const pp = await page('/catalog/' + (args[1] || 12988)); const qs = extract(pp); console.log(JSON.stringify({ pagination: pp.pagination, n: qs.length, first: qs[0] }, null, 1).slice(0, 4000)); return; }
  const exams = args.length ? args.filter(a => SUBJECTS[a]) : Object.keys(SUBJECTS);
  let total = 0;
  for (const ex of exams) { try { const th = await crawl(ex); total += build(ex, th); } catch (e) { log('ошибка', ex, e.message); } }
  log('готово, всего задач:', total);
})().catch(e => { log('ошибка', e.stack || e.message); process.exit(1); });
