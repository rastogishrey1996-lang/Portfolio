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
const zlib = require('node:zlib');
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
try { db.exec("ALTER TABLE works ADD COLUMN file TEXT DEFAULT ''"); } catch {} /* Branding pieces carry a PDF */
/* numbers typed in by hand for each social profile (these networks do not share them with this panel) */
const SOCIAL = {
  instagram: ['followers', 'following', 'posts', 'avgLikes', 'profileVisits', 'women', 'men', 'age13_17', 'age18_24', 'age25_34', 'age35_44', 'age45_54', 'age55_64', 'age65'],
  facebook: ['pageFollowers', 'pageLikes', 'posts', 'reach', 'women', 'men', 'age13_17', 'age18_24', 'age25_34', 'age35_44', 'age45_54', 'age55_64', 'age65'],
  fiverr: ['orders', 'rating', 'reviews', 'impressions', 'clicks'],
  linkedin: ['followers', 'connections', 'profileViews', 'postImpressions', 'searchAppearances'],
};
const PANEL_IDS = ['hero', 'marquee', 'music', 'work', 'brands', 'photo', 'composition', 'services', 'hire', 'about', 'feedback', 'faq', 'contact']; /* sections of the website that can be hidden */
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
const DEFAULT_LOOK = { style: 'neu', theme: 'light' }; /* the website starts in neumorphism */
const LOOK_STYLES = ['normal', 'neu', 'clay'], LOOK_THEMES = ['light', 'dark'];
const getSetting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? { ...d, ...safeJson(r.value, {}) } : { ...d }; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
/* one time: the starting login (owner email + starting password) on every database that did not have it yet */
/* The website ships with 6 sample questions. Put them in the Questions list once, so the admin panel shows exactly what the website shows and nothing disappears when you add or edit one. */
if (!getSetting('faqseed', {}).done) {
  if (!db.prepare('SELECT COUNT(*) n FROM faqs').get().n) {
    const ins = db.prepare('INSERT INTO faqs (question,answer,sort,published) VALUES (?,?,?,1)');
    [{ question: "What is your design process?", answer: "I begin by understanding the brief and objectives, followed by research, concept development, visual exploration, design execution, and refinement based on feedback." },
      { question: "Which software do you use?", answer: "My primary tools include Adobe Photoshop and Adobe Illustrator. I also use Figma and AI-powered tools depending on the project." },
      { question: "Do you work with freelance clients?", answer: "Yes, I'm open to discussing freelance projects, creative collaborations, and design requirements. Share your brief through my contact section to get started." },
      { question: "How long does a design project take?", answer: "Timelines depend on the project's scope, complexity, and number of deliverables. I'll discuss the expected timeline after understanding your requirements." },
      { question: "Can you create designs according to brand guidelines?", answer: "Yes. I can work with existing brand guidelines, including typography, color palettes, logo usage, and visual consistency, to create cohesive designs." },
      { question: "How can we work together?", answer: "Use the contact section to share your project details, goals, and timeline. I'll review the brief and discuss the next steps with you." }].forEach((x, i) => ins.run(x.question, x.answer, i));
  }
  setSetting('faqseed', { done: true });
}
if (!getSetting('owner', {}).seeded) { const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE admin SET email=?, salt=?, hash=? WHERE id=1').run(OWNER_EMAIL, salt, hashPw(START_PASSWORD, salt)); setSetting('owner', { seeded: true }); }
if (!getSetting('look.neu', {}).done) { setSetting('look', { ...getSetting('look', DEFAULT_LOOK), style: 'neu' }); setSetting('look.neu', { done: true }); } /* one time: existing installs move to neumorphism too; the Style button can still switch it */
function ytId(u) {
  try {
    const x = new URL(String(u).trim()); const host = x.hostname.replace(/^(www|m|music)\./, ''); let id = '';
    if (host === 'youtu.be') id = x.pathname.slice(1);
    else if (host === 'youtube.com') { if (x.pathname === '/watch') id = x.searchParams.get('v') || ''; else { const m = x.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/); id = m ? m[1] : ''; } }
    return /^[\w-]{11}$/.test(id) ? id : '';
  } catch { return ''; }
}
function transaction(fn) { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
const deviceOf = ua => /ipad|tablet|mobi|android|iphone/i.test(ua) ? 'Mobile' : 'Desktop'; /* tablets count as Mobile */
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

/* time zone -> country (from the IANA tz database), so visitor locations can be shown by country */
const TZ_COUNTRY = (() => { const m = new Map(); for (const part of "AD:Europe/Andorra AE:Asia/Dubai AF:Asia/Kabul AG:America/Antigua AI:America/Anguilla AL:Europe/Tirane AM:Asia/Yerevan AO:Africa/Luanda AQ:Antarctica/Casey,Antarctica/Davis,Antarctica/DumontDUrville,Antarctica/Mawson,Antarctica/McMurdo,Antarctica/Palmer,Antarctica/Rothera,Antarctica/South_Pole,Antarctica/Syowa,Antarctica/Troll,Antarctica/Vostok AR:America/Argentina/Buenos_Aires,America/Argentina/Catamarca,America/Argentina/ComodRivadavia,America/Argentina/Cordoba,America/Argentina/Jujuy,America/Argentina/La_Rioja,America/Argentina/Mendoza,America/Argentina/Rio_Gallegos,America/Argentina/Salta,America/Argentina/San_Juan,America/Argentina/San_Luis,America/Argentina/Tucuman,America/Argentina/Ushuaia,America/Buenos_Aires,America/Catamarca,America/Cordoba,America/Jujuy,America/Mendoza,America/Rosario AS:Pacific/Pago_Pago,Pacific/Samoa,US/Samoa AT:Europe/Vienna AU:Antarctica/Macquarie,Australia/ACT,Australia/Adelaide,Australia/Brisbane,Australia/Broken_Hill,Australia/Canberra,Australia/Currie,Australia/Darwin,Australia/Eucla,Australia/Hobart,Australia/LHI,Australia/Lindeman,Australia/Lord_Howe,Australia/Melbourne,Australia/NSW,Australia/North,Australia/Perth,Australia/Queensland,Australia/South,Australia/Sydney,Australia/Tasmania,Australia/Victoria,Australia/West,Australia/Yancowinna AW:America/Aruba AX:Europe/Mariehamn AZ:Asia/Baku BA:Europe/Sarajevo BB:America/Barbados BD:Asia/Dacca,Asia/Dhaka BE:Europe/Brussels BF:Africa/Ouagadougou BG:Europe/Sofia BH:Asia/Bahrain BI:Africa/Bujumbura BJ:Africa/Porto-Novo BL:America/St_Barthelemy BM:Atlantic/Bermuda BN:Asia/Brunei BO:America/La_Paz BQ:America/Kralendijk BR:America/Araguaina,America/Bahia,America/Belem,America/Boa_Vista,America/Campo_Grande,America/Cuiaba,America/Eirunepe,America/Fortaleza,America/Maceio,America/Manaus,America/Noronha,America/Porto_Acre,America/Porto_Velho,America/Recife,America/Rio_Branco,America/Santarem,America/Sao_Paulo,Brazil/Acre,Brazil/DeNoronha,Brazil/East,Brazil/West BS:America/Nassau BT:Asia/Thimbu,Asia/Thimphu BW:Africa/Gaborone BY:Europe/Minsk BZ:America/Belize CA:America/Atikokan,America/Blanc-Sablon,America/Cambridge_Bay,America/Coral_Harbour,America/Creston,America/Dawson,America/Dawson_Creek,America/Edmonton,America/Fort_Nelson,America/Glace_Bay,America/Goose_Bay,America/Halifax,America/Inuvik,America/Iqaluit,America/Moncton,America/Montreal,America/Nipigon,America/Pangnirtung,America/Rainy_River,America/Rankin_Inlet,America/Regina,America/Resolute,America/St_Johns,America/Swift_Current,America/Thunder_Bay,America/Toronto,America/Vancouver,America/Whitehorse,America/Winnipeg,America/Yellowknife,Canada/Atlantic,Canada/Central,Canada/Eastern,Canada/Mountain,Canada/Newfoundland,Canada/Pacific,Canada/Saskatchewan,Canada/Yukon CC:Indian/Cocos CD:Africa/Kinshasa,Africa/Lubumbashi CF:Africa/Bangui CG:Africa/Brazzaville CH:Europe/Zurich CI:Africa/Abidjan CK:Pacific/Rarotonga CL:America/Coyhaique,America/Punta_Arenas,America/Santiago,Chile/Continental,Chile/EasterIsland,Pacific/Easter CM:Africa/Douala CN:Asia/Chongqing,Asia/Chungking,Asia/Harbin,Asia/Kashgar,Asia/Shanghai,Asia/Urumqi,PRC CO:America/Bogota CR:America/Costa_Rica CU:America/Havana,Cuba CV:Atlantic/Cape_Verde CW:America/Curacao CX:Indian/Christmas CY:Asia/Famagusta,Asia/Nicosia,Europe/Nicosia CZ:Europe/Prague DE:Europe/Berlin,Europe/Busingen DJ:Africa/Djibouti DK:Europe/Copenhagen DM:America/Dominica DO:America/Santo_Domingo DZ:Africa/Algiers EC:America/Guayaquil,Pacific/Galapagos EE:Europe/Tallinn EG:Africa/Cairo,Egypt EH:Africa/El_Aaiun ER:Africa/Asmara,Africa/Asmera ES:Africa/Ceuta,Atlantic/Canary,Europe/Madrid ET:Africa/Addis_Ababa FI:Europe/Helsinki FJ:Pacific/Fiji FK:Atlantic/Stanley FM:Pacific/Chuuk,Pacific/Kosrae,Pacific/Pohnpei,Pacific/Ponape,Pacific/Truk,Pacific/Yap FO:Atlantic/Faeroe,Atlantic/Faroe FR:Europe/Paris GA:Africa/Libreville GB:Europe/Belfast,Europe/London,GB,GB-Eire GD:America/Grenada GE:Asia/Tbilisi GF:America/Cayenne GG:Europe/Guernsey GH:Africa/Accra GI:Europe/Gibraltar GL:America/Danmarkshavn,America/Godthab,America/Nuuk,America/Scoresbysund,America/Thule GM:Africa/Banjul GN:Africa/Conakry GP:America/Guadeloupe GQ:Africa/Malabo GR:Europe/Athens GS:Atlantic/South_Georgia GT:America/Guatemala GU:Pacific/Guam GW:Africa/Bissau GY:America/Guyana HK:Asia/Hong_Kong,Hongkong HN:America/Tegucigalpa HR:Europe/Zagreb HT:America/Port-au-Prince HU:Europe/Budapest ID:Asia/Jakarta,Asia/Jayapura,Asia/Makassar,Asia/Pontianak,Asia/Ujung_Pandang IE:Eire,Europe/Dublin IL:Asia/Jerusalem,Asia/Tel_Aviv,Israel IM:Europe/Isle_of_Man IN:Asia/Calcutta,Asia/Kolkata IO:Indian/Chagos IQ:Asia/Baghdad IR:Asia/Tehran,Iran IS:Atlantic/Reykjavik,Iceland IT:Europe/Rome JE:Europe/Jersey JM:America/Jamaica,Jamaica JO:Asia/Amman JP:Asia/Tokyo,Japan KE:Africa/Nairobi KG:Asia/Bishkek KH:Asia/Phnom_Penh KI:Pacific/Enderbury,Pacific/Kanton,Pacific/Kiritimati,Pacific/Tarawa KM:Indian/Comoro KN:America/St_Kitts KP:Asia/Pyongyang KR:Asia/Seoul,ROK KW:Asia/Kuwait KY:America/Cayman KZ:Asia/Almaty,Asia/Aqtau,Asia/Aqtobe,Asia/Atyrau,Asia/Oral,Asia/Qostanay,Asia/Qyzylorda LA:Asia/Vientiane LB:Asia/Beirut LC:America/St_Lucia LI:Europe/Vaduz LK:Asia/Colombo LR:Africa/Monrovia LS:Africa/Maseru LT:Europe/Vilnius LU:Europe/Luxembourg LV:Europe/Riga LY:Africa/Tripoli,Libya MA:Africa/Casablanca MC:Europe/Monaco MD:Europe/Chisinau,Europe/Tiraspol ME:Europe/Podgorica MF:America/Marigot MG:Indian/Antananarivo MH:Kwajalein,Pacific/Kwajalein,Pacific/Majuro MK:Europe/Skopje ML:Africa/Bamako,Africa/Timbuktu MM:Asia/Rangoon,Asia/Yangon MN:Asia/Choibalsan,Asia/Hovd,Asia/Ulaanbaatar,Asia/Ulan_Bator MO:Asia/Macao,Asia/Macau MP:Pacific/Saipan MQ:America/Martinique MR:Africa/Nouakchott MS:America/Montserrat MT:Europe/Malta MU:Indian/Mauritius MV:Indian/Maldives MW:Africa/Blantyre MX:America/Bahia_Banderas,America/Cancun,America/Chihuahua,America/Ciudad_Juarez,America/Ensenada,America/Hermosillo,America/Matamoros,America/Mazatlan,America/Merida,America/Mexico_City,America/Monterrey,America/Ojinaga,America/Santa_Isabel,America/Tijuana,Mexico/BajaNorte,Mexico/BajaSur,Mexico/General MY:Asia/Kuala_Lumpur,Asia/Kuching MZ:Africa/Maputo NA:Africa/Windhoek NC:Pacific/Noumea NE:Africa/Niamey NF:Pacific/Norfolk NG:Africa/Lagos NI:America/Managua NL:Europe/Amsterdam NO:Atlantic/Jan_Mayen,Europe/Oslo NP:Asia/Kathmandu,Asia/Katmandu NR:Pacific/Nauru NU:Pacific/Niue NZ:NZ,NZ-CHAT,Pacific/Auckland,Pacific/Chatham OM:Asia/Muscat PA:America/Panama PE:America/Lima PF:Pacific/Gambier,Pacific/Marquesas,Pacific/Tahiti PG:Pacific/Bougainville,Pacific/Port_Moresby PH:Asia/Manila PK:Asia/Karachi PL:Europe/Warsaw,Poland PM:America/Miquelon PN:Pacific/Pitcairn PR:America/Puerto_Rico PS:Asia/Gaza,Asia/Hebron PT:Atlantic/Azores,Atlantic/Madeira,Europe/Lisbon,Portugal PW:Pacific/Palau PY:America/Asuncion QA:Asia/Qatar RE:Indian/Reunion RO:Europe/Bucharest RS:Europe/Belgrade RU:Asia/Anadyr,Asia/Barnaul,Asia/Chita,Asia/Irkutsk,Asia/Kamchatka,Asia/Khandyga,Asia/Krasnoyarsk,Asia/Magadan,Asia/Novokuznetsk,Asia/Novosibirsk,Asia/Omsk,Asia/Sakhalin,Asia/Srednekolymsk,Asia/Tomsk,Asia/Ust-Nera,Asia/Vladivostok,Asia/Yakutsk,Asia/Yekaterinburg,Europe/Astrakhan,Europe/Kaliningrad,Europe/Kirov,Europe/Moscow,Europe/Samara,Europe/Saratov,Europe/Ulyanovsk,Europe/Volgograd,W-SU RW:Africa/Kigali SA:Asia/Riyadh SB:Pacific/Guadalcanal SC:Indian/Mahe SD:Africa/Khartoum SE:Europe/Stockholm SG:Asia/Singapore,Singapore SH:Atlantic/St_Helena SI:Europe/Ljubljana SJ:Arctic/Longyearbyen SK:Europe/Bratislava SL:Africa/Freetown SM:Europe/San_Marino SN:Africa/Dakar SO:Africa/Mogadishu SR:America/Paramaribo SS:Africa/Juba ST:Africa/Sao_Tome SV:America/El_Salvador SX:America/Lower_Princes SY:Asia/Damascus SZ:Africa/Mbabane TC:America/Grand_Turk TD:Africa/Ndjamena TF:Indian/Kerguelen TG:Africa/Lome TH:Asia/Bangkok TJ:Asia/Dushanbe TK:Pacific/Fakaofo TL:Asia/Dili TM:Asia/Ashgabat,Asia/Ashkhabad TN:Africa/Tunis TO:Pacific/Tongatapu TR:Asia/Istanbul,Europe/Istanbul,Turkey TT:America/Port_of_Spain TV:Pacific/Funafuti TW:Asia/Taipei,ROC TZ:Africa/Dar_es_Salaam UA:Europe/Kiev,Europe/Kyiv,Europe/Simferopol,Europe/Uzhgorod,Europe/Zaporozhye UG:Africa/Kampala UM:Pacific/Midway,Pacific/Wake US:America/Adak,America/Anchorage,America/Atka,America/Boise,America/Chicago,America/Denver,America/Detroit,America/Fort_Wayne,America/Indiana/Indianapolis,America/Indiana/Knox,America/Indiana/Marengo,America/Indiana/Petersburg,America/Indiana/Tell_City,America/Indiana/Vevay,America/Indiana/Vincennes,America/Indiana/Winamac,America/Indianapolis,America/Juneau,America/Kentucky/Louisville,America/Kentucky/Monticello,America/Knox_IN,America/Los_Angeles,America/Louisville,America/Menominee,America/Metlakatla,America/New_York,America/Nome,America/North_Dakota/Beulah,America/North_Dakota/Center,America/North_Dakota/New_Salem,America/Phoenix,America/Shiprock,America/Sitka,America/Yakutat,Navajo,Pacific/Honolulu,Pacific/Johnston,US/Alaska,US/Aleutian,US/Arizona,US/Central,US/East-Indiana,US/Eastern,US/Hawaii,US/Indiana-Starke,US/Michigan,US/Mountain,US/Pacific UY:America/Montevideo UZ:Asia/Samarkand,Asia/Tashkent VA:Europe/Vatican VC:America/St_Vincent VE:America/Caracas VG:America/Tortola VI:America/St_Thomas,America/Virgin VN:Asia/Ho_Chi_Minh,Asia/Saigon VU:Pacific/Efate WF:Pacific/Wallis WS:Pacific/Apia YE:Asia/Aden YT:Indian/Mayotte ZA:Africa/Johannesburg ZM:Africa/Lusaka ZW:Africa/Harare".split(' ')) { const [c, zs] = part.split(':'); for (const z of zs.split(',')) m.set(z, c); } return m; })();
const REGION_NAME = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const countryOf = tz => { const c = TZ_COUNTRY.get(tz); if (!c) return ''; try { return (REGION_NAME && REGION_NAME.of(c)) || c; } catch { return c; } };
/* visitor details and engagement from a day up to a day (default: up to today) */
function detailRange(from, to = '9999-12-31') {
  const countries = () => { const sum = new Map(); for (const r of db.prepare("SELECT val k, SUM(n) n FROM visit_dims WHERE day BETWEEN ? AND ? AND dim = 'place' GROUP BY val").all(from, to)) { const c = countryOf(r.k); if (c) sum.set(c, (sum.get(c) || 0) + r.n); } return [...sum].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, 5); }; /* top 5 countries */
  const rows = (sql, ...a) => db.prepare(sql).all(...a);
  const dim = d => rows('SELECT val k, SUM(n) n FROM visit_dims WHERE day BETWEEN ? AND ? AND dim = ? GROUP BY val ORDER BY n DESC LIMIT 8', from, to, d);
  const t = db.prepare('SELECT COALESCE(SUM(seconds),0) s, COALESCE(SUM(scroll_sum),0) sc, COALESCE(SUM(firsts),0) f, COALESCE(SUM(bounces),0) b FROM totals WHERE day BETWEEN ? AND ?').get(from, to);
  const views = db.prepare('SELECT COALESCE(SUM(views),0) n FROM hits WHERE day BETWEEN ? AND ?').get(from, to).n;
  const sections = rows('SELECT section id, SUM(seconds) seconds, SUM(reached) reached, SUM(clicks) clicks FROM section_stats WHERE day BETWEEN ? AND ? GROUP BY section', from, to);
  return {
    visitors: { visit: dim('visit'), device: (() => { const m = new Map(); for (const r of dim('device')) { const k = r.k === 'Tablet' ? 'Mobile' : r.k; m.set(k, (m.get(k) || 0) + r.n); } return [...m].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n); })(), browser: dim('browser'), os: dim('os'), source: dim('source'), place: countries() },
    engagement: { avgSeconds: views ? Math.round(t.s / views) : 0, avgScroll: t.f ? Math.round(t.sc / t.f) : 0, bounceRate: t.f ? Math.round(t.b / t.f * 100) : 0 },
    sections: sections.map(x => ({ ...x, avgSeconds: x.reached ? Math.round(x.seconds / x.reached) : 0, reachPct: views ? Math.min(100, Math.round(x.reached / views * 100)) : 0 })),
    actions: rows('SELECT action k, SUM(n) n FROM actions WHERE day BETWEEN ? AND ? GROUP BY action ORDER BY n DESC LIMIT 10', from, to),
  };
}
const detail = from => detailRange(from);

