'use strict';
/*
 * Back end + admin panel for the Shrey Rastogi Design portfolio.
 * Zero dependencies: Node >= 22.13 (built-in http, crypto and node:sqlite).
 *
 * Env:
 *   PORT              default 3000
 *   DATA_DIR          default ./data  (SQLite file + uploads live here: mount a persistent disk in production)
 *   ADMIN_PASSWORD    optional: starting password (default 82sunset54). The starting login is rastogishrey1996@gmail.com.
 *                     Changing the email or password later needs an OTP mailed to the address linked at that moment.
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM   mail account used to send that OTP (port 465 = TLS, else STARTTLS)
 *   ALLOWED_ORIGINS   comma-separated site origins allowed to call the public API, e.g. https://shreyrastogi.design
 *                     (default "*" for reading content; inquiries are accepted from listed origins only when set)
 *   COOKIE_SECURE     "1" to force Secure cookies (auto-on when behind https via x-forwarded-proto)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ALLOWED = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'portfolio.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, sort INTEGER DEFAULT 0, published INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS works (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL, label TEXT DEFAULT '', image TEXT NOT NULL, sort INTEGER DEFAULT 0, published INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, service TEXT DEFAULT '', business TEXT DEFAULT '', whatsapp TEXT DEFAULT '',
  size TEXT DEFAULT '', quality TEXT DEFAULT '', needed_by TEXT DEFAULT '', message TEXT NOT NULL, status TEXT DEFAULT 'new', note TEXT DEFAULT '', created_at INTEGER);
CREATE TABLE IF NOT EXISTS testimonials (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT DEFAULT '', quote TEXT NOT NULL, sort INTEGER DEFAULT 0, published INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS faqs (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, answer TEXT NOT NULL, sort INTEGER DEFAULT 0, published INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS grievances (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact TEXT DEFAULT '', project TEXT DEFAULT '', issue TEXT NOT NULL, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'open', resolution TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS hits (day TEXT PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS visitors (day TEXT NOT NULL, vid TEXT NOT NULL, PRIMARY KEY (day, vid));
CREATE TABLE IF NOT EXISTS visit_dims (day TEXT NOT NULL, dim TEXT NOT NULL, val TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, dim, val));
CREATE TABLE IF NOT EXISTS section_stats (day TEXT NOT NULL, section TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, reached INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, section));
CREATE TABLE IF NOT EXISTS actions (day TEXT NOT NULL, action TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, action));
CREATE TABLE IF NOT EXISTS totals (day TEXT PRIMARY KEY, seconds INTEGER NOT NULL DEFAULT 0, scroll_sum INTEGER NOT NULL DEFAULT 0, firsts INTEGER NOT NULL DEFAULT 0, bounces INTEGER NOT NULL DEFAULT 0);
`);
/* numbers typed in by hand for each social profile (these networks do not share them with this panel) */
const SOCIAL = {
  instagram: ['followers', 'following', 'posts', 'avgLikes', 'profileVisits', 'women', 'men', 'age13_17', 'age18_24', 'age25_34', 'age35_44', 'age45_54', 'age55_64', 'age65'],
  facebook: ['pageFollowers', 'pageLikes', 'posts', 'reach', 'women', 'men', 'age13_17', 'age18_24', 'age25_34', 'age35_44', 'age45_54', 'age55_64', 'age65'],
  fiverr: ['orders', 'rating', 'reviews', 'impressions', 'clicks'],
  linkedin: ['followers', 'connections', 'profileViews', 'postImpressions', 'searchAppearances'],
};
const PANEL_IDS = ['music', 'work', 'brands', 'photo', 'composition', 'services', 'hire', 'about', 'feedback', 'faq', 'contact']; /* sections of the website that can be hidden */
const WORK_CATS = ['logo', 'social', 'brochure', 'banner', 'other', 'branding', 'editing', 'composition'];
const DEFAULT_RESUME = { fileUrl: '', fileName: '', size: '', updated: 0, label: 'Resume', summary: '', visible: true };