/* ---------- email alerts: client activity on the website comes to the owner's mail ----------
   Instant mail for a project brief (Hire form) and for a Help message; plus one daily summary of the website visits.
   Needs the mail account (SMTP_HOST, SMTP_USER, SMTP_PASS). Settings: Account > Email alerts. */
const alertCfg = () => ({ to: OWNER_EMAIL, instant: true, daily: true, ...getSetting('alerts', {}) });
const alertState = () => getSetting('alertstate', { ok: 0, err: '', errAt: 0, digestDay: '', tryAt: 0 });
const smtpReady = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
async function mailOwner(subject, text) {
  const c = alertCfg();
  try { await sendMail(c.to, subject, text); setSetting('alertstate', { ...alertState(), ok: now(), err: '', errAt: 0 }); return true; }
  catch (e) { const msg = e.message === 'NO_SMTP' ? 'The server has no mail account yet (SMTP_HOST, SMTP_USER, SMTP_PASS).' : String(e.message || e).slice(0, 200); setSetting('alertstate', { ...alertState(), err: msg, errAt: now() }); throw new Error(msg); }
}
const notifyOwner = (subject, text) => { if (alertCfg().instant) mailOwner(subject, text).catch(() => {}); };
const dayAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
function digestText(day) {
  const d = detailRange(day, day), w = detailRange(dayAgo(6), day);
  const views = db.prepare('SELECT COALESCE(SUM(views),0) n FROM hits WHERE day = ?').get(day).n;
  const vis = db.prepare('SELECT COUNT(*) n FROM visitors WHERE day = ?').get(day).n;
  const views7 = db.prepare('SELECT COALESCE(SUM(views),0) n FROM hits WHERE day BETWEEN ? AND ?').get(dayAgo(6), day).n;
  const vis7 = db.prepare('SELECT COUNT(*) n FROM visitors WHERE day BETWEEN ? AND ?').get(dayAgo(6), day).n;
  const t0 = new Date(day + 'T00:00:00Z').getTime(), t1 = t0 + 864e5;
  const briefs = db.prepare('SELECT COUNT(*) n FROM inquiries WHERE created_at >= ? AND created_at < ?').get(t0, t1).n;
  const griev = db.prepare('SELECT COUNT(*) n FROM grievances WHERE created_at >= ? AND created_at < ?').get(t0, t1).n;
  const list = (a, f = x => x.k) => a && a.length ? a.map(x => '  ' + f(x) + ': ' + x.n).join('\n') : '  none';
  const secName = id => String(id).replace(/[-_]/g, ' ');
  const mins = s => s >= 90 ? Math.round(s / 60) + ' min' : s + ' sec';
  return [
    'Website summary for ' + day + (day === today() ? ' (today so far, UTC day)' : ' (UTC day)'), '',
    'Visitors: ' + vis + '   Page views: ' + views,
    'New visitors / returning: ' + (d.visitors.visit.map(x => x.k + ' ' + x.n).join(' / ') || 'none'),
    'Average time on the site: ' + mins(d.engagement.avgSeconds) + '   Left without scrolling or clicking: ' + d.engagement.bounceRate + '%', '',
    'Project briefs received: ' + briefs + '   Help messages received: ' + griev, '',
    'Devices:', list(d.visitors.device), '', 'Browsers:', list(d.visitors.browser), '', 'Systems:', list(d.visitors.os), '',
    'Where they came from:', list(d.visitors.source), '', 'Top countries:', list(d.visitors.place), '',
    'Sections people reached:', d.sections.length ? d.sections.sort((a, b) => b.reached - a.reached).slice(0, 6).map(x => '  ' + secName(x.id) + ': ' + x.reached + ' visitors, about ' + mins(x.avgSeconds) + ' each').join('\n') : '  none', '',
    'What they pressed:', list(d.actions), '',
    'Last 7 days: ' + vis7 + ' visitors, ' + views7 + ' page views', '',
    'Open the admin panel > Website stats for the full picture.'
  ].join('\n');
}
/* once a day after 9 AM India time: yesterday's summary (only when something happened that day) */
function dailyDigest(force = false) {
  const c = alertCfg(); if (!force && !c.daily) return Promise.resolve(false);
  const ist = new Date(Date.now() + 19800e3), istDay = ist.toISOString().slice(0, 10), st = alertState();
  const day = force ? today() : dayAgo(1); /* the button sends today so far; the daily mail covers the day before */
  if (!force) {
    if (ist.getUTCHours() < 9 || st.digestDay === istDay || now() - (st.tryAt || 0) < 3600e3) return Promise.resolve(false);
    setSetting('alertstate', { ...st, tryAt: now() });
    const busy = db.prepare('SELECT COALESCE(SUM(views),0) n FROM hits WHERE day = ?').get(day).n || db.prepare('SELECT COUNT(*) n FROM inquiries WHERE created_at >= ? AND created_at < ?').get(new Date(day + 'T00:00:00Z').getTime(), new Date(day + 'T00:00:00Z').getTime() + 864e5).n;
    if (!busy) { setSetting('alertstate', { ...alertState(), digestDay: istDay }); return Promise.resolve(false); }
  }
  const txt = digestText(day), v = /Visitors: (\d+)/.exec(txt)[1], pv = /Page views: (\d+)/.exec(txt)[1];
  return mailOwner('Website summary ' + day + ': ' + v + ' visitors, ' + pv + ' views', txt).then(() => { if (!force) setSetting('alertstate', { ...alertState(), digestDay: istDay }); return true; });
}
setInterval(() => { dailyDigest().catch(() => {}); }, 5 * 60e3).unref();

/* ---------- routes ---------- */
function publicContent() {
    const music = getSetting('music', { enabled: true });
    const tracks = db.prepare('SELECT id,url FROM tracks WHERE published=1 ORDER BY sort, id').all().map(t => ({ id: t.id, url: t.url, vid: ytId(t.url) })).filter(t => t.vid);
    const rs = getSetting('resume', DEFAULT_RESUME);
    const work = Object.fromEntries(WORK_CATS.map(c => [c, db.prepare('SELECT title,label,image,file FROM works WHERE category=? AND published=1 ORDER BY sort, id').all(c)]));
  return { online: getSetting('status', { online: true }).online !== false, music: { enabled: music.enabled !== false, tracks }, work, feedbacks: db.prepare('SELECT name,role,quote FROM testimonials WHERE published=1 ORDER BY sort, id').all(), questions: db.prepare('SELECT question q, answer a FROM faqs WHERE published=1 ORDER BY sort, id').all(), resume: rs.visible && rs.fileUrl ? { url: rs.fileUrl, label: rs.label, summary: rs.summary } : null, look: getSetting('look', DEFAULT_LOOK), panelsHidden: (getSetting('panels', { hidden: [] }).hidden || []).filter(x => PANEL_IDS.includes(x)), slots: getSetting('slots', { values: {} }).values, compare: (cp => cp.before && cp.after ? cp : null)(getSetting('compare', { before: '', after: '' })), editVideo: (v => v ? { vid: v } : null)(ytId(getSetting('editvideo', { url: '' }).url || '')) };
}