/* ---------- helpers ---------- */
const now = () => Date.now();
const json = (res, code, body, extra = {}) => {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(data);
};
const fail = (res, code, msg, extra) => json(res, code, { error: msg }, extra);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const parseCookies = h => Object.fromEntries((h || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const ip = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
const isUrl = v => !v || /^https?:\/\/[^\s]+$/i.test(v) || /^\/uploads\/[\w.-]+$/.test(v);

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Payload too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

/* tiny in-memory rate limiter */
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = now(); const b = (buckets.get(key) || []).filter(x => t - x < windowMs);
  if (b.length >= max) { buckets.set(key, b); return true; }
  b.push(t); buckets.set(key, b); return false;
}
setInterval(() => { const t = now(); for (const [k, v] of buckets) if (!v.length || t - v[v.length - 1] > 3600e3) buckets.delete(k); db.prepare('DELETE FROM sessions WHERE expires < ?').run(t); }, 10 * 60e3).unref();

/* ---------- owner email + OTP mail ---------- */
const OWNER_EMAIL = 'rastogishrey1996@gmail.com';
/* minimal SMTP client (no dependencies): port 465 = implicit TLS, anything else = STARTTLS */
function sendMail(to, subject, text) {
  const host = process.env.SMTP_HOST, port = Number(process.env.SMTP_PORT || 465), user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return Promise.reject(new Error('NO_SMTP'));
  const from = process.env.SMTP_FROM || user, clean = v => String(v).replace(/[\r\n]/g, ' ');
  const addr = clean(from).replace(/^.*<|>.*$/g, '');
  return new Promise((resolve, reject) => {
    let sock, buf = '', done = false, i = -1;
    const finish = e => { if (done) return; done = true; try { sock.destroy(); } catch {} e ? reject(e) : resolve(); };
    const send = l => sock.write(l + '\r\n');
    const upgrade = () => { buf = ''; sock.removeAllListeners('data'); sock = tls.connect({ socket: sock, servername: host }); attach(); };
    const cmds = [['EHLO portfolio', 250],
      ...(port === 465 ? [] : [['STARTTLS', 220, upgrade], ['EHLO portfolio', 250]]),
      ['AUTH LOGIN', 334], [Buffer.from(user).toString('base64'), 334], [Buffer.from(pass).toString('base64'), 235],
      ['MAIL FROM:<' + addr + '>', 250], ['RCPT TO:<' + clean(to) + '>', 250], ['DATA', 354],
      ['From: ' + clean(from) + '\r\nTo: ' + clean(to) + '\r\nSubject: ' + clean(subject) + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + text.replace(/^\./gm, '..') + '\r\n.', 250]];
    function attach() {
      sock.setTimeout(15000, () => finish(new Error('Mail server timed out')));
      sock.on('error', finish);
      sock.on('data', d => {
        buf += d; const lines = buf.split('\r\n'); const last = lines[lines.length - 2];
        if (lines.length < 2 || !/^\d{3} /.test(last)) return; buf = '';
        const code = Number(last.slice(0, 3)), want = i < 0 ? 220 : cmds[i][1];
        if (code !== want) return finish(new Error('Mail server said: ' + last.slice(0, 120)));
        if (i >= 0 && cmds[i][2]) cmds[i][2]();
        i++; if (i === cmds.length) { send('QUIT'); return finish(); }
        if (!(i > 0 && cmds[i - 1][2])) send(cmds[i][0]); else send(cmds[i][0]);
      });
    }
    sock = port === 465 ? tls.connect(port, host, { servername: host }) : net.connect(port, host);
    attach();
  });
}
/* captcha: a distorted 5 character image made here, no outside service. One use, 5 minutes. */
const GLYPH = {"A": "01110 10001 10001 11111 10001 10001 10001", "B": "11110 10001 10001 11110 10001 10001 11110", "C": "01110 10001 10000 10000 10000 10001 01110", "D": "11110 10001 10001 10001 10001 10001 11110", "E": "11111 10000 10000 11110 10000 10000 11111", "F": "11111 10000 10000 11110 10000 10000 10000", "G": "01110 10001 10000 10111 10001 10001 01111", "H": "10001 10001 10001 11111 10001 10001 10001", "J": "00111 00010 00010 00010 00010 10010 01100", "K": "10001 10010 10100 11000 10100 10010 10001", "L": "10000 10000 10000 10000 10000 10000 11111", "M": "10001 11011 10101 10101 10001 10001 10001", "N": "10001 11001 10101 10011 10001 10001 10001", "P": "11110 10001 10001 11110 10000 10000 10000", "Q": "01110 10001 10001 10001 10101 10010 01101", "R": "11110 10001 10001 11110 10100 10010 10001", "S": "01111 10000 10000 01110 00001 00001 11110", "T": "11111 00100 00100 00100 00100 00100 00100", "U": "10001 10001 10001 10001 10001 10001 01110", "V": "10001 10001 10001 10001 10001 01010 00100", "W": "10001 10001 10001 10101 10101 11011 10001", "X": "10001 10001 01010 00100 01010 10001 10001", "Y": "10001 10001 01010 00100 00100 00100 00100", "Z": "11111 00001 00010 00100 01000 10000 11111", "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11110 00001 00001 01110 00001 00001 11110", "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110", "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000", "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100"};
const captchas = new Map();
function newCaptcha() {
  const t = now(); for (const [k, v] of captchas) if (v.exp < t) captchas.delete(k);
  if (captchas.size > 800) captchas.clear();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', id = crypto.randomBytes(12).toString('base64url');
  const code = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  const r = n => crypto.randomInt(n), cols = ['#4F3BFF', '#FF4FA3', '#12B886', '#FF5A36', '#14102E'];
  let g = '';
  for (let k = 0; k < 6; k++) g += `<path d="M${r(190)} ${r(64)} Q${r(190)} ${r(64)} ${r(190)} ${r(64)}" stroke="${cols[r(5)]}" stroke-width="${1 + r(2)}" fill="none" opacity=".35"/>`;
  /* the characters are drawn as small squares (a 5 x 7 grid each), never as text, so the answer is not in the file */
  for (let k = 0; k < 5; k++) {
    const sz = 4 + r(8) / 10, col = cols[r(5)], rows = GLYPH[code[k]].split(' ');
    let sq = '';
    rows.forEach((row, y) => { for (let x = 0; x < 5; x++) if (row[x] === '1') sq += `<rect x="${(x * (sz + .6)).toFixed(1)}" y="${(y * (sz + .6)).toFixed(1)}" width="${sz.toFixed(1)}" height="${sz.toFixed(1)}" rx="1"/>`; });
    g += `<g fill="${col}" transform="translate(${14 + k * 34 + r(4)} ${8 + r(8)}) rotate(${r(16) - 8})">${sq}</g>`;
  }
  for (let k = 0; k < 4; k++) g += `<path d="M${r(190)} ${r(64)} L${r(190)} ${r(64)}" stroke="${cols[r(5)]}" stroke-width="1.5" opacity=".4"/>`;
  captchas.set(id, { code: code.toLowerCase(), exp: t + 5 * 60e3, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 190 64" width="190" height="64"><rect width="190" height="64" rx="12" fill="#F7F6FF"/>${g}</svg>` });
  return id;
}
function captchaOk(b) {
  const e = captchas.get(String(b.captchaId || '')); captchas.delete(String(b.captchaId || ''));
  return !!e && e.exp > now() && safeEq(String(b.captcha || '').trim().toLowerCase(), e.code);
}
const otpState = { hash: '', exp: 0, tries: 0 };

/* ---------- first-run admin: starting login is the owner email with the starting password ---------- */
const START_PASSWORD = process.env.ADMIN_PASSWORD || '82sunset54';
if (!db.prepare('SELECT 1 FROM admin').get()) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO admin (id, email, salt, hash) VALUES (1, ?, ?, ?)').run(OWNER_EMAIL, salt, hashPw(START_PASSWORD, salt));
  console.log('\n  Admin account created.\n  Email:    ' + OWNER_EMAIL + '\n  Password: the starting password (change it in Account)\n');
}
/* ---------- auth ---------- */
function sessionOk(req) {
  const t = parseCookies(req.headers.cookie).sid;
  if (!t) return null;
  const row = db.prepare('SELECT token, expires FROM sessions WHERE token = ?').get(t);
  if (!row || row.expires < now()) return null;
  return row.token;
}
function csrfOk(req) {
  if (req.headers['x-requested-with'] !== 'admin-panel') return false;
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; } }
  return true;
}