/* Apply on main website: writes a copy of everything saved in the admin panel into public/index.html, so the HTML file itself carries it.
   The first time, the original file is kept in the data folder as index.original.html. */
let applyTimer = null;
function applyToWebsite() {
  const file = path.join(PUBLIC_DIR, 'index.html'), backup = path.join(DATA_DIR, 'index.original.html');
  if (!fs.existsSync(file)) throw new Error('the website files are not in the public folder yet (public/index.html and public/live.js)');
  let html = fs.readFileSync(file, 'utf8');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, html);
  html = html.replace(/<!--SR-BAKED-->[\s\S]*?<!--\/SR-BAKED-->\s*/, '');
  const data = JSON.stringify({ ...publicContent(), bakedAt: now() }).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
  const block = '<!--SR-BAKED--><script type="application/json" id="sr-baked">' + data + '</script><!--/SR-BAKED-->\n';
  const marker = html.search(/<script src="\/?live\.js"/);
  if (marker < 0) throw new Error('index.html has no live.js line');
  html = html.slice(0, marker) + block + html.slice(marker);
  fs.writeFileSync(file + '.tmp', html); fs.renameSync(file + '.tmp', file);
  setSetting('applied', { at: now() });
  return { at: now(), bytes: Buffer.byteLength(html) };
}

async function api(req, res, url) {
  const p = url.pathname, m = req.method;

  /* public */
  if (p === '/api/public/content' && (m === 'GET' || m === 'OPTIONS')) {
    cors(req, res, false);
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
    return json(res, 200, publicContent(), { 'Cache-Control': 'no-cache' });
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
    notifyOwner('New project brief from ' + name + (str(b.service, 100) ? ' (' + str(b.service, 100) + ')' : ''), ['A client sent a project brief from your website Hire form.', '',
      'Name: ' + name, 'Business: ' + (str(b.business, 120) || '-'), 'Email: ' + email, 'WhatsApp: ' + (str(b.whatsapp, 40) || '-'), 'Needs: ' + (str(b.service, 100) || '-'),
      'Size: ' + (str(b.size, 80) || '-'), 'Quality: ' + (str(b.quality, 20) || '-'), 'Needed by: ' + (str(b.neededBy, 40) || '-'), '', message, '',
      'It is also saved in your admin panel under Project Brief. Reply from your own mail or WhatsApp.'].join('\n'));
    return json(res, 201, { ok: true });
  }

  /* Help button on the website: a client sends a grievance, it lands in Dashboard > Client Grievance as Open */
  if (p === '/api/grievances' && (m === 'POST' || m === 'OPTIONS')) {
    cors(req, res, true);
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const origin = req.headers.origin;
    let sameHost = false; try { sameHost = !!origin && new URL(origin).host === req.headers.host; } catch {}
    if (!ALLOWED.includes('*') && !sameHost && !(origin && ALLOWED.includes(origin))) return fail(res, 403, 'Origin not allowed');
    if (limited('grv:' + ip(req), 5, 3600e3)) return fail(res, 429, 'Too many messages. Please try again later.');
    const b = await readBody(req, 8 * 1024);
    if (b.website) return json(res, 200, { ok: true }); // honeypot: pretend success
    const name = str(b.name, 100), contact = str(b.contact, 200), issue = str(b.issue, 2000);
    if (!name || !contact || !issue) return fail(res, 400, 'Name, how to reach you and the problem are required');
    const t = now();
    db.prepare("INSERT INTO grievances (name,contact,project,issue,priority,status,resolution,created_at,updated_at) VALUES (?,?,?,?, 'medium','open','',?,?)").run(name, contact, str(b.project, 120), issue, t, t);
    notifyOwner('New Help message from your website: ' + name, 'A client sent a Help message from your website.\n\nName: ' + name + '\nContact: ' + contact + '\nProject: ' + (str(b.project, 120) || '-') + '\n\n' + issue + '\n\nIt is also saved in your admin panel under Dashboard > Client Grievance. Reply from your own mail or WhatsApp.');
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
  if (idRaw && idRaw !== 'counts' && !(resource === 'account' && idRaw === 'otp') && !(resource === 'apply' && (idRaw === 'download' || idRaw === 'zip')) && !(resource === 'alerts' && idRaw === 'test') && !(resource === 'insights' && idRaw === 'daily') && !(resource === 'slots' && idRaw === 'scan') && !Number.isInteger(id)) return fail(res, 400, 'Bad id');

  /* every save that changes what visitors see is written into the website's HTML file right away (see applyToWebsite) */
  if (m !== 'GET' && ['music', 'resume', 'work', 'feedbacks', 'questions', 'status', 'look', 'panels', 'compare', 'slots', 'editvideo'].includes(resource) && !(resource === 'slots' && seg[3] === 'scan'))
    res.on('finish', () => { if (res.statusCode < 300) { clearTimeout(applyTimer); applyTimer = setTimeout(() => { try { applyToWebsite(); } catch (e) { console.error('apply failed:', e.message); } }, 300); } });

  if (resource === 'logout' && m === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token=?').run(sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (resource === 'me' && m === 'GET') return json(res, 200, { email: db.prepare('SELECT email FROM admin WHERE id=1').get().email });

  if (resource === 'stats' && m === 'GET') {
    const d = new Date(), days = [];
    const range = url.searchParams.get('range') === '7' ? '7' : url.searchParams.get('range') === 'all' ? 'all' : '30';
    for (let i = 29; i >= 0; i--) { const x = new Date(d.getTime() - i * 864e5).toISOString().slice(0, 10); days.push(x); }
    const v = new Map(db.prepare('SELECT day, views FROM hits WHERE day >= ?').all(days[0]).map(r => [r.day, r.views]));
    const u = new Map(db.prepare('SELECT day, COUNT(*) n FROM visitors WHERE day >= ? GROUP BY day').all(days[0]).map(r => [r.day, r.n]));
    const from = range === 'all' ? '0000-00-00' : range === '7' ? days[23] : days[0];
    const series = days.map(day => ({ day, views: v.get(day) || 0, visitors: u.get(day) || 0 }));
    const sum = (a, k) => a.reduce((t, x) => t + x[k], 0);
    return json(res, 200, {
      series, today: series[29], views7: sum(series.slice(-7), 'views'), visitors7: sum(series.slice(-7), 'visitors'),
      views30: sum(series, 'views'), visitors30: sum(series, 'visitors'),
      range, clicks7: db.prepare('SELECT COALESCE(SUM(clicks),0) n FROM section_stats WHERE day >= ?').get(days[23]).n,
      visitorsR: db.prepare('SELECT COUNT(*) n FROM visitors WHERE day >= ?').get(from).n,
      clicksR: db.prepare('SELECT COALESCE(SUM(clicks),0) n FROM section_stats WHERE day >= ?').get(from).n,
      total: db.prepare('SELECT COALESCE(SUM(views),0) n FROM hits').get().n,
      since: (db.prepare('SELECT MIN(day) d FROM hits').get() || {}).d || null,
      ...detail(from),
    });
  }

  /* Instagram, Facebook and LinkedIn insights: typed in from each app, kept per range (total, 7, 30, life) plus daily views per day */
  const INSIGHTS = { instagram: ['reels', 'posts'], facebook: ['reels', 'posts'], linkedin: ['videos', 'posts'] };
  if (resource === 'insights') {
    const rd = k => getSetting('insights:' + k, { daily: {}, ranges: {}, updated: 0 });
    if (m === 'GET') return json(res, 200, Object.fromEntries(Object.keys(INSIGHTS).map(k => [k, rd(k)])));
    if (m === 'PUT') {
      const b = await readBody(req, 64 * 1024), key = str(b.platform, 20);
      if (!INSIGHTS[key]) return fail(res, 400, 'Unknown platform');
      const kinds = INSIGHTS[key], cur = rd(key);
      const numv = (v, max) => { if (v === '' || v == null) return null; const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw new Error('Numbers only, zero or higher' + (max <= 100 ? ', up to ' + max : '')); return Math.round(n * 100) / 100; };
      try {
        if (seg[3] === 'daily') {
          const daily = { ...cur.daily }, today = new Date(Date.now() + 864e5).toISOString().slice(0, 10); /* a day of slack for time zones ahead of UTC */
          for (const [d, v] of Object.entries(b.days || {})) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today || d < '2015-01-01') throw new Error('Bad date');
            const row = {}; for (const k of kinds) { const n = numv(v && v[k], 1e10); if (n != null) row[k] = n; }
            if (Object.keys(row).length) daily[d] = row; else delete daily[d];
          }
          setSetting('insights:' + key, { ...cur, daily, updated: now() });
          return json(res, 200, { ok: true });
        }
        const range = str(b.range, 10), sec = str(b.section, 20), d = b.data || {};
        if (!['total', '7', '30', 'life'].includes(range)) throw new Error('Unknown range');
        const SEC = { views: kinds, followers: ['count'], content: kinds, engagement: ['likes', 'comments', 'reposts', 'saves', 'shares'], gender: ['women', 'men'], age: ['age13_17', 'age18_24', 'age25_34', 'age35_44', 'age45_54', 'age55_64', 'age65'] };
        const ranges = { ...cur.ranges }, rr = { ...(ranges[range] || {}) };
        if (SEC[sec]) { const o = {}; for (const f of SEC[sec]) { const n = numv(d[f], sec === 'gender' || sec === 'age' ? 100 : 1e10); if (n != null) o[f] = n; } rr[sec] = o; }
        else if (sec === 'places') { rr.places = (Array.isArray(d.rows) ? d.rows : []).slice(0, 10).map(x => ({ k: str(x && x.k, 60), n: numv(x && x.n, 100) })).filter(x => x.k && x.n != null); }
        else throw new Error('Unknown section');
        ranges[range] = rr;
        setSetting('insights:' + key, { ...cur, ranges, updated: now() });
        return json(res, 200, { ok: true });
      } catch (e) { return fail(res, 400, e.message); }
    }
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

  /* website audience: gender and age shares typed in from an analytics tool (the website itself cannot see them) */
  if (resource === 'audience') {
    const KEYS = ['women', 'men', 'age16_20', 'age20_24', 'age24_28', 'age30_40', 'age40_50', 'age50_60', 'age60'];
    if (m === 'GET') return json(res, 200, getSetting('audience', { values: {}, updated: 0 }));
    if (m === 'PUT') {
      const b = await readBody(req, 4096), values = {};
      for (const k of KEYS) {
        const raw = b.values && b.values[k]; if (raw === '' || raw == null) continue;
        const n = Number(raw); if (!Number.isFinite(n) || n < 0 || n > 100) return fail(res, 400, 'Every share must be between 0 and 100');
        values[k] = Math.round(n * 10) / 10;
      }
      setSetting('audience', { values, updated: now() });
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
  /* Image editing: a YouTube video shown in the website's video box */
  if (resource === 'editvideo') {
    if (m === 'GET') return json(res, 200, getSetting('editvideo', { url: '' }));
    if (m === 'PUT') {
      const b = await readBody(req, 4096), raw = str(b.url, 300);
      if (raw && !ytId(raw)) return fail(res, 400, 'Paste a valid YouTube video link');
      setSetting('editvideo', { url: raw ? 'https://www.youtube.com/watch?v=' + ytId(raw) : '' });
      return json(res, 200, { ok: true });
    }
  }
  if (resource === 'compare') {
    if (m === 'GET') return json(res, 200, getSetting('compare', { before: '', after: '' }));
    if (m === 'PUT') {
      const b = await readBody(req, 4096), out = {};
      for (const k of ['before', 'after']) {
        const v = str(b[k], 200);
        if (v && (!/^\/uploads\/[\w.-]+\.(png|jpe?g|webp)$/.test(v) || !fs.existsSync(path.join(UPLOAD_DIR, path.basename(v))))) return fail(res, 400, 'Upload the ' + k + ' image first');
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
      return json(res, 200, db.prepare('SELECT id,title,label,image,file,published FROM works WHERE category=? ORDER BY sort, id').all(cat).map(w => ({ ...w, published: !!w.published })));
    }
    if (m === 'PUT') {
      const b = await readBody(req, 64 * 1024), c = str(b.category, 20);
      if (!WORK_CATS.includes(c)) return fail(res, 400, 'Unknown category');
      if (!Array.isArray(b.items) || b.items.length > 60) return fail(res, 400, 'A category holds up to 60 pieces');
      const rows = [];
      for (const x of b.items) {
        const title = str(x && x.title, 80), image = str(x && x.image, 200);
        if (!title) return fail(res, 400, 'Every piece needs a title');
        if (!/^\/uploads\/[\w.-]+\.(png|jpe?g|webp)$/.test(image) || !fs.existsSync(path.join(UPLOAD_DIR, path.basename(image)))) return fail(res, 400, 'Every piece needs an uploaded image');
        let file = '';
        if (c === 'branding') { file = str(x.file, 200); if (!/^\/uploads\/[\w.-]+\.pdf$/.test(file) || !fs.existsSync(path.join(UPLOAD_DIR, path.basename(file)))) return fail(res, 400, 'Every branding piece needs an uploaded PDF'); }
        rows.push({ title, label: str(x.label, 80), image, file, published: x.published === false ? 0 : 1 });
      }
      transaction(() => {
        db.prepare('DELETE FROM works WHERE category=?').run(c);
        const ins = db.prepare('INSERT INTO works (category,title,label,image,file,sort,published) VALUES (?,?,?,?,?,?,?)');
        rows.forEach((r, i) => ins.run(c, r.title, r.label, r.image, r.file, i, r.published));
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
  /* content slots: the images, videos, files and texts of the website, found by the page itself (live.js SR_scan) and replaced from here */
  if (resource === 'slots') {
    const read = () => getSetting('slots', { registry: [], values: {}, scannedAt: 0 });
    const KINDS = ['image', 'video', 'file', 'text'];
    if (m === 'GET') return json(res, 200, read());
    if (m === 'POST' && seg[3] === 'scan') {
      const b = await readBody(req, 512 * 1024);
      if (!Array.isArray(b.slots)) return fail(res, 400, 'Nothing to save');
      const cur = read();
      const registry = b.slots.slice(0, 400).filter(x => x && KINDS.includes(x.kind) && /^[\w-]{1,80}$/.test(String(x.key))).map(x => ({ key: String(x.key), kind: x.kind, section: str(x.section, 40), n: Math.max(1, Math.min(99, parseInt(x.n, 10) || 1)), context: str(x.context, 60), current: str(x.current, 300) }));
      if (!registry.length && cur.registry.length) return json(res, 200, { ok: true, count: cur.registry.length });
      const keys = new Set(registry.map(x => x.key));
      setSetting('slots', { registry, values: Object.fromEntries(Object.entries(cur.values).filter(([k]) => keys.has(k))), scannedAt: now() });
      return json(res, 200, { ok: true, count: registry.length });
    }
    if (m === 'PUT') {
      const b = await readBody(req, 8 * 1024);
      const cur = read(), slot = cur.registry.find(x => x.key === b.key);
      if (!slot) return fail(res, 400, 'Unknown item. Scan the website again.');
      const values = { ...cur.values };
      if (b.value === null || b.value === '') delete values[slot.key];
      else {
        const v = String(b.value);
        if (slot.kind === 'text') { if (v.length > 1000) return fail(res, 400, 'Keep the text under 1000 characters'); values[slot.key] = { kind: 'text', value: v }; }
        else {
          const re = { image: /^\/uploads\/[\w.-]+\.(png|jpe?g|webp)$/, video: /^\/uploads\/[\w.-]+\.(mp4|webm)$/, file: /^\/uploads\/[\w.-]+\.pdf$/ }[slot.kind];
          if (!re.test(v) || !fs.existsSync(path.join(UPLOAD_DIR, path.basename(v)))) return fail(res, 400, 'Upload the file first');
          values[slot.key] = { kind: slot.kind, value: v };
        }
      }
      setSetting('slots', { ...cur, values });
      return json(res, 200, { ok: true });
    }
  }

  /* email alerts settings, and a button that sends the latest daily summary right now */
  if (resource === 'alerts') {
    if (m === 'GET' && !seg[3]) { const c = alertCfg(), s = alertState(); return json(res, 200, { to: c.to, instant: c.instant !== false, daily: c.daily !== false, smtp: smtpReady(), lastOk: s.ok, lastError: s.err, lastErrorAt: s.errAt }); }
    if (m === 'PUT') {
      const b = await readBody(req, 2048), to = str(b.to, 200).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail(res, 400, 'Enter a valid email address');
      setSetting('alerts', { to, instant: b.instant !== false, daily: b.daily !== false });
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && seg[3] === 'test') {
      try { await dailyDigest(true); return json(res, 200, { ok: true, to: alertCfg().to }); }
      catch (e) { return fail(res, 503, e.message); }
    }
  }

  if (resource === 'apply' && m === 'GET' && seg[3] === 'zip') { /* every file of the main website in one zip: index.html (with all saved changes), live.js and the uploaded pictures/PDFs */
    const files = [];
    for (const f of ['index.html', 'live.js']) { const fp = path.join(PUBLIC_DIR, f); if (fs.existsSync(fp)) files.push([f, fs.readFileSync(fp)]); }
    for (const f of fs.readdirSync(UPLOAD_DIR)) { const fp = path.join(UPLOAD_DIR, f); if (fs.statSync(fp).isFile()) files.push(['uploads/' + f, fs.readFileSync(fp)]); }
    const d = new Date(), dosT = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosD = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = []; let offset = 0;
    for (const [name, data] of files) {
      const nm = Buffer.from(name), comp = zlib.deflateRawSync(data), crc = zlib.crc32(data);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosT, 10); lh.writeUInt16LE(dosD, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosT, 12); ch.writeUInt16LE(dosD, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
      parts.push(lh, nm, comp); central.push(ch, nm); offset += 30 + nm.length + comp.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="portfolio-website.zip"' });
    return res.end(Buffer.concat([...parts, cd, end]));
  }
  if (resource === 'apply') {
    if (m === 'GET' && seg[3] === 'download') { const buf = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="index.html"' }); return res.end(buf); }
    if (m === 'GET') return json(res, 200, getSetting('applied', { at: 0 }));
    if (m === 'POST') { try { return json(res, 200, { ok: true, ...applyToWebsite() }); } catch (e) { return fail(res, 500, 'Could not write the website file: ' + e.message); } }
  }

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
    const b = await readBody(req, 36 * 1024 * 1024);
    const mt = /^data:(image\/(?:png|jpeg|webp)|application\/pdf|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''));
    if (!mt) return fail(res, 400, 'Upload a PDF, an MP4 or WebM video, or a PNG, JPG or WebP image');
    const kind = mt[1] === 'application/pdf' ? 'pdf' : mt[1].split('/')[1];
    const buf = Buffer.from(mt[2], 'base64');
    const isVid = kind === 'mp4' || kind === 'webm', cap = isVid ? 25 : kind === 'pdf' ? 10 : 5;
    if (buf.length > cap * 1024 * 1024) return fail(res, 413, (isVid ? 'Video' : kind === 'pdf' ? 'PDF' : 'Image') + ' is larger than ' + cap + ' MB');
    const magic = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46], pdf: [0x25, 0x50, 0x44, 0x46], webm: [0x1a, 0x45, 0xdf, 0xa3] }[kind];
    const okMagic = kind === 'mp4' ? buf.slice(4, 8).toString('latin1') === 'ftyp' : magic.every((x, i) => buf[i] === x);
    if (!okMagic) return fail(res, 400, 'File content does not match its type');
    const name = crypto.randomBytes(12).toString('hex') + '.' + (kind === 'jpeg' ? 'jpg' : kind);
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return json(res, 201, { url: '/uploads/' + name, size: Math.max(1, Math.round(buf.length / 1024)) + ' KB' });
  }

  return fail(res, 404, 'Not found');
}

/* ---------- static files ---------- */

const MIME = { '.webmanifest': 'application/manifest+json', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  let base = PUBLIC_DIR;
  if (rel.startsWith('/uploads/')) { base = UPLOAD_DIR; rel = rel.slice('/uploads'.length); }
  else if (rel === '/admin') { res.writeHead(302, { Location: '/admin/' }); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (base === PUBLIC_DIR && rel === '/index.html') { /* the back end can run before the website files are added */
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Back end is running</title><body style="font:16px/1.6 system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;color:#14102E"><h1 style="font-size:24px">Back end is running</h1><p>The website files are not here yet. Copy <b>index.html</b> and <b>live.js</b> from the front end folder into this server\'s <b>public</b> folder, then reload this page.</p><p><a href="/admin/">Open the admin panel</a></p></body>');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
    }
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
const ADMIN_CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const SITE_CSP = "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'";
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin'); // the website page itself is switched below to send its origin to YouTube
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Content-Security-Policy', url.pathname.startsWith('/admin') ? ADMIN_CSP : SITE_CSP);
    if (!url.pathname.startsWith('/admin') && !url.pathname.startsWith('/api/')) res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); /* the YouTube player refuses to start (error 153, "video player configuration error") unless the page tells it which site is embedding it */
    if (url.searchParams.get('preview') === '1' && !url.pathname.startsWith('/admin') && !url.pathname.startsWith('/api/')) { res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Content-Security-Policy', SITE_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'")); } /* lets the admin panel show a live preview of the website */
    if (url.pathname.startsWith('/uploads/')) { res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Content-Security-Policy', "frame-ancestors 'self'"); } /* lets the admin panel preview the resume PDF */
    if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(req.method === 'HEAD' ? undefined : '{"ok":true}'); } /* for host health checks */
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
server.listen(PORT, () => console.log(`Website: http://localhost:${PORT}/   Admin: http://localhost:${PORT}/admin/   Data folder: ${DATA_DIR}`));

/* stop cleanly when the host restarts or redeploys the service, so no request is cut half way and the database is closed properly */
let stopping = false;
function shutdown(sig) {
  if (stopping) return; stopping = true;
  console.log(sig + ' received, shutting down');
  const force = setTimeout(() => process.exit(0), 8000); force.unref();
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  if (server.closeIdleConnections) server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