/* ---------- row mappers ---------- */
const safeJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const DEFAULT_LOOK = { style: 'normal', theme: 'light' };
const LOOK_STYLES = ['normal', 'neu', 'clay'], LOOK_THEMES = ['light', 'dark'];
const getSetting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? { ...d, ...safeJson(r.value, {}) } : { ...d }; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
/* one time: the starting login (owner email + starting password) on every database that did not have it yet */
if (!getSetting('owner', {}).seeded) { const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE admin SET email=?, salt=?, hash=? WHERE id=1').run(OWNER_EMAIL, salt, hashPw(START_PASSWORD, salt)); setSetting('owner', { seeded: true }); }
function ytId(u) {
  try {
    const x = new URL(String(u).trim()); const host = x.hostname.replace(/^(www|m|music)\./, ''); let id = '';
    if (host === 'youtu.be') id = x.pathname.slice(1);
    else if (host === 'youtube.com') { if (x.pathname === '/watch') id = x.searchParams.get('v') || ''; else { const m = x.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/); id = m ? m[1] : ''; } }
    return /^[\w-]{11}$/.test(id) ? id : '';
  } catch { return ''; }
}
function transaction(fn) { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
const deviceOf = ua => /ipad|tablet/i.test(ua) ? 'Tablet' : /mobi|android|iphone/i.test(ua) ? 'Mobile' : 'Desktop';
const browserOf = ua => /edg\//i.test(ua) ? 'Edge' : /opr\/|opera/i.test(ua) ? 'Opera' : /samsungbrowser/i.test(ua) ? 'Samsung Internet' : /firefox|fxios/i.test(ua) ? 'Firefox' : /chrome|crios/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : 'Other';
const osOf = ua => /windows/i.test(ua) ? 'Windows' : /android/i.test(ua) ? 'Android' : /iphone|ipad|ios/i.test(ua) ? 'iOS' : /mac os x/i.test(ua) ? 'macOS' : /cros/i.test(ua) ? 'ChromeOS' : /linux/i.test(ua) ? 'Linux' : 'Other';
function sourceOf(host, own) {
  host = String(host || '').toLowerCase().replace(/^(www|m|l)\./, '');
  if (!host || host === String(own).toLowerCase().replace(/^www\./, '').split(':')[0]) return 'Direct';
  if (/google|bing|duckduckgo|yahoo|ecosia|brave/.test(host)) return 'Search';
  for (const [re, name] of [[/instagram/, 'Instagram'], [/facebook|fb\.com/, 'Facebook'], [/linkedin|lnkd/, 'LinkedIn'], [/fiverr/, 'Fiverr'], [/youtube|youtu\.be/, 'YouTube'], [/whatsapp|wa\.me/, 'WhatsApp'], [/(^|\.)t\.co$|twitter|x\.com/, 'X / Twitter'], [/pinterest/, 'Pinterest'], [/behance/, 'Behance']]) if (re.test(host)) return name;
  return host.slice(0, 40);
}
const bump = (sql, ...a) => db.prepare(sql).run(...a);
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- CORS for the public API ---------- */
function cors(req, res, write) {
  const origin = req.headers.origin;
  const open = ALLOWED.includes('*');
  if (open && !write) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ALLOWED.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* ---------- routes ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;

  /* public */
  if (p === '/api/public/content' && (m === 'GET' || m === 'OPTIONS')) {
    cors(req, res, false);
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const music = getSetting('music', { enabled: true });
    const tracks = db.prepare('SELECT id,url FROM tracks WHERE published=1 ORDER BY sort, id').all().map(t => ({ id: t.id, url: t.url, vid: ytId(t.url) })).filter(t => t.vid);
    const rs = getSetting('resume', DEFAULT_RESUME);
    const work = Object.fromEntries(WORK_CATS.map(c => [c, db.prepare('SELECT title,label,image FROM works WHERE category=? AND published=1 ORDER BY sort, id').all(c)]));
    return json(res, 200, { online: getSetting('status', { online: true }).online !== false, music: { enabled: music.enabled !== false, tracks }, work, feedbacks: db.prepare('SELECT name,role,quote FROM testimonials WHERE published=1 ORDER BY sort, id').all(), questions: db.prepare('SELECT question q, answer a FROM faqs WHERE published=1 ORDER BY sort, id').all(), resume: rs.visible && rs.fileUrl ? { url: rs.fileUrl, label: rs.label, summary: rs.summary } : null, look: getSetting('look', DEFAULT_LOOK), panelsHidden: (getSetting('panels', { hidden: [] }).hidden || []).filter(x => PANEL_IDS.includes(x)), compare: (cp => cp.before && cp.after ? cp : null)(getSetting('compare', { before: '', after: '' })) }, { 'Cache-Control': 'no-cache' });
  }
  /* website visit counter: one small call per page load. Stores a daily count and a daily anonymous visitor hash, never the address itself. */
  if (p === '/api/public/hit' && (m === 'POST' || m === 'OPTIONS')) {
    cors(req, res, true);
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (limited('hit:' + ip(req), 120, 3600e3)) return json(res, 200, { ok: true });
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || /bot|crawl|spider|slurp|preview|headless/i.test(ua)) return json(res, 200, { ok: true });
    let salt = getSetting('hitsalt', {}).s; if (!salt) { salt = crypto.randomBytes(16).toString('hex'); setSetting('hitsalt', { s: salt }); }
    const day = today(), vid = crypto.createHash('sha256').update(salt + day + ip(req) + ua).digest('hex').slice(0, 20);
    db.prepare('INSERT INTO hits (day, views) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET views = views + 1').run(day);
    db.prepare('INSERT OR IGNORE INTO visitors (day, vid) VALUES (?, ?)').run(day, vid);
    const b = await readBody(req, 2048);
    let refHost = ''; try { refHost = b.ref ? new URL(String(b.ref)).host : ''; } catch {}
    const tz = /^[A-Za-z]+(\/[A-Za-z_+-]+){1,2}$/.test(String(b.tz || '')) ? String(b.tz).slice(0, 50) : '';
    const dim = (d, v) => bump('INSERT INTO visit_dims (day,dim,val,n) VALUES (?,?,?,1) ON CONFLICT(day,dim,val) DO UPDATE SET n=n+1', day, d, v);
    dim('device', deviceOf(ua)); dim('browser', browserOf(ua)); dim('os', osOf(ua)); dim('source', sourceOf(refHost, req.headers.host));
    dim('visit', b.returning ? 'Returning' : 'New'); if (tz) dim('place', tz);
    return json(res, 200, { ok: true });
  }

  /* what a visitor did on the page: time per section, clicks, scroll depth. Sent when the visitor leaves or switches tab. */
  if (p === '/api/public/engage' && (m === 'POST' || m === 'OPTIONS')) {
    cors(req, res, true);
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (limited('eng:' + ip(req), 60, 3600e3)) return json(res, 200, { ok: true });
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || /bot|crawl|spider|slurp|preview|headless/i.test(ua)) return json(res, 200, { ok: true });
    const b = await readBody(req, 8 * 1024), day = today();
    const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
    const entries = o => Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {}).slice(0, 15);
    const ids = {};
    for (const [k, v] of entries(b.sections)) if (/^[a-z][\w-]{0,24}$/.test(k)) (ids[k] = ids[k] || {}).seconds = clamp(v, 1800);
    for (const [k, v] of entries(b.clicks)) if (/^[a-z][\w-]{0,24}$/.test(k)) (ids[k] = ids[k] || {}).clicks = clamp(v, 200);
    const up = db.prepare('INSERT INTO section_stats (day,section,seconds,reached,clicks) VALUES (?,?,?,?,?) ON CONFLICT(day,section) DO UPDATE SET seconds=seconds+excluded.seconds, reached=reached+excluded.reached, clicks=clicks+excluded.clicks');
    for (const [k, v] of Object.entries(ids)) up.run(day, k, v.seconds || 0, b.first && v.seconds ? 1 : 0, v.clicks || 0);
    for (const [k, v] of entries(b.actions)) { const name = str(k, 40); if (/^[\w .&:/+-]{1,40}$/.test(name)) bump('INSERT INTO actions (day,action,n) VALUES (?,?,?) ON CONFLICT(day,action) DO UPDATE SET n=n+excluded.n', day, name, clamp(v, 100) || 1); }
    const secs = clamp(b.seconds, 3600), anyClick = Object.values(ids).some(v => v.clicks);
    bump('INSERT INTO totals (day,seconds,scroll_sum,firsts,bounces) VALUES (?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET seconds=seconds+excluded.seconds, scroll_sum=scroll_sum+excluded.scroll_sum, firsts=firsts+excluded.firsts, bounces=bounces+excluded.bounces',
      day, secs, b.first ? clamp(b.scroll, 100) : 0, b.first ? 1 : 0, b.first && secs < 10 && !anyClick ? 1 : 0);
    return json(res, 200, { ok: true });
  }

  /* project briefs sent from the Hire form on the website */
  if (p === '/api/inquiries' && (m === 'POST' || m === 'OPTIONS')) {
    cors(req, res, true);
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const origin = req.headers.origin;
    let sameHost = false; try { sameHost = !!origin && new URL(origin).host === req.headers.host; } catch {}
    if (!ALLOWED.includes('*') && !sameHost && !(origin && ALLOWED.includes(origin))) return fail(res, 403, 'Origin not allowed');
    if (limited('inq:' + ip(req), 5, 3600e3)) return fail(res, 429, 'Too many messages. Please try again later.');
    const b = await readBody(req, 20 * 1024);
    if (b.website) return json(res, 200, { ok: true }); // honeypot: pretend success
    const name = str(b.name, 100), email = str(b.email, 200), message = str(b.message, 4000);
    if (!name || !message) return fail(res, 400, 'Name and message are required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'A valid email is required');
    db.prepare('INSERT INTO inquiries (name,email,service,message,business,whatsapp,size,quality,needed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(name, email, str(b.service, 100), message, str(b.business, 120), str(b.whatsapp, 40), str(b.size, 80), str(b.quality, 20), str(b.neededBy, 40), now());
    return json(res, 201, { ok: true });
  }

  /* captcha image for the sign in form and the OTP request */
  if (p === '/api/captcha/new' && m === 'POST') {
    if (!csrfOk(req)) return fail(res, 403, 'Bad request');
    if (limited('cap:' + ip(req), 40, 10 * 60e3)) return fail(res, 429, 'Too many tries. Wait a few minutes.');
    const id = newCaptcha();
    return json(res, 200, { id, image: 'data:image/svg+xml;base64,' + Buffer.from(captchas.get(id).svg).toString('base64') }, { 'Cache-Control': 'no-store' });
  }

  /* login */
  if (p === '/api/admin/login' && m === 'POST') {
    if (!csrfOk(req)) return fail(res, 403, 'Bad request');
    if (limited('login:' + ip(req), 5, 15 * 60e3)) return fail(res, 429, 'Too many attempts. Try again in 15 minutes.');
    const b = await readBody(req, 4096);
    if (!captchaOk(b)) return fail(res, 400, 'The captcha is wrong. Try the new one.');
    const a = db.prepare('SELECT * FROM admin WHERE id=1').get();
    const okEmail = safeEq(str(b.email, 200).toLowerCase(), a.email);
    const okPw = safeEq(hashPw(String(b.password || ''), a.salt), a.hash);
    if (!(okEmail && okPw)) return fail(res, 401, 'Wrong email or password');
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token, expires) VALUES (?, ?)').run(token, now() + 7 * 864e5);
    const cookie = `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}` + (isHttps(req) ? '; Secure' : '');
    return json(res, 200, { ok: true, email: a.email }, { 'Set-Cookie': cookie });
  }

  /* everything below needs a session */
  if (!p.startsWith('/api/admin/')) return fail(res, 404, 'Not found');
  const sid = sessionOk(req);
  if (!sid) return fail(res, 401, 'Not signed in');
  if (m !== 'GET' && !csrfOk(req)) return fail(res, 403, 'Bad request');
  const seg = p.split('/').filter(Boolean); // api, admin, resource, id?
  const [, , resource, idRaw] = seg; const id = idRaw ? Number(idRaw) : null;
  if (idRaw && idRaw !== 'counts' && !(resource === 'account' && idRaw === 'otp') && !Number.isInteger(id)) return fail(res, 400, 'Bad id');

  if (resource === 'logout' && m === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token=?').run(sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (resource === 'me' && m === 'GET') return json(res, 200, { email: db.prepare('SELECT email FROM admin WHERE id=1').get().email });

  /* visitor details and engagement for the last 30 days */
  function detail(from) {
    const rows = (sql, ...a) => db.prepare(sql).all(...a);
    const dim = d => rows('SELECT val k, SUM(n) n FROM visit_dims WHERE day >= ? AND dim = ? GROUP BY val ORDER BY n DESC LIMIT 8', from, d);
    const t = db.prepare('SELECT COALESCE(SUM(seconds),0) s, COALESCE(SUM(scroll_sum),0) sc, COALESCE(SUM(firsts),0) f, COALESCE(SUM(bounces),0) b FROM totals WHERE day >= ?').get(from);
    const views = db.prepare('SELECT COALESCE(SUM(views),0) n FROM hits WHERE day >= ?').get(from).n;
    const sections = rows('SELECT section id, SUM(seconds) seconds, SUM(reached) reached, SUM(clicks) clicks FROM section_stats WHERE day >= ? GROUP BY section', from);
    return {
      visitors: { visit: dim('visit'), device: dim('device'), browser: dim('browser'), os: dim('os'), source: dim('source'), place: dim('place') },
      engagement: { avgSeconds: views ? Math.round(t.s / views) : 0, avgScroll: t.f ? Math.round(t.sc / t.f) : 0, bounceRate: t.f ? Math.round(t.b / t.f * 100) : 0 },
      sections: sections.map(x => ({ ...x, avgSeconds: x.reached ? Math.round(x.seconds / x.reached) : 0, reachPct: views ? Math.min(100, Math.round(x.reached / views * 100)) : 0 })),
      actions: rows('SELECT action k, SUM(n) n FROM actions WHERE day >= ? GROUP BY action ORDER BY n DESC LIMIT 10', from),
    };
  }

  if (resource === 'stats' && m === 'GET') {
    const d = new Date(), days = [];
    for (let i = 29; i >= 0; i--) { const x = new Date(d.getTime() - i * 864e5).toISOString().slice(0, 10); days.push(x); }
    const v = new Map(db.prepare('SELECT day, views FROM hits WHERE day >= ?').all(days[0]).map(r => [r.day, r.views]));
    const u = new Map(db.prepare('SELECT day, COUNT(*) n FROM visitors WHERE day >= ? GROUP BY day').all(days[0]).map(r => [r.day, r.n]));
    const series = days.map(day => ({ day, views: v.get(day) || 0, visitors: u.get(day) || 0 }));
    const sum = (a, k) => a.reduce((t, x) => t + x[k], 0);
    return json(res, 200, {
      series, today: series[29], views7: sum(series.slice(-7), 'views'), visitors7: sum(series.slice(-7), 'visitors'),
      views30: sum(series, 'views'), visitors30: sum(series, 'visitors'),
      total: db.prepare('SELECT COALESCE(SUM(views),0) n FROM hits').get().n,
      since: (db.prepare('SELECT MIN(day) d FROM hits').get() || {}).d || null,
      ...detail(days[0]),
    });
  }

  if (resource === 'social') {
    const read = () => Object.fromEntries(Object.keys(SOCIAL).map(k => [k, getSetting('social:' + k, { values: {}, prev: {}, updated: 0 })]));
    if (m === 'GET') return json(res, 200, read());
    if (m === 'PUT') {
      const b = await readBody(req, 8 * 1024);
      const key = str(b.platform, 20);
      if (!SOCIAL[key]) return fail(res, 400, 'Unknown platform');
      const values = {};
      for (const f of SOCIAL[key]) {
        const raw = b.values && b.values[f];
        if (raw === '' || raw == null) { values[f] = null; continue; }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 1e10) return fail(res, 400, 'Numbers only, zero or higher');
        if (f === 'rating' && n > 5) return fail(res, 400, 'Rating is out of 5');
        if ((f === 'women' || f === 'men' || f.startsWith('age')) && n > 100) return fail(res, 400, 'Audience numbers are percentages, 0 to 100');
        values[f] = Math.round(n * 100) / 100;
      }
      const cur = getSetting('social:' + key, { values: {}, updated: 0 });
      setSetting('social:' + key, { values, prev: cur.updated ? cur.values : {}, updated: now(), prevUpdated: cur.updated || 0 });
      return json(res, 200, { ok: true });
    }
  }

  /* changing the email or the password needs a 6 digit OTP mailed to the address linked right now */
  if (resource === 'account' && seg[3] === 'otp' && m === 'POST') {
    const b = await readBody(req, 4096);
    if (!captchaOk(b)) return fail(res, 400, 'The captcha is wrong. Try the new one.');
    if (limited('otp:send', 3, 10 * 60e3)) return fail(res, 429, 'Too many codes requested. Try again in a few minutes.');
    const a = db.prepare('SELECT email FROM admin WHERE id=1').get();
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    try { await sendMail(a.email, 'Your admin verification code', 'Your code to change the admin email or password is ' + code + '. It works for 10 minutes. If you did not ask for it, ignore this mail.'); }
    catch (e) { return fail(res, 503, e.message === 'NO_SMTP' ? 'The server cannot send mail yet. Set SMTP_HOST, SMTP_USER and SMTP_PASS on the server.' : 'Could not send the code: ' + e.message); }
    Object.assign(otpState, { hash: crypto.createHash('sha256').update(code).digest('hex'), exp: now() + 10 * 60e3, tries: 0 });
    return json(res, 200, { ok: true, sentTo: a.email.replace(/^(.).*(@.*)$/, '$1***$2') });
  }
  if (resource === 'account' && m === 'PUT') {
    const b = await readBody(req, 4096);
    const a = db.prepare('SELECT * FROM admin WHERE id=1').get();
    if (!safeEq(hashPw(String(b.currentPassword || ''), a.salt), a.hash)) return fail(res, 403, 'Current password is wrong');
    const newEmail = str(b.email, 200).toLowerCase(), wantEmail = !!newEmail && newEmail !== a.email, wantPw = !!b.newPassword;
    if (!wantEmail && !wantPw) return json(res, 200, { ok: true });
    if (wantEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return fail(res, 400, 'Invalid email');
    if (wantPw && String(b.newPassword).length < 10) return fail(res, 400, 'New password must be at least 10 characters');
    if (!otpState.hash || now() > otpState.exp) return fail(res, 400, 'Ask for a code first. It is mailed to ' + a.email.replace(/^(.).*(@.*)$/, '$1***$2') + '.');
    if (++otpState.tries > 5) { otpState.hash = ''; return fail(res, 429, 'Too many wrong codes. Ask for a new one.'); }
    if (!safeEq(crypto.createHash('sha256').update(String(b.otp || '').trim()).digest('hex'), otpState.hash)) return fail(res, 403, 'That code is wrong');
    otpState.hash = '';
    let salt = a.salt, hash = a.hash;
    if (wantPw) { salt = crypto.randomBytes(16).toString('hex'); hash = hashPw(String(b.newPassword), salt); }
    db.prepare('UPDATE admin SET email=?, salt=?, hash=? WHERE id=1').run(wantEmail ? newEmail : a.email, salt, hash);
    db.prepare('DELETE FROM sessions WHERE token != ?').run(sid); // sign out other devices
    return json(res, 200, { ok: true });
  }

  /* music: the whole playlist is saved at once */
  if (resource === 'music') {
    if (m === 'GET') return json(res, 200, { enabled: getSetting('music', { enabled: true }).enabled !== false, tracks: db.prepare('SELECT id,url,published FROM tracks ORDER BY sort, id').all().map(t => ({ ...t, published: !!t.published })) });
    if (m === 'PUT') {
      const b = await readBody(req, 64 * 1024);
      if (!Array.isArray(b.tracks) || b.tracks.length > 50) return fail(res, 400, 'Tracks must be a list of up to 50 links');
      const clean = [];
      for (const t of b.tracks) { const id = ytId(t && t.url); if (!id) return fail(res, 400, 'One of the links is not a valid YouTube video link'); clean.push({ url: 'https://www.youtube.com/watch?v=' + id, published: t.published === false ? 0 : 1 }); }
      transaction(() => {
        db.exec('DELETE FROM tracks');
        const ins = db.prepare('INSERT INTO tracks (url,sort,published) VALUES (?,?,?)');
        clean.forEach((t, i) => ins.run(t.url, i, t.published));
        setSetting('music', { enabled: b.enabled !== false });
      });
      return json(res, 200, { ok: true });
    }
  }

  /* panels: which sections of the website are hidden */
  if (resource === 'panels') {
    if (m === 'GET') return json(res, 200, { hidden: (getSetting('panels', { hidden: [] }).hidden || []).filter(x => PANEL_IDS.includes(x)) });
    if (m === 'PUT') {
      const b = await readBody(req, 4096);
      if (!Array.isArray(b.hidden) || b.hidden.some(x => !PANEL_IDS.includes(x))) return fail(res, 400, 'Unknown panel');
      setSetting('panels', { hidden: [...new Set(b.hidden)] });
      return json(res, 200, { ok: true });
    }
  }

  /* compare: the Before / After pictures for the slider in "Image composition skills" on the website */
  if (resource === 'compare') {
    if (m === 'GET') return json(res, 200, getSetting('compare', { before: '', after: '' }));
    if (m === 'PUT') {
      const b = await readBody(req, 4096), out = {};
      for (const k of ['before', 'after']) {
        const v = str(b[k], 200);
        if (v && (!/^\/uploads\/[\w.-]+\.(png|jpe?g|webp|gif)$/.test(v) || !fs.existsSync(path.join(UPLOAD_DIR, path.basename(v))))) return fail(res, 400, 'Upload the ' + k + ' image first');
        out[k] = v;
      }
      if (!!out.before !== !!out.after) return fail(res, 400, 'Add both a Before and an After image, or remove both to show the sample slider');
      setSetting('compare', out);
      return json(res, 200, { ok: true });
    }
  }

  /* work: the pieces shown in one category of the Work section. Each category is saved as a whole list. */
  if (resource === 'work') {
    const cat = str(m === 'GET' ? url.searchParams.get('category') : null, 20);
    if (m === 'GET') {
      if (!WORK_CATS.includes(cat)) return fail(res, 400, 'Unknown category');
      return json(res, 200, db.prepare('SELECT id,title,label,image,published FROM works WHERE category=? ORDER BY sort, id').all(cat).map(w => ({ ...w, published: !!w.published })));
    }
    if (m === 'PUT') {
      const b = await readBody(req, 64 * 1024), c = str(b.category, 20);
      if (!WORK_CATS.includes(c)) return fail(res, 400, 'Unknown category');
      if (!Array.isArray(b.items) || b.items.length > 60) return fail(res, 400, 'A category holds up to 60 pieces');
      const rows = [];
      for (const x of b.items) {
        const title = str(x && x.title, 80), image = str(x && x.image, 200);
        if (!title) return fail(res, 400, 'Every piece needs a title');
        if (!/^\/uploads\/[\w.-]+\.(png|jpe?g|webp|gif)$/.test(image) || !fs.existsSync(path.join(UPLOAD_DIR, path.basename(image)))) return fail(res, 400, 'Every piece needs an uploaded image');
        rows.push({ title, label: str(x.label, 80), image, published: x.published === false ? 0 : 1 });
      }
      transaction(() => {
        db.prepare('DELETE FROM works WHERE category=?').run(c);
        const ins = db.prepare('INSERT INTO works (category,title,label,image,sort,published) VALUES (?,?,?,?,?,?)');
        rows.forEach((r, i) => ins.run(c, r.title, r.label, r.image, i, r.published));
      });
      return json(res, 200, { ok: true });
    }
  }

  /* client feedback: the Feedbacks (testimonials) and Questions (FAQ) lists. Each is saved as a whole list. */
  const LISTS = {
    feedbacks: { table: 'testimonials', cols: [['name', 100, true], ['role', 100, false], ['quote', 1000, true]], need: 'Every feedback needs a name and a quote', max: 60 },
    questions: { table: 'faqs', cols: [['question', 200, true], ['answer', 2000, true]], need: 'Every question needs an answer', max: 60 },
  };
  if (LISTS[resource]) {
    const L = LISTS[resource];
    if (m === 'GET') return json(res, 200, db.prepare('SELECT * FROM ' + L.table + ' ORDER BY sort, id').all().map(r => { const o = { published: !!r.published }; for (const [c] of L.cols) o[c] = r[c]; return o; }));
    if (m === 'PUT') {
      const b = await readBody(req, 128 * 1024);
      if (!Array.isArray(b.items) || b.items.length > L.max) return fail(res, 400, 'A list holds up to ' + L.max + ' items');
      const rows = [];
      for (const x of b.items) {
        const r = { published: x && x.published === false ? 0 : 1 };
        for (const [c, max, req_] of L.cols) { r[c] = str(x && x[c], max); if (req_ && !r[c]) return fail(res, 400, L.need); }
        rows.push(r);
      }
      transaction(() => {
        db.exec('DELETE FROM ' + L.table);
        const names = L.cols.map(c => c[0]).concat(['sort', 'published']);
        const ins = db.prepare('INSERT INTO ' + L.table + ' (' + names.join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')');
        rows.forEach((r, i) => ins.run(...L.cols.map(c => r[c[0]]), i, r.published));
      });
      return json(res, 200, { ok: true });
    }
  }

  /* business moderation: client grievances you log and track. Saved as a whole list; never shown on the website. */
  if (resource === 'grievances') {
    if (m === 'GET') return json(res, 200, db.prepare('SELECT name,contact,project,issue,priority,status,resolution,created_at FROM grievances ORDER BY created_at DESC, id DESC').all());
    if (m === 'PUT') {
      const b = await readBody(req, 256 * 1024);
      if (!Array.isArray(b.items) || b.items.length > 500) return fail(res, 400, 'A list holds up to 500 grievances');
      const rows = [];
      for (const x of b.items) {
        const name = str(x && x.name, 100), issue = str(x && x.issue, 3000);
        if (!name || !issue) return fail(res, 400, 'Every grievance needs a client name and the issue');
        const priority = ['low', 'medium', 'high'].includes(x.priority) ? x.priority : 'medium';
        const status = ['open', 'progress', 'resolved', 'closed'].includes(x.status) ? x.status : 'open';
        const created = Number.isFinite(Number(x.created_at)) && Number(x.created_at) > 0 ? Number(x.created_at) : now();
        rows.push({ name, contact: str(x.contact, 200), project: str(x.project, 120), issue, priority, status, resolution: str(x.resolution, 3000), created });
      }
      transaction(() => {
        db.exec('DELETE FROM grievances');
        const ins = db.prepare('INSERT INTO grievances (name,contact,project,issue,priority,status,resolution,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
        rows.forEach(r => ins.run(r.name, r.contact, r.project, r.issue, r.priority, r.status, r.resolution, r.created, now()));
      });
      return json(res, 200, { ok: true });
    }
  }

  /* default look of the website for every visitor: style (normal / neu / clay) and theme (light / dark) */
  if (resource === 'look') {
    if (m === 'GET') return json(res, 200, getSetting('look', DEFAULT_LOOK));
    if (m === 'PUT') {
      const b = await readBody(req, 1024), cur = getSetting('look', DEFAULT_LOOK), next = { ...cur };
      if (b.style !== undefined) { if (!LOOK_STYLES.includes(b.style)) return json(res, 400, { error: 'Unknown style' }); next.style = b.style; }
      if (b.theme !== undefined) { if (!LOOK_THEMES.includes(b.theme)) return json(res, 400, { error: 'Unknown theme' }); next.theme = b.theme; }
      setSetting('look', next); return json(res, 200, next);
    }
  }

  /* availability status: online shows "Taking new projects" in the hero of the website, offline shows "Not taking new projects" */
  if (resource === 'status') {
    if (m === 'GET') return json(res, 200, { online: getSetting('status', { online: true }).online !== false });
    if (m === 'PUT') { const b = await readBody(req, 1024); setSetting('status', { online: b.online !== false }); return json(res, 200, { online: b.online !== false }); }
  }

  /* resume */
  if (resource === 'resume') {
    if (m === 'GET') return json(res, 200, getSetting('resume', DEFAULT_RESUME));
    if (m === 'PUT') {
      const b = await readBody(req, 8 * 1024);
      const cur = getSetting('resume', DEFAULT_RESUME);
      const next = { ...cur, label: str(b.label, 40) || 'Resume', summary: str(b.summary, 400), visible: b.visible !== false };
      if (b.removeFile) Object.assign(next, { fileUrl: '', fileName: '', size: '', updated: 0 });
      else if (b.fileUrl && b.fileUrl !== cur.fileUrl) {
        if (!/^\/uploads\/[\w.-]+\.pdf$/.test(b.fileUrl) || !fs.existsSync(path.join(UPLOAD_DIR, path.basename(b.fileUrl)))) return fail(res, 400, 'Upload a PDF first');
        Object.assign(next, { fileUrl: b.fileUrl, fileName: str(b.fileName, 120), size: str(b.size, 20), updated: now() });
      }
      setSetting('resume', next);
      return json(res, 200, next);
    }
  }

  /* project briefs */
  if (resource === 'inquiries') {
    if (m === 'GET' && idRaw === 'counts') return json(res, 200, { new: db.prepare("SELECT service FROM inquiries WHERE status='new'").all().map(r => r.service), openGrievances: db.prepare("SELECT COUNT(*) n FROM grievances WHERE status IN ('open','progress')").get().n });
    if (m === 'GET' && !id) return json(res, 200, db.prepare('SELECT * FROM inquiries ORDER BY id DESC').all());
    if (m === 'PUT' && id) {
      const b = await readBody(req, 8 * 1024);
      const status = str(b.status, 20);
      if (!['new', 'replied', 'won', 'archived'].includes(status)) return fail(res, 400, 'Bad status');
      const r = db.prepare('UPDATE inquiries SET status=?, note=? WHERE id=?').run(status, str(b.note, 1000), id);
      return r.changes ? json(res, 200, { ok: true }) : fail(res, 404, 'Not found');
    }
    if (m === 'DELETE' && id) { db.prepare('DELETE FROM inquiries WHERE id=?').run(id); return json(res, 200, { ok: true }); }
  }

  /* upload: JSON { dataUrl }. Images up to 5 MB, PDF up to 10 MB. Type is checked by file signature. */
  if (resource === 'upload' && m === 'POST') {
    const b = await readBody(req, 15 * 1024 * 1024);
    const mt = /^data:(image\/(?:png|jpeg|webp|gif)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''));
    if (!mt) return fail(res, 400, 'Upload a PDF or a PNG, JPG, WebP or GIF image');
    const kind = mt[1] === 'application/pdf' ? 'pdf' : mt[1].split('/')[1];
    const buf = Buffer.from(mt[2], 'base64');
    if (buf.length > (kind === 'pdf' ? 10 : 5) * 1024 * 1024) return fail(res, 413, kind === 'pdf' ? 'PDF is larger than 10 MB' : 'Image is larger than 5 MB');
    const magic = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46], webp: [0x52, 0x49, 0x46, 0x46], pdf: [0x25, 0x50, 0x44, 0x46] }[kind];
    if (!magic.every((x, i) => buf[i] === x)) return fail(res, 400, 'File content does not match its type');
    const name = crypto.randomBytes(12).toString('hex') + '.' + (kind === 'jpeg' ? 'jpg' : kind);
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return json(res, 201, { url: '/uploads/' + name, size: Math.max(1, Math.round(buf.length / 1024)) + ' KB' });
  }

  return fail(res, 404, 'Not found');
}

/* ---------- static files ---------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  let base = PUBLIC_DIR;
  if (rel.startsWith('/uploads/')) { base = UPLOAD_DIR; rel = rel.slice('/uploads'.length); }
  else if (rel === '/admin') { res.writeHead(302, { Location: '/admin/' }); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': base === UPLOAD_DIR ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(base === UPLOAD_DIR && ext === '.pdf' ? { 'Content-Disposition': 'inline' } : {}),
    });
    res.end(buf);
  });
}

/* ---------- server ---------- */
const ADMIN_CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const SITE_CSP = "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'";
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Content-Security-Policy', url.pathname.startsWith('/admin') ? ADMIN_CSP : SITE_CSP);
    if (url.searchParams.get('preview') === '1' && !url.pathname.startsWith('/admin') && !url.pathname.startsWith('/api/')) { res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Content-Security-Policy', SITE_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'")); } /* lets the admin panel show a live preview of the website */
    if (url.pathname.startsWith('/uploads/')) { res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Content-Security-Policy', "frame-ancestors 'self'"); } /* lets the admin panel preview the resume PDF */
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  } catch (e) {
    if (e && e.code === 413) return fail(res, 413, 'Too large');
    if (e && e.code === 400) return fail(res, 400, e.message);
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'Server error');
  }
});
server.listen(PORT, () => console.log(`Website: http://localhost:${PORT}/   Admin: http://localhost:${PORT}/admin/`));
