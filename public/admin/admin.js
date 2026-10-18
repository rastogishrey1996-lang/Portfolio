'use strict';
/* Admin panel. All dynamic text goes through textContent (the h() helper), never innerHTML. */

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const LOGO_URL = '/admin/logo.png';
const COLORS = { accent: ['#4F3BFF', '#fff'], pink: ['#FF4FA3', '#14102E'], sun: ['#FFC700', '#14102E'], warm: ['#FF5A36', '#14102E'], mint: ['#12B886', '#14102E'], sky: ['#22B8FF', '#14102E'] };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'color') { el.style.setProperty('--c', COLORS[v][0]); el.style.setProperty('--t', COLORS[v][1]); }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
let toastTimer;
function toast(msg, bad) { toastEl.textContent = msg; toastEl.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.className = '', 2800); }

async function api(method, url, body) {
  const res = await fetch('/api/admin' + url, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin-panel' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {}; try { data = await res.json(); } catch {}
  if (res.status === 401 && url !== '/login') { dirty = false; showLogin(); throw new Error('Please sign in again'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  if (method !== 'GET' && url !== '/login' && url !== '/logout') reloadPreview(); /* any saved change shows up in the preview dock */
  return data;
}
const wrap = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const readDataUrl = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
/* Branding thumbnails: the first page of the PDF drawn at 1920 x 1080 (pdf.js, bundled in vendor/pdfjs) */
const PDFJS_BASE = new URL('vendor/pdfjs/', location.href).href;
let pdfjsLib = null;
async function pdfThumb(file) {
  if (!pdfjsLib) { pdfjsLib = await import(PDFJS_BASE + 'pdf.min.mjs'); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.mjs'; }
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), standardFontDataUrl: PDFJS_BASE + 'standard_fonts/', wasmUrl: PDFJS_BASE + 'wasm/', isEvalSupported: false });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1), base = page.getViewport({ scale: 1 }), W = 1920, H = 1080;
    const vp = page.getViewport({ scale: Math.max(W / base.width, H / base.height) }); /* fill the frame; wider pages are centred, taller pages keep their top */
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    await page.render({ canvasContext: ctx, canvas: c, viewport: vp, transform: [1, 0, 0, 1, (W - vp.width) / 2, 0], background: '#ffffff' }).promise;
    return c.toDataURL('image/jpeg', 0.86);
  } finally { task.destroy(); }
}
/* Drag and drop for every upload: the file you drop is handed to the same file input that Choose file uses. */
function wireDrop(box, input) {
  const okType = f => { const a = (input.accept || '').split(',').map(x => x.trim()).filter(Boolean); return !a.length || a.some(t => t === f.type || (t.endsWith('/*') && f.type.startsWith(t.slice(0, -1)))); };
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  ['dragenter', 'dragover'].forEach(ev => box.addEventListener(ev, e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; box.classList.add('drag'); }));
  ['dragleave', 'dragend'].forEach(ev => box.addEventListener(ev, e => { if (!e.relatedTarget || !box.contains(e.relatedTarget)) box.classList.remove('drag'); }));
  box.addEventListener('drop', e => {
    if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); box.classList.remove('drag');
    const f = e.dataTransfer.files[0]; if (!f) return;
    if (!okType(f)) return toast('This file type is not accepted here', true);
    try { const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; } catch { return toast('Your browser cannot take dropped files here. Use Choose file.', true); }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function dropBox(input) {
  const box = h('div', { class: 'dz' }, input, h('span', { class: 'dz-hint' }, 'or drag and drop a file here'));
  wireDrop(box, input); return box;
}
/* a file dropped outside a drop area must not make the browser open it */
['dragover', 'drop'].forEach(ev => document.addEventListener(ev, e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); }));

/* ---------- unsaved-changes tracking and the Save / Cancel bar ---------- */
let dirty = false, flash = null;
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

/* Every editable section ends with this bar. Save writes to the server, and the website reads from the
   server, so a saved change is live on the website straight away. Cancel throws the edits away. */
function savebar({ view, onSave, live = true }) {
  const justSaved = flash === view; if (justSaved) flash = null;
  const idle = justSaved ? (live ? 'Saved. This change is live on your website.' : 'Saved.') : 'No unsaved changes';
  const status = h('span', { class: 'sb-status' }, idle);
  const cancel = h('button', { class: 'btn', type: 'button', disabled: true }, 'Cancel');
  const save = h('button', { class: 'btn solid', type: 'button', disabled: true }, 'Save changes');
  const bar = h('div', { class: 'savebar' + (justSaved ? ' ok' : '') }, h('span', { class: 'sb-dot' }, ''), status,
    h('div', { class: 'sb-acts' }, cancel, save));
  const api = {
    el: bar,
    mark(v = true) {
      dirty = v; cancel.disabled = save.disabled = !v;
      bar.classList.toggle('dirty', v); if (v) bar.classList.remove('ok');
      status.textContent = v ? 'You have unsaved changes' : idle;
    },
  };
  cancel.addEventListener('click', () => { dirty = false; go(view); toast('Changes discarded'); });
  save.addEventListener('click', async () => {
    save.disabled = cancel.disabled = true; status.textContent = 'Saving...';
    try { await onSave(); dirty = false; flash = view; toast(live ? 'Saved. Your website is updated.' : 'Saved'); await go(view); }
    catch (e) { toast(e.message, true); cancel.disabled = save.disabled = false; status.textContent = 'You have unsaved changes'; }
  });
  return api;
}

/* ---------- login ---------- */
/* captcha: image made by the server. field() returns {el, body()} where body() gives the ids to send. */
function captchaBox() {
  const img = h('img', { class: 'cap-img', alt: 'Captcha', width: 190, height: 64 }), input = h('input', { type: 'text', autocomplete: 'off', maxlength: 5, placeholder: 'Type the 5 characters', 'aria-label': 'Captcha' });
  let id = '';
  const refresh = async () => { try { const d = await fetchCaptcha(); id = d.id; img.src = d.image; input.value = ''; } catch (e) { toast(e.message, true); } };
  const el = h('div', { class: 'cap' }, img, h('button', { class: 'btn sm', type: 'button', onclick: refresh, title: 'New image' }, 'New image'), input);
  refresh();
  return { el, refresh, body: () => ({ captchaId: id, captcha: input.value }) };
}
async function fetchCaptcha() {
  const res = await fetch('/api/captcha/new', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'admin-panel' } });
  const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || 'Could not load the captcha'); return d;
}
function loginForm(msg, preview) {
  const email = h('input', { type: 'email', id: preview ? null : 'em', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', id: preview ? null : 'pw', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'err', hidden: !msg }, msg || '');
  const form = h('form', { class: 'card' },
    h('div', { class: 'shapes' }, ...['accent', 'pink', 'sun', 'mint', 'warm'].map(c => h('i', { color: c }))),
    h('h1', {}, 'Admin'), h('p', { class: 'muted' }, 'Sign in to manage your portfolio.'),
    h('div', { class: 'field' }), err,
    h('div', { class: 'field' }, h('label', {}, 'Email'), email),
    h('div', { class: 'field' }, h('label', {}, 'Password'), pw),
    h('button', { class: 'btn solid', type: 'submit' }, 'Sign in'));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (preview) return toast('This is only a preview of the sign in screen');
    try { await api('POST', '/login', { email: email.value, password: pw.value }); boot(); }
    catch (x) { err.hidden = false; err.textContent = x.message; }
  });
  return { form, email };
}
/* "Welcome" in many languages drifting behind the sign in card: random size, place, colour and speed */
const WELCOME = ['Welcome', 'स्वागत है', 'Bienvenido', 'Bienvenue', 'Willkommen', 'Benvenuto', 'ようこそ', '환영합니다', '欢迎', 'مرحبا', 'Добро пожаловать', 'Bem-vindo', 'Hoş geldiniz', 'Karibu', 'Välkommen', 'Welkom', 'Καλώς ήρθατε', 'ברוך הבא', 'Selamat datang', 'ยินดีต้อนรับ', 'Chào mừng', 'Witamy', 'Üdvözöljük', 'ਜੀ ਆਇਆਂ ਨੂੰ', 'வரவேற்கிறோம்', 'స్వాగతం', 'স্বাগতম', 'Aloha', 'Fáilte', 'Croeso', 'Tervetuloa', 'Velkommen', 'Vítejte', 'Mabuhay'];
function loginScene(card) {
  const bg = h('div', { class: 'wl-bg', 'aria-hidden': 'true' }), rnd = (a, b) => a + Math.random() * (b - a), cols = ['#4F3BFF', '#FF4FA3', '#12B886', '#FF5A36', '#FFC700', '#22B8FF'];
  WELCOME.forEach(w => {
    const e = h('span', { class: 'wl' }, w), st = e.style;
    st.left = rnd(-4, 88) + '%'; st.top = rnd(0, 94) + '%'; st.fontSize = rnd(14, 52).toFixed(0) + 'px'; st.color = cols[Math.floor(rnd(0, cols.length))];
    st.setProperty('--o', rnd(.16, .38).toFixed(2)); st.setProperty('--dx', rnd(-70, 70).toFixed(0) + 'px'); st.setProperty('--dy', rnd(-50, 50).toFixed(0) + 'px');
    st.setProperty('--r0', rnd(-12, 12).toFixed(0) + 'deg'); st.setProperty('--r1', rnd(-12, 12).toFixed(0) + 'deg'); st.setProperty('--s0', rnd(.7, 1).toFixed(2)); st.setProperty('--s1', rnd(1.05, 1.5).toFixed(2));
    st.animationDuration = rnd(12, 30).toFixed(1) + 's'; st.animationDelay = '-' + rnd(0, 30).toFixed(1) + 's';
    bg.appendChild(e);
  });
  return [bg, card];
}
function showLogin(msg) {
  removeDock();
  const f = loginForm(msg);
  app.replaceChildren(h('div', { class: 'login' }, ...loginScene(f.form)));
  f.email.focus();
}

/* ---------- shell ---------- */
const AUDIENCE = [['women', 'Women'], ['men', 'Men'], ['age16_20', 'Age 16 to 20'], ['age20_24', 'Age 20 to 24'], ['age24_28', 'Age 24 to 28'], ['age30_40', 'Age 30 to 40'], ['age40_50', 'Age 40 to 50'], ['age50_60', 'Age 50 to 60'], ['age60', 'Age above 60']];
const PLATFORMS = {
  instagram: { label: 'Instagram', color: 'pink', where: 'the Instagram app under Professional dashboard', audience: 'Instagram Insights under Total followers',
    fields: [['followers', 'Followers'], ['following', 'Following'], ['posts', 'Posts'], ['avgLikes', 'Average likes per post'], ['profileVisits', 'Profile visits, last 30 days']] },
  facebook: { label: 'Facebook page', color: 'sky', where: 'Meta Business Suite under Insights', audience: 'Meta Business Suite Insights under Audience',
    fields: [['pageFollowers', 'Page followers'], ['pageLikes', 'Page likes'], ['posts', 'Posts'], ['reach', 'Reach, last 30 days']] },
  fiverr: { label: 'Fiverr', color: 'mint', where: 'your Fiverr seller dashboard under Analytics',
    fields: [['orders', 'Orders completed'], ['rating', 'Rating out of 5'], ['reviews', 'Reviews'], ['impressions', 'Gig impressions'], ['clicks', 'Gig clicks']] },
  linkedin: { label: 'LinkedIn', color: 'accent', where: 'LinkedIn under Analytics',
    fields: [['followers', 'Followers'], ['connections', 'Connections'], ['profileViews', 'Profile views'], ['postImpressions', 'Post impressions'], ['searchAppearances', 'Search appearances']] },
};
/* menus under Project Brief: a brief goes to every menu whose services it asks for; anything else goes to Other Projects */
const BRIEF_CATS = { logo: ['Logo & Brand', 'accent', ['Logo', 'Branding']], social: ['Social Media', 'pink', ['Static Post', 'Carousel']], print: ['Poster & Print', 'sun', ['Posters', 'Brochures', 'Visiting Cards', 'Banners']], other: ['Other Projects', 'mint', null] };
const briefCats = service => {
  const parts = String(service || '').split(',').map(x => x.trim()).filter(Boolean), out = new Set();
  for (const p of parts) { const hit = Object.entries(BRIEF_CATS).find(([, c]) => c[2] && c[2].includes(p)); out.add(hit ? hit[0] : 'other'); }
  if (!out.size) out.add('other'); return out;
};
const BRIEF = { new: ['New', 'warm'], replied: ['Replied', 'sky'], won: ['Won', 'mint'], archived: ['Archived', 'sun'] };
const WORK = { logo: ['Logo', 'sun', 'Logo, Brand mark'], social: ['Social media', 'pink', 'Social media post'], brochure: ['Brochures', 'mint', 'Brochure, Tri-fold'], banner: ['Banners', 'warm', 'Banner, Large format'], other: ['Other printables', 'sky', 'Other printable, Stickers'], branding: ['Branding', 'accent', 'Branding, Brand identity'], editing: ['Image editing', 'pink', 'Image editing, Retouching'], composition: ['Image composition', 'sun', 'Image composition, Photo manipulation'] };
const VIEWS = {
  website: ['Website stats', 'accent', viewWebsite, 'Dashboard'],
  style: ['Style', 'accent', m => viewLook(m, 'style'), 'Dashboard'],
  theme: ['Theme', 'sun', m => viewLook(m, 'theme'), 'Dashboard'],
  panels: ['Panels', 'mint', viewPanels, 'Dashboard'],
  grievances: ['Client Grievance', 'warm', viewGrievances, 'Dashboard'],
  music: ['Music', 'pink', viewMusic, 'Hero section'],
  resume: ['Resume', 'sun', viewResume, 'Hero section'],
  ...Object.fromEntries(Object.entries(WORK).map(([k, [label, color]]) => ['work-' + k, [label, color, m => viewWork(m, k), 'Work']])),
  ...Object.fromEntries(Object.entries(BRIEF_CATS).map(([k, [label, color]]) => ['brief-' + k, [label, color, m => viewBriefs(m, k), 'Project Brief']])),
  feedbacks: ['Feedbacks', 'pink', viewFeedbacks, 'Client Feedback'],
  questions: ['Questions', 'sky', viewQuestions, 'Client Feedback'],
  account: ['Account', 'sky', viewAccount, null, true],
};
/* Apply on main website: writes everything saved here into the website's own HTML file */
function applyBtn() {
  const b = h('button', { class: 'btn solid apply-btn', type: 'button', title: 'Write everything saved in this panel into the website HTML file' }, 'Apply on main website');
  b.addEventListener('click', async () => {
    if (dirty && !confirm('You have unsaved changes. They will not be applied. Continue?')) return;
    b.disabled = true; b.textContent = 'Applying...';
    try {
      const r = await api('POST', '/apply');
      toast('Applied. The website HTML file now has all your saved changes.');
      modal('Applied on the main website', h('div', {}, h('p', { class: 'hint', style: 'margin:0 0 10px' }, 'Everything you saved in this panel (music, resume, work, brochures, feedbacks, questions, availability, look, panels and the Before / After slider) is now written inside the website\'s index.html file, ' + Math.round(r.bytes / 1024) + ' KB, at ' + new Date(r.at).toLocaleString() + '.'),
        h('p', { class: 'hint', style: 'margin:0 0 12px' }, 'The original file is kept as index.original.html in the data folder. Saves already do this by themselves, so use this button only to be sure. Visitor stats and inquiries are not written into the file.'),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { const x = await fetch('/api/admin/apply/download', { credentials: 'same-origin' }); const u = URL.createObjectURL(await x.blob()); const a = h('a', { href: u, download: 'index.html' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); } }, 'Download index.html')), async () => {}, 'Close');
    } catch (e) { toast(e.message, true); }
    b.disabled = false; b.textContent = 'Apply on main website';
  });
  return b;
}
/* Download the whole main website (index.html with all saved changes, live.js and the uploaded pictures and PDFs) as one zip */
function downloadBtn() {
  const b = h('button', { class: 'btn sm apply-btn', type: 'button', title: 'Save a copy of all your website files on this device' }, 'Download website files');
  b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Preparing...';
    try {
      let blob, name = 'portfolio-website.zip';
      if (window.__SITE_HTML__) { blob = new Blob([window.__SITE_HTML__], { type: 'text/html' }); name = 'index.html'; } /* artifact preview: the page itself */
      else { const x = await fetch('/api/admin/apply/zip', { credentials: 'same-origin' }); if (!x.ok) throw new Error('Could not prepare the files'); blob = await x.blob(); }
      const u = URL.createObjectURL(blob), a = h('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
      toast('Website files downloaded.');
    } catch (e) { toast(e.message, true); }
    b.disabled = false; b.textContent = 'Download website files';
  });
  return b;
}
let current = 'website', briefNew = {}, navCount = {};

/* A menu group: a bigger heading that opens and closes its sub menu. It stays open while one of its pages is showing. */
/* one icon per menu group: closed, filled shapes in the group's colour */
const GROUP_ICONS = {
  'Dashboard': ['#4F3BFF', ['M3 12h4v9H3z', 'M10 3h4v18h-4z', 'M17 8h4v13h-4z']],
  'Hero section': ['#FF4FA3', ['M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.1 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z']],
  'Work': ['#22B8FF', ['M9 3h6a1 1 0 0 1 1 1v3H8V4a1 1 0 0 1 1-1z', 'M3 8a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z']],
  'Project Brief': ['#FFC700', ['M6 2h8l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z']],
  'Client Feedback': ['#12B886', ['M4 3h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-5 4v-4H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z']],
  'Business Moderation': ['#FF5A36', ['M12 2l8 3v6c0 5.2-3.4 9.2-8 11-4.6-1.8-8-5.8-8-11V5z']],
  'Appearance': ['#8B5CF6', ['M12 2a10 10 0 1 0 0 20c1.4 0 2.2-1 2.2-2.1 0-.6-.3-1.1-.6-1.5-.3-.4-.6-.8-.6-1.4 0-1 .8-1.8 1.8-1.8H17a5 5 0 0 0 5-5C22 6 17.5 2 12 2z']]
};
function groupIcon(label) {
  const g = GROUP_ICONS[label]; if (!g) return null;
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'ng-ico'); svg.setAttribute('aria-hidden', 'true'); svg.style.setProperty('--ic', g[0]);
  for (const d of g[1]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); }
  return svg;
}
const groupOpen = {};
let sideMin = false; try { sideMin = localStorage.getItem('sr-admin-side') === 'min'; } catch {}
function navGroup(label, activeKey) {
  const hasNew = Object.keys(VIEWS).some(k => VIEWS[k][3] === label && navCount[k]);
  if (VIEWS[activeKey] && VIEWS[activeKey][3] === label) groupOpen[label] = true;
  const open = groupOpen[label] !== false;
  const items = h('div', { class: 'ng-items' });
  const inner = h('div', { class: 'ng-in' }, items); inner.inert = !open;
  const el = h('div', { class: 'navgrp' + (open ? '' : ' closed') + (VIEWS[activeKey] && VIEWS[activeKey][3] === label ? ' has-on' : '') + (hasNew ? ' has-dot' : '') });
  const head = h('button', { class: 'ng-head', type: 'button', 'data-i': label[0], title: label, 'aria-expanded': String(open) }, groupIcon(label), h('span', { class: 'ng-lbl' }, ...(label.includes(' ') ? [label.slice(0, label.indexOf(' ')), h('br'), label.slice(label.indexOf(' ') + 1)] : [label])), hasNew ? h('i', { class: 'ng-dot', title: 'Has new items', 'aria-hidden': 'true' }) : null, h('i', { class: 'ng-chev', 'aria-hidden': 'true' }));
  head.addEventListener('click', () => {
    pvScroll(GROUP_TARGET[label]);
    const sh = el.closest('.shell');
    if (sh && sh.classList.contains('min') && matchMedia('(min-width: 861px)').matches) { /* rail: a click opens the menu sideways and shows this group */
      sh.classList.remove('min'); sideMin = false; try { localStorage.setItem('sr-admin-side', 'full'); } catch {}
      groupOpen[label] = true; el.classList.remove('closed'); inner.inert = false; head.setAttribute('aria-expanded', 'true'); return;
    }
    const closed = el.classList.toggle('closed'); groupOpen[label] = !closed; head.setAttribute('aria-expanded', String(!closed)); inner.inert = closed; });
  if (GROUP_ICONS[label]) el.style.setProperty('--ic', GROUP_ICONS[label][0]);
  el.append(head, h('div', { class: 'ng-wrap' }, inner));
  return { el, items };
}

async function newByCat() {
  const n = {}, c = {}; try { const r = await api('GET', '/inquiries/counts'); for (const svc of r.new) for (const k of briefCats(svc)) n[k] = (n[k] || 0) + 1; for (const k in n) c['brief-' + k] = n[k]; if (r.openGrievances) c.grievances = r.openGrievances; } catch {}
  navCount = c; return n;
}
async function boot() {
  try { await api('GET', '/me'); } catch { return showLogin(); }
  await refreshSlots();
  try { await scanSite(); await refreshSlots(); } catch {} /* every sign in: the panel looks at the website again, so new images, videos and PDFs get their place on the right menu page */
  current = (location.hash.slice(1) in VIEWS) ? location.hash.slice(1) : 'website';
  go(current);
}
/* Availability status. Hover (or focus) the dot to open the menu upward and pick Online or Offline. It switches the badge in the hero of the website. */
function statusMenu(online) {
  const dot = h('i', { class: 'st-dot' + (online ? '' : ' off') });
  const opts = {};
  const set = wrap(async v => { await api('PUT', '/status', { online: v }); online = v; paint(); toast(v ? 'Online. The hero badge says Taking new projects.' : 'Offline. The hero badge says Not taking new projects.'); });
  const opt = (v, label, sub) => { const b = h('button', { class: 'st-opt', type: 'button', role: 'menuitemradio', onclick: () => set(v) }, h('i', { class: 'st-dot' + (v ? '' : ' off') }), h('span', {}, h('b', {}, label), h('small', {}, sub))); opts[v] = b; return b; };
  const menu = h('div', { class: 'st-menu', role: 'menu' }, h('div', { class: 'st-card' }, h('p', { class: 'st-title' }, 'Hero badge on website'), opt(true, 'Online', 'Taking new projects'), opt(false, 'Offline', 'Not taking new projects')));
  const btn = h('button', { class: 'btn sm st-btn', type: 'button', 'aria-haspopup': 'menu', title: 'Availability status' }, dot);
  const paint = () => { dot.className = 'st-dot' + (online ? '' : ' off'); btn.setAttribute('aria-label', 'Availability status: ' + (online ? 'online' : 'offline')); opts[true].setAttribute('aria-checked', String(online)); opts[false].setAttribute('aria-checked', String(!online)); opts[true].classList.toggle('on', online); opts[false].classList.toggle('on', !online); };
  paint();
  return h('div', { class: 'stwrap' }, btn, menu);
}
async function go(name) {
  /* remember where the page and the menu were scrolled, so a click never throws you back to the top */
  const keepY = window.scrollY, oldSide = document.querySelector('.side'), keepSide = oldSide ? oldSide.scrollTop : 0, prev = current;
  const [, nb, st] = await Promise.all([refreshSlots(), newByCat(), api('GET', '/status').catch(() => ({ online: true }))]); /* fetched together, not one after another */
  if (!VIEWS[name]) name = 'website';
  dirty = false; current = name; location.hash = name;
  if (window.__srLookDraft || window.__srPanelsDraft) { window.__srLookDraft = null; window.__srPanelsDraft = null; reloadPreview(); }
  ensureDock();
  if (name !== prev) pvScroll(targetFor(name));
  briefNew = nb;
  const online = st.online !== false;
  const main = h('main', { class: 'main', id: 'view' });
  const leave = key => { if (dirty && !confirm('You have unsaved changes. Leave without saving?')) return; go(key); };
  const nav = []; let grp = null, box = null;
  for (const [key, [label, color, , group, bottom]] of Object.entries(VIEWS)) {
    const btn = h('button', { class: 'nav' + (key === name ? ' on' : ''), color, onclick: () => leave(key) },
      h('i'), label, navCount[key] ? h('span', { class: 'count', title: key === 'grievances' ? 'Open or in progress' : 'New' }, navCount[key]) : null);
    if (bottom) continue;
    if (group) {
      if (group !== grp) { box = navGroup(group, name); nav.push(box.el); }
      box.items.append(btn);
    } else nav.push(btn);
    grp = group || null;
  }
  const toggle = h('button', { class: 'side-toggle', type: 'button', 'aria-label': 'Collapse or expand the menu', title: 'Collapse or expand the menu' }, h('i', { 'aria-hidden': 'true' }));
  const shell = h('div', { class: 'shell' + (sideMin ? ' min' : '') });
  toggle.addEventListener('click', () => {
    sideMin = !sideMin; shell.classList.toggle('min', sideMin);
    try { localStorage.setItem('sr-admin-side', sideMin ? 'min' : 'full'); } catch {}
  });
  const side =
    h('aside', { class: 'side' }, toggle, h('div', { class: 'logo' }, h('img', { class: 'logo-img', src: LOGO_URL, alt: 'SR logo', width: 84, height: 64 }), h('div', { class: 'logo-t' }, 'Shrey Rastogi', h('small', {}, 'Admin panel'))), nav, h('div', { class: 'spacer' }), modeRow(),
      h('div', { class: 'side-bottom' },
        applyBtn(),
        downloadBtn(),
        h('div', { class: 'acct-row' },
          h('button', { class: 'btn sm' + (name === 'account' ? ' on' : ''), onclick: () => leave('account') }, 'Account'),
          statusMenu(online)),
        h('button', { class: 'btn sm', onclick: wrap(async () => { await api('POST', '/logout'); showLogin(); }) }, 'Sign out')));
  shell.append(side, main);
  /* build the new page first and swap it in only when it is ready, so the old page stays on screen meanwhile (no blink) */
  try { await VIEWS[name][2](main); } catch (e) { toast(e.message, true); }
  if (current !== name) return; /* another click started a newer page meanwhile */
  shell.classList.toggle('min', sideMin); /* menu state as it is now, not as it was when the page started loading */
  const oldLogo = document.querySelector('.side .logo-img'), newLogo = side.querySelector('.logo-img'); if (oldLogo && newLogo) newLogo.replaceWith(oldLogo); /* reuse the loaded logo so it never flickers */
  app.replaceChildren(shell);
  const sideEl = document.querySelector('.side'); if (sideEl) sideEl.scrollTop = keepSide;
  if (name === prev) window.scrollTo(0, keepY);
  if (sideEl) sideEl.scrollTop = keepSide;
}
const header = (title, sub, action) => h('div', { class: 'head' }, h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), action);

/* ---------- modal ---------- */
function modal(title, body, onSave, saveLabel = 'Save') {
  const close = () => scrim.remove();
  const save = h('button', { class: 'btn solid', type: 'submit' }, saveLabel);
  const form = h('form', { class: 'modal' }, h('h2', {}, title), body,
    h('div', { class: 'foot' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), save));
  form.addEventListener('submit', async e => { e.preventDefault(); save.disabled = true; try { await onSave(); close(); } catch (x) { toast(x.message, true); save.disabled = false; } });
  const scrim = h('div', { class: 'scrim', onmousedown: e => { if (e.target === scrim) close(); } }, form);
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  document.body.append(scrim);
  const first = form.querySelector('input, textarea'); if (first) first.focus();
}
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('p', { class: 'hint' }, hint) : null);

/* ---------- dashboard: website stats (counted by the website itself) ---------- */
const num = n => Number(n).toLocaleString('en-IN');
const stat = (n, label, color, sub) => h('div', { class: 'stat', color }, h('b', {}, n), h('span', {}, label), sub ? h('small', {}, sub) : null);
const SECTION_NAMES = { hero: 'Hero', music: 'Music player', work: 'Work', services: 'Services', hire: 'Hire form', about: 'About', feedback: 'Client feedback', faq: 'FAQ', contact: 'Footer and contact' };
const secName = id => SECTION_NAMES[id] || id.charAt(0).toUpperCase() + id.slice(1);
const dur = sec => sec >= 3600 ? Math.floor(sec / 3600) + 'h ' + Math.round(sec % 3600 / 60) + 'm' : sec >= 60 ? Math.floor(sec / 60) + 'm ' + (sec % 60) + 's' : sec + 's';
const placeName = tz => { const p = tz.split('/'); return p[p.length - 1].replace(/_/g, ' ') + (p.length > 1 ? ', ' + p[0].replace(/_/g, ' ') : ''); };
const fill = (color, pct) => h('i', { style: 'width:' + pct + '%;background:' + COLORS[color][0] });
/* a list of horizontal bars, each filled to its share of the biggest one */
function barList(rows, color, fmt = num) {
  if (!rows.length) return h('div', { class: 'empty' }, 'No data yet. It fills in as people visit your website.');
  const max = Math.max(1, ...rows.map(r => r.n));
  return h('div', { class: 'hb' }, ...rows.map(r => h('div', { class: 'hb-row' },
    h('span', { class: 'hb-k' }, r.k), h('span', { class: 'hb-track' }, fill(color, Math.max(2, Math.round(r.n / max * 100)))), h('b', {}, fmt(r.n)))));
}
let statRange = '30';
async function viewWebsite(main) {
  const [s, aud] = await Promise.all([api('GET', '/stats?range=' + statRange), api('GET', '/audience').catch(() => ({ values: {} }))]);
  /* gender and age cannot be seen by the website: the shares are typed in from an analytics tool */
  const audCard = (title, keys, color) => {
    const rows = keys.filter(k => aud.values[k] != null).map(k => ({ k: AUDIENCE.find(x => x[0] === k)[1].replace('Age ', ''), n: aud.values[k] }));
    return h('div', { class: 'card' }, h('h2', {}, title),
      rows.length ? barList(rows, color, n => n + '%') : h('div', { class: 'empty' }, 'No data yet.'));
  };
  const editAudience = () => {
    const ins = Object.fromEntries(AUDIENCE.map(([k]) => [k, h('input', { type: 'number', min: 0, max: 100, step: '0.1', inputmode: 'decimal', value: aud.values[k] == null ? '' : aud.values[k], placeholder: '0' })]));
    modal('Visitors by gender and age', h('div', {}, h('p', { class: 'hint', style: 'margin:0 0 12px' }, 'Shares in percent from your analytics tool. Leave a box empty if you do not have it.'), h('div', { class: 'fgrid' }, ...AUDIENCE.map(([k, l]) => field(l + ' (%)', ins[k])))),
      async () => { await api('PUT', '/audience', { values: Object.fromEntries(AUDIENCE.map(([k]) => [k, ins[k].value])) }); toast('Saved'); go('website'); });
  };
  const e = s.engagement, v = s.visitors;
  const visitN = k => (v.visit.find(x => x.k === k) || { n: 0 }).n, visitAll = visitN('New') + visitN('Returning');
  const secs = s.sections.slice().sort((a, b) => b.seconds - a.seconds), totalSec = secs.reduce((t, x) => t + x.seconds, 0) || 1;
  const maxT = Math.max(1, ...secs.map(x => x.seconds)), maxC = Math.max(1, ...secs.map(x => x.clicks));
  const table = secs.length ? h('div', { class: 'sectbl', role: 'table' },
    h('div', { class: 'st-row st-head', role: 'row' }, h('span', {}, 'Section'), h('span', {}, 'Time spent'), h('span', {}, 'Avg time per visitor'), h('span', {}, 'Reached'), h('span', {}, 'Clicks')),
    ...secs.map((x, i) => h('div', { class: 'st-row', role: 'row' },
      h('span', { class: 'st-name' }, h('em', {}, i + 1), secName(x.id)),
      h('span', { class: 'st-bar' }, h('span', { class: 'hb-track' }, fill('accent', Math.max(2, Math.round(x.seconds / maxT * 100)))), h('small', {}, Math.round(x.seconds / totalSec * 100) + '%')),
      h('span', {}, dur(x.avgSeconds)), h('span', {}, x.reachPct + '% of visits'),
      h('span', { class: 'st-bar' }, h('span', { class: 'hb-track' }, fill('pink', Math.max(2, Math.round(x.clicks / maxC * 100)))), h('b', {}, num(x.clicks)))))) : h('div', { class: 'empty' }, 'No section data yet. It fills in as people scroll through your website.');
  const RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'Lifetime']], rl = RANGES.find(r => r[0] === statRange)[1].toLowerCase();
  const filter = h('div', { class: 'tabs rangebar', role: 'group', 'aria-label': 'Time range' }, ...RANGES.map(([k, l]) => h('button', { class: 'tab' + (k === statRange ? ' on' : ''), type: 'button', 'aria-pressed': String(k === statRange), onclick: e => { statRange = k; filter.querySelectorAll('.tab').forEach(t => { const on = t === e.currentTarget; t.classList.toggle('on', on); t.setAttribute('aria-pressed', String(on)); }); go('website'); } }, l)));
  main.append(header('Website stats', 'Visits to your portfolio website, counted automatically. The filter changes every number below except Visitors today.'), filter,
    h('div', { class: 'stats' }, stat(num(s.visitorsR), 'Visitors, ' + rl, 'pink'), stat(num(s.clicksR), 'Clicks, ' + rl, 'warm', 'on buttons and links')),
    h('h2', { class: 'sec' }, 'Interest and interaction'),
    h('div', { class: 'stats' }, stat(num(s.today.visitors), 'Visitors today', 'sun'), stat(dur(e.avgSeconds), 'Average time on site', 'accent', 'per visit'), stat(e.bounceRate + '%', 'Left within 10 seconds', 'warm', 'with no click'), stat(visitAll ? Math.round(visitN('Returning') / visitAll * 100) + '%' : '-', 'Returning visitors', 'mint', num(visitN('Returning')) + ' returning, ' + num(visitN('New')) + ' new')),
    h('div', { class: 'card' }, h('h2', {}, 'Section by section'), table,
      h('p', { class: 'hint' }, 'Time spent counts while a section is in the middle of the screen and the visitor is active. Reached is the share of visits that scrolled to it.')),

    h('h2', { class: 'sec' }, 'Who visits'),
    h('div', { class: 'two' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('h2', {}, 'Device'), barList(v.device, 'accent')),
        audCard('Gender', ['women', 'men'], 'pink'),
        audCard('Age group', ['age16_20', 'age20_24', 'age24_28', 'age30_40', 'age40_50', 'age50_60', 'age60'], 'accent')),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('h2', {}, 'Where they come from'), barList(v.source, 'pink')),
        h('div', { class: 'card' }, h('h2', {}, 'Operating system'), barList(v.os, 'mint')))),
    h('div', { class: 'card' }, h('h2', {}, 'Top 5 countries'), barList(v.place, 'sun'),
      h('p', { class: 'hint' }, 'Worked out from the visitor\'s device time zone. Counts are visits.')));
}


/* ---------- Items found on the website: every image, video, file and text of the website, found automatically ---------- */
let slotData = { registry: [], values: {}, scannedAt: 0 };
const SLOT_COLORS = ['pink', 'sky', 'mint', 'warm', 'sun', 'accent'];
const KIND_NAME = { image: 'Image', video: 'Video', file: 'PDF / file', text: 'Text' };
/* Which menu page already looks after an item. Items with no home page are left alone. */
const SLOT_HOME = x => {
  const c = (x.context || '').toLowerCase();
  if (x.section === 'work') return c.includes('brand identit') ? 'work-branding' : c.includes('image editing') ? 'work-editing' : c.includes('image composition') ? 'work-composition' : null;
  return { music: 'music', feedback: 'feedbacks', faq: 'questions' }[x.section] || null;
};
async function refreshSlots() { try { slotData = await api('GET', '/slots'); } catch {} }
/* the website itself lists what can be replaced: it is opened in a hidden frame and asked */
async function scanSite() {
  if (window.__SITE_HTML__) { await api('POST', '/slots/scan', { slots: [] }); return; }
  const f = h('iframe', { src: '/?preview=1', 'aria-hidden': 'true', tabindex: '-1', style: 'position:fixed;left:-9999px;top:0;width:1280px;height:900px;border:0' });
  document.body.append(f);
  try {
    await new Promise((ok, no) => { f.onload = ok; setTimeout(() => no(new Error('The website did not load')), 15000); });
    await new Promise(r => setTimeout(r, 900));
    if (!f.contentWindow.SR_scan) throw new Error('The website has no live.js, so it cannot be scanned');
    await api('POST', '/slots/scan', { slots: f.contentWindow.SR_scan() });
  } finally { f.remove(); }
}
/* the cards for a list of items: images, videos, PDFs and texts, each replaced with one upload */
function slotCards(items, title) {
  const label = x => KIND_NAME[x.kind] + ' ' + x.n;
  const save = async (x, value) => { await api('PUT', '/slots', { key: x.key, value }); toast('Saved'); go(current); };
  const card = x => {
    const cur = slotData.values[x.key], v = cur && cur.value;
    const pick = (accept, max, what) => {
      const inp = h('input', { type: 'file', accept, hidden: true, onchange: wrap(async () => {
        const f = inp.files[0]; if (!f) return;
        if (f.size > max * 1024 * 1024) { inp.value = ''; throw new Error(what + ' is larger than ' + max + ' MB'); }
        const up = await api('POST', '/upload', { dataUrl: await readDataUrl(f) }); await save(x, up.url);
      }) });
      return [inp, h('button', { class: 'btn sm solid', type: 'button', onclick: () => inp.click() }, v ? 'Replace' : 'Upload')];
    };
    let body, ctl;
    if (x.kind === 'image') { body = (v || x.current) ? h('img', { class: 'slot-prev', src: v || x.current, alt: '' }) : h('div', { class: 'slot-prev slot-art' }, 'Original artwork'); ctl = pick('image/png,image/jpeg,image/webp', 5, 'The image'); }
    else if (x.kind === 'video') { body = v ? h('video', { class: 'slot-prev', src: v, controls: true, preload: 'metadata' }) : h('div', { class: 'slot-prev slot-art' }, 'Original placeholder'); ctl = pick('video/mp4,video/webm', 25, 'The video'); }
    else if (x.kind === 'file') { body = h('p', { class: 'hint', style: 'margin:0' }, (v || x.current || 'No file') ); ctl = pick('application/pdf', 10, 'The PDF'); }
    else {
      const t = h('textarea', { rows: 3, maxlength: 1000 }, v != null ? v : x.current); body = t;
      ctl = [h('button', { class: 'btn sm solid', type: 'button', onclick: wrap(() => save(x, t.value)) }, 'Save text')];
    }
    const reset = v ? h('button', { class: 'btn sm', type: 'button', onclick: wrap(() => save(x, null)) }, 'Use original') : null;
    const dropInp = ctl && ctl[0] && ctl[0].tagName === 'INPUT' ? ctl[0] : null;
    const cardEl = h('div', { class: 'card slot' }, h('div', { class: 'cardhead' }, h('h2', {}, label(x)), v ? h('span', { class: 'tag' }, 'Replaced') : null), x.context ? h('p', { class: 'hint', style: 'margin:-6px 0 0' }, 'Under: ' + x.context) : null, body, h('div', { class: 'slot-ctl' }, ...ctl, reset), dropInp ? h('p', { class: 'hint dz-note' }, 'or drag and drop a file onto this card') : null);
    if (dropInp) wireDrop(cardEl, dropInp);
    return cardEl;
  };
  const out = [h('h2', { class: 'sec' }, title ? title + ': images, videos, PDFs and texts' : 'Images, videos, PDFs and texts'),
    h('p', { class: 'hint', style: 'margin:-6px 0 12px' }, 'Found on the website automatically. Each change is saved as soon as you upload it. Press Apply on main website to write it into the HTML file.')];
  for (const k of ['image', 'video', 'file', 'text']) {
    const list = items.filter(x => x.kind === k); if (!list.length) continue;
    out.push(h('h3', { class: 'sub' }, { image: 'Images', video: 'Videos', file: 'PDFs and files', text: 'Texts' }[k]), h('div', { class: 'grid2' }, ...list.map(card)));
  }
  return out;
}


/* ---------- dashboard: Instagram, Facebook and LinkedIn insights (typed in, since these networks do not share them with this panel) ---------- */
const INS = {
  instagram: { label: 'Instagram', where: 'the Instagram app under Professional dashboard > Insights', kinds: [['reels', 'Reels'], ['posts', 'Posts']] },
  facebook: { label: 'Facebook page', where: 'Meta Business Suite under Insights', kinds: [['reels', 'Reels'], ['posts', 'Posts']] },
  linkedin: { label: 'LinkedIn', where: 'LinkedIn under Analytics', kinds: [['videos', 'Videos'], ['posts', 'Posts']] },
};
const RANGES4 = [['total', 'Total'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['life', 'Lifetime']];
const ENG = [['likes', 'Likes'], ['comments', 'Comments'], ['reposts', 'Reposts'], ['saves', 'Saves'], ['shares', 'Shares']];
const insR = {}, insWk = {};
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); return x; };
async function viewInsights(main, key) {
  const P = INS[key], D = (await api('GET', '/insights'))[key], kinds = P.kinds;
  const rg = (r, sec) => (D.ranges[r] && D.ranges[r][sec]) || {};
  const total = o => Object.values(o).reduce((t, v) => t + (Number(v) || 0), 0);
  const has = o => Object.keys(o).length > 0;
  /* views for a range: summed from the daily entries when there are any, otherwise the totals typed for that range */
  const viewsFor = r => {
    const today = new Date(), from = r === '7' ? ymd(addDays(today, -6)) : r === '30' ? ymd(addDays(today, -29)) : null, o = Object.fromEntries(kinds.map(([k]) => [k, 0])); let any = false;
    if (r !== 'life') for (const [d, v] of Object.entries(D.daily)) { if (from && d < from) continue; any = true; kinds.forEach(([k]) => { o[k] += Number(v[k] || 0); }); }
    if (any) return { vals: o, src: 'Added up from your daily numbers below' };
    const t = rg(r, 'views'); return has(t) ? { vals: t, src: 'Typed from ' + P.label } : { vals: null, src: '' };
  };
  const dash = v => v == null ? '-' : num(v);
  const rangeTabs = (id, r, set) => h('div', { class: 'tabs rangebar', role: 'group', 'aria-label': 'Time range' }, ...RANGES4.map(([k, l]) => h('button', { class: 'tab' + (k === r ? ' on' : ''), type: 'button', 'aria-pressed': String(k === r), onclick: () => { insR[id] = k; set(); } }, l)));
  /* a section card: title, its own range filter, an Edit numbers button and a body drawn for the chosen range */
  const section = (id, title, sub, edit, body) => {
    const box = h('div', { class: 'card ins' }), draw = () => {
      const r = insR[key + id] || '30', tabs = rangeTabs(key + id, r, draw);
      box.replaceChildren(h('div', { class: 'cardhead' }, h('h2', {}, title), edit ? h('button', { class: 'btn sm', type: 'button', onclick: () => edit(r) }, 'Edit numbers') : null), tabs, ...(sub ? [h('p', { class: 'hint', style: 'margin:10px 0 0' }, sub)] : []), ...[].concat(body(r)).filter(Boolean));
    };
    draw(); return box;
  };
  const rLabel = r => RANGES4.find(x => x[0] === r)[1].toLowerCase();
  const save = async (section, range, data, done) => { await api('PUT', '/insights', { platform: key, section, range, data }); toast('Saved'); go(current); };
  const numInputs = (fields, cur, max) => Object.fromEntries(fields.map(([f]) => [f, h('input', { type: 'number', min: 0, max, step: '1', inputmode: 'decimal', value: cur[f] == null ? '' : cur[f], placeholder: '0' })]));
  const readNums = ins => Object.fromEntries(Object.entries(ins).map(([f, el]) => [f, el.value]));
  const simpleEdit = (sec, title, fields) => r => {
    const ins = numInputs(fields, rg(r, sec));
    modal(title + ', ' + rLabel(r), h('div', {}, h('p', { class: 'hint', style: 'margin:0 0 12px' }, 'Type the numbers for ' + rLabel(r) + ' from ' + P.where + '. Leave a box empty if you do not have it.'), h('div', { class: 'fgrid' }, ...fields.map(([f, l]) => field(l, ins[f])))),
      () => save(sec, r, readNums(ins)));
  };
  const tiles = (fields, vals, colors) => h('div', { class: 'stats' }, ...fields.map(([f, l], i) => stat(vals && vals[f] != null ? num(vals[f]) : '-', l, colors[i % colors.length])));
  const COL = ['pink', 'accent', 'sun', 'mint', 'warm'];

  /* ---- views ---- */
  const wkOff = () => insWk[key] || 0;
  const weekBlock = () => {
    const box = h('div', { class: 'wkbox' });
    const draw = () => {
      const now = new Date(), dow = (now.getDay() + 6) % 7, start = addDays(now, -dow + wkOff() * 7), days = Array.from({ length: 7 }, (_, i) => addDays(start, i)), today = ymd(now);
      const get = (d, k) => { const v = D.daily[ymd(d)]; return v && v[k] != null ? v[k] : null; };
      const max = Math.max(1, ...days.flatMap(d => kinds.map(([k]) => get(d, k) || 0)));
      const col = ['pink', 'accent'];
      const chart = h('div', { class: 'wk', role: 'img', 'aria-label': 'Views per day this week' }, ...days.map(d => h('div', { class: 'wk-col' },
        h('div', { class: 'wk-bars' }, ...kinds.map(([k], i) => { const v = get(d, k); return h('div', { class: 'wk-b' }, h('small', {}, v == null ? '' : num(v)), h('i', { style: 'height:' + (v ? Math.max(3, Math.round(v / max * 150)) : 0) + 'px;background:' + COLORS[col[i]][0] })); })),
        h('span', { class: 'wk-day' }, d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })))));
      const ins = {}; for (const d of days) for (const [k] of kinds) ins[ymd(d) + k] = h('input', { type: 'number', min: 0, step: '1', inputmode: 'numeric', 'aria-label': k + ' on ' + ymd(d), value: get(d, k) == null ? '' : get(d, k), placeholder: '0', disabled: ymd(d) > today });
      const grid = h('div', { class: 'wk-in' }, ...days.map(d => h('div', {}, h('span', {}, d.toLocaleDateString('en-IN', { weekday: 'short' })), ...kinds.map(([k]) => ins[ymd(d) + k]))));
      const rows = kinds.map(([k, l], i) => h('span', { class: 'wk-key' }, h('i', { style: 'background:' + COLORS[col[i]][0] }), l));
      const range = days[0].toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' to ' + days[6].toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      box.replaceChildren(
        h('div', { class: 'wk-head' }, h('div', { class: 'wk-nav' }, h('button', { class: 'btn sm', type: 'button', onclick: () => { insWk[key] = wkOff() - 1; draw(); } }, 'Previous week'), h('b', {}, range), h('button', { class: 'btn sm', type: 'button', disabled: wkOff() >= 0, onclick: () => { insWk[key] = wkOff() + 1; draw(); } }, 'Next week')), h('div', { class: 'wk-keys' }, ...rows)),
        chart,
        h('p', { class: 'hint' }, 'Type how many views each day got, from ' + P.where + '. One row per day, ' + kinds.map(x => x[1]).join(' then ') + '.'),
        grid, h('div', { class: 'wk-save' }, h('button', { class: 'btn solid', type: 'button', onclick: wrap(async () => {
          const out = {}; for (const d of days) { if (ymd(d) > today) continue; out[ymd(d)] = Object.fromEntries(kinds.map(([k]) => [k, ins[ymd(d) + k].value])); }
          await api('PUT', '/insights/daily', { platform: key, days: out }); toast('Saved'); go(current);
        }) }, 'Save this week')));
    };
    draw(); return box;
  };
  const viewsSec = section('views', 'Views', null, simpleEdit('views', 'Views', kinds), r => {
    const v = viewsFor(r);
    return [tiles([['all', 'All views'], ...kinds], v.vals ? { all: total(v.vals), ...v.vals } : null, COL), v.src ? h('p', { class: 'hint', style: 'margin:0' }, v.src + '.') : h('p', { class: 'hint', style: 'margin:0' }, 'Nothing for this range yet. Add your daily numbers below or press Edit numbers.'), h('h3', { class: 'sub' }, 'Views per day, week by week'), weekBlock()];
  });

  /* ---- followers ---- */
  const folEdit = r => {
    const cnt = numInputs([['count', 'Followers']], rg(r, 'followers')), g = numInputs(AUDIENCE.slice(0, 2), rg(r, 'gender'), 100), a = numInputs(AUDIENCE.slice(2), rg(r, 'age'), 100);
    const rows = []; const place = (x = {}) => { const k = h('input', { type: 'text', maxlength: 60, placeholder: 'City or country', value: x.k || '' }), n = h('input', { type: 'number', min: 0, max: 100, step: '0.1', placeholder: '%', value: x.n == null ? '' : x.n }); rows.push({ k, n }); return h('div', { class: 'plrow' }, k, n); };
    const old = rg(r, 'places'), plist = Array.isArray(D.ranges[r] && D.ranges[r].places) ? D.ranges[r].places : []; void old;
    const pbox = h('div', { class: 'pl' }, ...Array.from({ length: 6 }, (_, i) => place(plist[i])));
    modal('Followers, ' + rLabel(r), h('div', {}, h('p', { class: 'hint', style: 'margin:0 0 12px' }, 'From ' + P.where + '. ' + (r === '7' || r === '30' ? 'For this range type the followers you gained.' : 'Type your total followers.') + ' Gender, age and location are in percent.'),
      h('div', { class: 'fgrid' }, field(r === '7' || r === '30' ? 'New followers' : 'Total followers', cnt.count)),
      h('h2', { class: 'sub' }, 'Gender (%)'), h('div', { class: 'fgrid' }, ...AUDIENCE.slice(0, 2).map(([f, l]) => field(l, g[f]))),
      h('h2', { class: 'sub' }, 'Age group (%)'), h('div', { class: 'fgrid' }, ...AUDIENCE.slice(2).map(([f, l]) => field(l.replace('Age ', ''), a[f]))),
      h('h2', { class: 'sub' }, 'Top locations (%)'), pbox),
      async () => {
        await api('PUT', '/insights', { platform: key, range: r, section: 'followers', data: readNums(cnt) });
        await api('PUT', '/insights', { platform: key, range: r, section: 'gender', data: readNums(g) });
        await api('PUT', '/insights', { platform: key, range: r, section: 'age', data: readNums(a) });
        await api('PUT', '/insights', { platform: key, range: r, section: 'places', data: { rows: rows.map(x => ({ k: x.k.value.trim(), n: x.n.value })) } });
        toast('Saved'); go(current);
      });
  };
  const folSec = section('followers', 'Followers', null, folEdit, r => {
    const f = rg(r, 'followers'), g = rg(r, 'gender'), a = rg(r, 'age'), pl = (D.ranges[r] && D.ranges[r].places) || [];
    const bars = (title, rows, color) => h('div', { class: 'card flat' }, h('h2', {}, title), barList(rows, color, n => n + '%'));
    return [h('div', { class: 'stats' }, stat(dash(f.count), r === '7' || r === '30' ? 'New followers' : 'Total followers', 'pink', rLabel(r))),
      h('div', { class: 'three' },
        bars('Gender', AUDIENCE.slice(0, 2).filter(([k]) => g[k] != null).map(([k, l]) => ({ k: l, n: g[k] })), 'pink'),
        bars('Age group', AUDIENCE.slice(2).filter(([k]) => a[k] != null).map(([k, l]) => ({ k: l.replace('Age ', ''), n: a[k] })), 'accent'),
        bars('Location', pl.map(x => ({ k: x.k, n: x.n })), 'sun'))];
  });

  /* ---- content ---- */
  const conSec = section('content', 'Content', null, simpleEdit('content', 'Content posted', kinds), r => {
    const c = rg(r, 'content');
    return [tiles([['all', 'All content'], ...kinds], has(c) ? { all: total(c), ...c } : null, ['mint', 'pink', 'accent']), has(c) ? null : h('p', { class: 'hint', style: 'margin:0' }, 'Nothing for this range yet. Press Edit numbers.')].filter(Boolean);
  });

  /* ---- engagement ---- */
  const engSec = section('engagement', 'Engagement', null, simpleEdit('engagement', 'Engagement', ENG), r => {
    const e = rg(r, 'engagement');
    return [tiles(ENG, has(e) ? e : null, ['pink', 'accent', 'sun', 'mint', 'warm']), has(e) ? h('div', { class: 'card flat' }, h('h2', {}, 'Share of each kind'), barList(ENG.filter(([k]) => e[k]).map(([k, l]) => ({ k: l, n: e[k] })).sort((a, b) => b.n - a.n), 'accent')) : h('p', { class: 'hint', style: 'margin:0' }, 'Nothing for this range yet. Press Edit numbers.')];
  });

  main.append(header(P.label + ' stats', D.updated ? 'Last updated ' + fmtDate(D.updated) + '. ' + P.label + ' does not share these numbers with this panel, so you type them in from ' + P.where + '.' : P.label + ' does not share its numbers with this panel. Type them in from ' + P.where + '.'),
    viewsSec, folSec, conSec, engSec);
}

/* ---------- dashboard: social profiles (numbers typed in, since these networks do not share them with this panel) ---------- */
async function viewSocial(main, key) {
  const P = PLATFORMS[key], data = (await api('GET', '/social'))[key];
  const inputs = Object.fromEntries(P.fields.concat(P.audience ? AUDIENCE : []).map(([f]) => [f, h('input', { type: 'number', min: 0, step: f === 'rating' ? '0.1' : '1', max: f === 'rating' ? 5 : (AUDIENCE.some(x => x[0] === f) ? 100 : undefined), inputmode: 'decimal', value: data.values[f] == null ? '' : data.values[f], placeholder: '0' })]));
  const bar = savebar({ view: key, live: false, onSave: () => api('PUT', '/social', { platform: key, values: Object.fromEntries(Object.entries(inputs).map(([f, el]) => [f, el.value])) }) });
  const tile = ([f, label], i) => {
    const v = data.values[f], p = data.prev ? data.prev[f] : null;
    const sub = v == null ? 'Not added yet' : (p == null || !data.prevUpdated ? null : (v === p ? 'No change' : (v > p ? '+' : '-') + num(Math.abs(Math.round((v - p) * 100) / 100)) + ' since ' + fmtDate(data.prevUpdated)));
    return stat(v == null ? '-' : num(v), label, ['accent', 'pink', 'sun', 'mint', 'warm'][i % 5], sub);
  };
  const form = h('form', { class: 'card', onsubmit: e => e.preventDefault() },
    h('h2', {}, 'Update numbers'),
    h('p', { class: 'hint' }, P.label + ' does not share these numbers with this panel, so type them in from ' + P.where + '. Each save updates the tiles above and shows the change since the last update.'),
    h('div', { class: 'fgrid' }, ...P.fields.map(([f, label]) => field(label, inputs[f]))),
    P.audience ? h('div', {}, h('h2', { class: 'sub' }, 'Audience, in percent'), h('p', { class: 'hint' }, 'Age group and gender of your followers, from ' + P.audience + '. Enter each as a percent.'),
      h('div', { class: 'fgrid' }, ...AUDIENCE.map(([f, label]) => field(label + ' (%)', inputs[f])))) : null);
  const aud = P.audience && AUDIENCE.some(([f]) => data.values[f] != null) ? h('div', { class: 'two' },
    h('div', { class: 'card' }, h('h2', {}, 'Gender'), barList(AUDIENCE.slice(0, 2).filter(([f]) => data.values[f] != null).map(([f, l]) => ({ k: l, n: data.values[f] })), 'pink', n => n + '%')),
    h('div', { class: 'card' }, h('h2', {}, 'Age group'), barList(AUDIENCE.slice(2).filter(([f]) => data.values[f] != null).map(([f, l]) => ({ k: l.replace('Age ', ''), n: data.values[f] })), 'accent', n => n + '%'))) : null;
  form.addEventListener('input', () => bar.mark());
  main.append(header(P.label + ' stats', data.updated ? 'Last updated ' + fmtDate(data.updated) + '.' : 'Nothing added yet. Type in your current numbers below.'),
    h('div', { class: 'stats' }, ...P.fields.map(tile)), aud, form, bar.el);
}

/* ---------- work: pieces in one category (logo, social media, brochures, banners, other printables) ---------- */
const WORK_SIZE = { ...Object.fromEntries(Object.keys(WORK).map(k => [k, [1080, 1350]])), branding: [1920, 1080] }; /* 1080 x 1350 px (portrait) uploads; Branding: a 1920 x 1080 thumbnail plus a PDF */
async function viewWork(main, cat) {
  const size = WORK_SIZE[cat] || null, shape = size ? (size[0] === size[1] ? ' sq' : size[0] > size[1] ? ' ls' : ' pt') : '', needPdf = cat === 'branding';
  const [label, color, example] = WORK[cat];
  const data = await api('GET', '/work?category=' + cat);
  /* pending = a newly chosen image that uploads when you press Save */
  const draft = data.map(w => ({ title: w.title, label: w.label, image: w.image, file: w.file || '', published: w.published, pending: null, pfile: null }));
  /* Image composition also controls the Before / After slider of the website */
  const cmp = cat === 'composition' ? { ...(await api('GET', '/compare')), pb: null, pa: null } : null;
  /* Image editing also controls the video box of the website: a YouTube link that plays right there */
  const ev = cat === 'editing' ? await api('GET', '/editvideo') : null;
  const bar = savebar({ view: 'work-' + cat, onSave: async () => {
    for (const w of draft) {
      if (w.pending) { const up = await api('POST', '/upload', { dataUrl: w.pending }); w.image = up.url; w.pending = null; }
      if (w.pfile) { const up = await api('POST', '/upload', { dataUrl: w.pfile.dataUrl }); w.file = up.url; w.pfile = null; }
    }
    if (cmp) {
      if (cmp.pb) { cmp.before = (await api('POST', '/upload', { dataUrl: cmp.pb })).url; cmp.pb = null; }
      if (cmp.pa) { cmp.after = (await api('POST', '/upload', { dataUrl: cmp.pa })).url; cmp.pa = null; }
      await api('PUT', '/compare', { before: cmp.before, after: cmp.after });
    }
    if (ev) { const id = ytId(ev.url || ''); if (ev.url && !id) throw new Error('Paste a valid YouTube video link'); await api('PUT', '/editvideo', { url: id ? 'https://www.youtube.com/watch?v=' + id : '' }); }
    await api('PUT', '/work', { category: cat, items: draft.map(({ title, label, image, file, published }) => ({ title, label, image, file, published })) });
  } });
  const rows = h('div', { class: 'list' });
  const touch = () => { bar.mark(); draw(); };
  const move = (i, d) => { [draft[i], draft[i + d]] = [draft[i + d], draft[i]]; touch(); };
  const wthumb = w => { const src = w.pending || imgSrc(w.image); const b = h('div', { class: 'wthumb', color }); if (src) { const img = h('img', { src, alt: '' }); img.addEventListener('error', () => img.remove()); b.append(img); } else b.append(h('i', { 'aria-hidden': 'true' })); return b; };
  const row = (w, i) => h('div', { class: 'item trow' }, wthumb(w),
    h('div', { class: 'trk' }, h('h3', {}, w.title), h('p', { class: 'meta' }, (w.label || 'No detail line') + (needPdf ? ((w.pfile || w.file) ? ' · PDF attached' : ' · No PDF yet') : '')),
      h('span', { class: 'pill', color: w.published ? 'mint' : 'sun' }, w.published ? 'On website' : 'Hidden')),
    h('div', { class: 'acts' },
      h('button', { class: 'btn sm', type: 'button', disabled: i === 0, 'aria-label': 'Move up', onclick: () => move(i, -1) }, 'Up'),
      h('button', { class: 'btn sm', type: 'button', disabled: i === draft.length - 1, 'aria-label': 'Move down', onclick: () => move(i, 1) }, 'Down'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => workForm(w, touch) }, 'Edit'),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => { draft.splice(i, 1); touch(); } }, 'Remove')));
  /* How the pieces look on the website: each one is a slide in the "Work that earns attention" gallery, in this order */
  const slides = h('div', { class: 'slides' + shape, role: 'list' });
  const drawSlides = () => {
    const live = draft.filter(w => w.published);
    slides.replaceChildren(...(live.length ? live.map((w, i) => h('div', { class: 'slide', role: 'listitem' },
      h('div', { class: 'slide-art', color }, (w.pending || imgSrc(w.image)) ? h('img', { src: w.pending || imgSrc(w.image), alt: w.title }) : h('i', { 'aria-hidden': 'true' }), h('span', { class: 'slide-idx' }, String(i + 1).padStart(2, '0'))),
      h('div', { class: 'slide-cap' }, h('b', {}, w.title), h('small', {}, w.label || ' '))))
      : [h('div', { class: 'empty' }, 'Nothing to show yet. Your website keeps its sample ' + label.toLowerCase() + ' slides until you add a piece.')]));
  };
  const draw = () => { rows.replaceChildren(...(draft.length ? draft.map(row) : [h('div', { class: 'empty' }, 'No pieces yet. Until you add one, your website keeps its sample ' + label.toLowerCase() + ' tiles.')])); drawSlides(); };
  const workForm = (w, done) => {
    const v = w || { title: '', label: '', image: '', published: true, pending: null };
    let pending = v.pending, shown = v.pending || imgSrc(v.image) || '';
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    const prev = h('div', { class: 'tprev' });
    const sizeNote = h('p', { class: 'hint' });
    /* pieces are 1080 x 1080 squares: the preview is square, and an image of another size gets a gentle note */
    const sz = size ? size[0] + ' x ' + size[1] + ' px' : '';
    const checkSize = src => { sizeNote.textContent = ''; sizeNote.className = 'hint'; if (!src || !size) return; const im = new Image(); im.onload = () => { const ok = im.naturalWidth === size[0] && im.naturalHeight === size[1]; sizeNote.textContent = ok ? 'Size ' + sz + '. Perfect.' : 'This image is ' + im.naturalWidth + ' x ' + im.naturalHeight + ' px. Use ' + sz + ' so nothing is cropped.'; sizeNote.className = 'hint ' + (ok ? 'good' : 'badtxt'); }; im.src = src; };
    const paint = () => prev.replaceChildren(h('div', { class: 'wthumb big' + shape, color }, shown ? h('img', { src: shown, alt: 'Preview' }) : h('i', { 'aria-hidden': 'true' })));
    file.addEventListener('change', wrap(async () => {
      const f = file.files[0]; if (!f) return;
      if (f.size > 5 * 1024 * 1024) { file.value = ''; throw new Error('Image is larger than 5 MB'); }
      pending = await readDataUrl(f); shown = pending; paint(); checkSize(pending);
    }));
    const title = h('input', { type: 'text', value: v.title, required: true, maxlength: 80, placeholder: 'Orbit Coffee' });
    const lab = h('input', { type: 'text', value: v.label, maxlength: 80, placeholder: example });
    const pub = h('input', { type: 'checkbox', checked: v.published });
    /* Branding: the full brand identity as a PDF, opened from the card on the website */
    let pfile = v.pfile || null;
    const pdf = h('input', { type: 'file', accept: 'application/pdf' }), pdfName = h('p', { class: 'hint' });
    const showPdf = () => { pdfName.textContent = pfile ? 'New PDF: ' + pfile.name : v.file ? 'Current PDF: ' + v.file.split('/').pop() : 'No PDF chosen yet.'; };
    pdf.addEventListener('change', wrap(async () => { const f = pdf.files[0]; if (!f) return; if (f.size > 10 * 1024 * 1024) { pdf.value = ''; throw new Error('PDF is larger than 10 MB'); } pfile = { name: f.name, dataUrl: await readDataUrl(f) }; showPdf(); pdfName.textContent += ' · making the thumbnail...';
      try { pending = await pdfThumb(f); shown = pending; paint(); showPdf(); } catch (e) { pfile = null; pdf.value = ''; showPdf(); throw new Error('Could not read this PDF. Try another file.'); } }));
    showPdf();
    paint();
    modal(w ? 'Edit piece' : 'Add piece', h('div', {}, ...(needPdf ? [field('Branding PDF', dropBox(pdf), 'Upload the full brand identity as a PDF, up to 10 MB. The 1920 x 1080 thumbnail is made from its first page.'), pdfName, prev] : [field('Image', dropBox(file), (w ? 'Choose a new image to replace the current one. ' : '') + (size ? 'Size ' + sz + (size[0] === size[1] ? ' (square)' : ' (portrait)') + '. ' : '') + 'PNG, JPG or WebP up to 5 MB.'), prev, sizeNote]), field('Title', title), field('Detail line', lab, 'Small text under the title, for example ' + example + '.'), h('label', { class: 'check' }, pub, 'Show on the website')),
      async () => {
        if (!title.value.trim()) throw new Error('Add a title');
        if (!pending && !v.image) throw new Error(needPdf ? 'Choose the branding PDF' : 'Choose an image');
        if (needPdf && !pfile && !v.file) throw new Error('Choose the branding PDF');
        const rec = { title: title.value.trim(), label: lab.value.trim(), published: pub.checked, pending: pending || null, image: v.image, file: v.file || '', pfile };
        if (w) Object.assign(w, rec); else draft.push(rec);
        done();
      }, w ? 'Update piece' : 'Add piece');
  };
  /* Before / After card (Image composition only): two pictures for the slider on the website */
  const compareCard = () => {
    const slot = (key, pend, name) => {
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': name + ' image' }), prev = h('div', { class: 'tprev' });
      const paint = () => { const src = cmp[pend] || imgSrc(cmp[key]); prev.replaceChildren(h('div', { class: 'wthumb big', color: 'accent' }, src ? h('img', { src, alt: name + ' preview' }) : h('i', { 'aria-hidden': 'true' }))); clear.hidden = !(cmp[pend] || cmp[key]); drawPrev(); };
      const clear = h('button', { class: 'btn sm', type: 'button', onclick: () => { cmp[pend] = null; cmp[key] = ''; file.value = ''; paint(); bar.mark(); } }, 'Remove');
      file.addEventListener('change', wrap(async () => {
        const f = file.files[0]; if (!f) return;
        if (f.size > 5 * 1024 * 1024) { file.value = ''; throw new Error('Image is larger than 5 MB'); }
        cmp[pend] = await readDataUrl(f); paint(); bar.mark();
      }));
      paint();
      return h('div', {}, field(name + ' image', dropBox(file), 'PNG, JPG or WebP up to 5 MB.'), prev, clear);
    };
    return h('div', { class: 'card' }, h('h2', {}, 'Before and After slider'),
      h('p', { class: 'hint', style: 'margin:6px 0 14px' }, 'The "Image composition skills" slider on your website. Visitors drag it to compare the two pictures. Add both, or remove both to show the sample slider again. Use two pictures of the same size for the best result.'),
      h('div', { class: 'ba-form' }, slot('before', 'pb', 'Before'), slot('after', 'pa', 'After')));
  };
  function videoCard() {
    const inp = h('input', { type: 'url', value: ev.url || '', placeholder: 'https://www.youtube.com/watch?v=...', autocomplete: 'off', 'aria-label': 'YouTube video link' });
    const hint = h('p', { class: 'hint' }), tp = h('div', { class: 'tprev vprev' });
    const check = () => {
      const v = inp.value.trim(), id = ytId(v); tp.replaceChildren();
      if (!v) { hint.textContent = 'Paste a YouTube link. Leave it empty to show the original video box.'; hint.className = 'hint'; drawPrev(); return; }
      if (id) tp.append(thumb(v)); hint.textContent = id ? 'Link looks good. This thumbnail shows on the website; the video plays when a visitor presses play.' : 'This is not a YouTube video link.'; hint.className = 'hint ' + (id ? 'good' : 'badtxt'); drawPrev();
    };
    inp.addEventListener('input', () => { ev.url = inp.value.trim(); bar.mark(); check(); });
    check();
    return h('div', { class: 'card' }, h('h2', {}, 'Video on your website'), h('p', { class: 'hint', style: 'margin:0 0 12px' }, 'Plays inside the video box of "Image editing skills" on your website.'), field('YouTube video link', inp), hint, tp);
  }
  const pvBody = h('div', {});
  const drawPrev = () => {
    if (ev) { const id = ytId(ev.url || ''); pvBody.replaceChildren(id ? h('div', { class: 'tprev vprev' }, thumb(ev.url)) : h('div', { class: 'empty' }, 'No video link yet. Your website keeps its original video box.')); }
    else if (cmp) {
      const one = (key, pend, name) => { const src = cmp[pend] || imgSrc(cmp[key]); return h('div', {}, h('div', { class: 'wthumb big', color }, src ? h('img', { src, alt: name }) : h('i', { 'aria-hidden': 'true' })), h('p', { class: 'hint', style: 'margin:6px 0 0' }, name)); };
      pvBody.replaceChildren((cmp.before || cmp.pb || cmp.after || cmp.pa) ? h('div', { class: 'ba-form' }, one('before', 'pb', 'Before'), one('after', 'pa', 'After')) : h('div', { class: 'empty' }, 'No pictures yet. Your website keeps its sample slider.'));
    }
  };
  const prevCard = () => { drawPrev(); return h('div', { class: 'card' }, h('h2', {}, 'On your website'), h('p', { class: 'hint', style: 'margin:6px 0 12px' }, ev ? 'How the video box of "Image editing skills" will look to visitors.' : 'How the "Image composition skills" slider pictures will look to visitors.'), pvBody); };
  const noPieces = !!(cmp || ev);
  main.append(header(label, noPieces ? (cmp ? 'The Before and After slider for "' + label + '" on your website.' : 'The video for "' + label + '" on your website.') : 'Pieces shown under "' + label + '" in the Work section of your website. The top one shows first.', ...(noPieces ? [] : [h('button', { class: 'btn solid', type: 'button', onclick: () => workForm(null, touch) }, 'Add piece')])), ...(cmp ? [compareCard(), h('div', { style: 'height:18px' })] : []), ...(ev ? [videoCard(), h('div', { style: 'height:18px' })] : []), ...(noPieces ? [] : [h('h2', { class: 'sec' }, 'Pieces'), rows, h('div', { style: 'height:18px' }), h('div', { class: 'card' }, h('h2', {}, 'On your website'), h('p', { class: 'hint', style: 'margin:6px 0 12px' }, 'Every piece you add becomes one slide in "Work that earns attention", under the "' + label + '" filter, in this order. Image files only (PNG, JPG or WebP).'), slides)]), ...(noPieces ? [h('div', { style: 'height:18px' }), prevCard()] : []), bar.el);
  draw();
}

/* ---------- project brief: briefs sent from the Hire form, one menu per status (each card has its own Save and Cancel) ---------- */
async function viewBriefs(main, cat) {
  const all = (await api('GET', '/inquiries')).filter(i => briefCats(i.service).has(cat));
  let filter = 'all';
  const box = h('div', { class: 'list' }), tabs = h('div', { class: 'tabs' });
  const draw = () => {
    tabs.replaceChildren(...['all', ...Object.keys(BRIEF)].map(k => h('button', { class: 'tab' + (filter === k ? ' on' : ''), type: 'button', onclick: () => { filter = k; draw(); } },
      (k === 'all' ? 'All' : BRIEF[k][0]) + ' (' + (k === 'all' ? all.length : all.filter(i => i.status === k).length) + ')')));
    const rows = all.filter(i => filter === 'all' || i.status === filter);
    box.replaceChildren(...(rows.length ? rows.map(card) : [h('div', { class: 'empty' }, all.length ? 'Nothing with this status.' : 'No briefs yet. They show up here when someone asks for ' + BRIEF_CATS[cat][0].toLowerCase() + ' in the Hire form on your website.')]));
  };
  const card = i => {
    const sel = h('select', { 'aria-label': 'Status' }, ...Object.entries(BRIEF).map(([k, [label]]) => h('option', { value: k }, label))); sel.value = i.status;
    const note = h('input', { type: 'text', placeholder: 'Private note', maxlength: 1000, value: i.note || '' });
    const touch = v => { cancel.disabled = save.disabled = !v; };
    const cancel = h('button', { class: 'btn sm', type: 'button', disabled: true, onclick: () => { sel.value = i.status; note.value = i.note || ''; touch(false); } }, 'Cancel');
    const save = h('button', { class: 'btn sm solid', type: 'button', disabled: true, onclick: wrap(async () => {
      await api('PUT', '/inquiries/' + i.id, { status: sel.value, note: note.value }); const moved = sel.value !== i.status; i.status = sel.value; i.note = note.value;
      toast(moved ? 'Saved. Status is now ' + BRIEF[i.status][0] : 'Saved'); draw(); refreshBadge();
    }) }, 'Save');
    sel.addEventListener('change', () => touch(true)); note.addEventListener('input', () => touch(true));
    const details = [['Business', i.business], ['WhatsApp', i.whatsapp], ['Size', i.size], ['Quality', i.quality], ['Needed by', i.needed_by]].filter(x => x[1]);
    return h('div', { class: 'inq' },
      h('div', { class: 'top' }, h('div', {}, h('h3', {}, i.name), h('p', { class: 'meta muted' }, i.email + ' · ' + fmtDate(i.created_at))),
        h('span', { class: 'pill', color: BRIEF[i.status][1] }, BRIEF[i.status][0])),
      h('p', { class: 'mono' }, i.service || 'General brief'),
      details.length ? h('p', { class: 'meta muted' }, details.map(x => x[0] + ': ' + x[1]).join('  ·  ')) : null,
      h('p', { class: 'msg' }, i.message),
      h('div', { class: 'bar' }, sel, note, cancel, save,
        h('a', { class: 'btn sm', href: 'mailto:' + encodeURIComponent(i.email).replace('%40', '@') + '?subject=' + encodeURIComponent('Re: your project brief') }, 'Reply by email'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: wrap(async () => { if (confirm('Delete this brief?')) { await api('DELETE', '/inquiries/' + i.id); all.splice(all.indexOf(i), 1); draw(); refreshBadge(); } }) }, 'Delete')));
  };
  const refreshBadge = async () => { briefNew = await newByCat(); Object.keys(BRIEF_CATS).forEach(k => { const n = [...document.querySelectorAll('aside .nav')].find(x => x.textContent.replace(/\d+$/, '') === BRIEF_CATS[k][0]); if (n) { n.querySelector('.count')?.remove(); if (briefNew[k]) n.append(h('span', { class: 'count' }, briefNew[k])); } }); };
  main.append(header(BRIEF_CATS[cat][0], 'Project briefs asking for ' + BRIEF_CATS[cat][0].toLowerCase() + ', sent from the Hire form on your website. Each brief has its own Save and Cancel.'), tabs, box); draw();
}

/* ---------- client feedback: feedbacks (shown in Client Feedback) and questions (shown in the FAQ) ---------- */
async function viewFeedbacks(main) {
  const draft = (await api('GET', '/feedbacks')).map(({ name, role, quote, published }) => ({ name, role, quote, published }));
  const bar = savebar({ view: 'feedbacks', onSave: () => api('PUT', '/feedbacks', { items: draft }) });
  const rows = h('div', { class: 'list' });
  const touch = () => { bar.mark(); draw(); };
  const move = (i, d) => { [draft[i], draft[i + d]] = [draft[i + d], draft[i]]; touch(); };
  const row = (t, i) => h('div', { class: 'item noimg' },
    h('div', { class: 'trk' }, h('h3', {}, t.name + (t.role ? ' · ' + t.role : '')), h('p', { class: 'meta' }, '"' + t.quote + '"'),
      h('span', { class: 'pill', color: t.published ? 'mint' : 'sun' }, t.published ? 'On website' : 'Hidden')),
    h('div', { class: 'acts' },
      h('button', { class: 'btn sm', type: 'button', disabled: i === 0, 'aria-label': 'Move up', onclick: () => move(i, -1) }, 'Up'),
      h('button', { class: 'btn sm', type: 'button', disabled: i === draft.length - 1, 'aria-label': 'Move down', onclick: () => move(i, 1) }, 'Down'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => feedbackForm(t, touch) }, 'Edit'),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => { draft.splice(i, 1); touch(); } }, 'Remove')));
  const draw = () => rows.replaceChildren(...(draft.length ? draft.map(row) : [h('div', { class: 'empty' }, 'No feedback yet. Until you add some, your website keeps its sample reviews.')]));
  main.append(header('Feedbacks', 'Kind words from clients, shown in Client Feedback on your website.', h('button', { class: 'btn solid', type: 'button', onclick: () => feedbackForm(null, touch, draft) }, 'Add feedback')), rows, bar.el);
  draw();
}
function feedbackForm(t, done, list) {
  const v = t || { name: '', role: '', quote: '', published: true };
  const name = h('input', { type: 'text', value: v.name, required: true, maxlength: 100 });
  const role = h('input', { type: 'text', value: v.role, maxlength: 100, placeholder: 'Founder, Studio name' });
  const quote = h('textarea', { required: true, maxlength: 1000 }); quote.value = v.quote;
  const pub = h('input', { type: 'checkbox', checked: v.published });
  modal(t ? 'Edit feedback' : 'Add feedback', h('div', {}, field('Client name', name), field('Role or company', role), field('Feedback', quote), h('label', { class: 'check' }, pub, 'Show on the website')),
    async () => {
      if (!name.value.trim() || !quote.value.trim()) throw new Error('Name and feedback are required');
      const rec = { name: name.value.trim(), role: role.value.trim(), quote: quote.value.trim(), published: pub.checked };
      if (t) Object.assign(t, rec); else list.push(rec);
      done();
    }, t ? 'Update' : 'Add feedback');
}
async function viewQuestions(main) {
  const draft = (await api('GET', '/questions')).map(({ question, answer, published }) => ({ question, answer, published }));
  const bar = savebar({ view: 'questions', onSave: () => api('PUT', '/questions', { items: draft }) });
  const rows = h('div', { class: 'list' });
  const touch = () => { bar.mark(); draw(); };
  const move = (i, d) => { [draft[i], draft[i + d]] = [draft[i + d], draft[i]]; touch(); };
  const row = (x, i) => h('div', { class: 'item noimg' },
    h('div', { class: 'trk' }, h('h3', {}, x.question), h('p', { class: 'meta' }, x.answer),
      h('span', { class: 'pill', color: x.published ? 'mint' : 'sun' }, x.published ? 'On website' : 'Hidden')),
    h('div', { class: 'acts' },
      h('button', { class: 'btn sm', type: 'button', disabled: i === 0, 'aria-label': 'Move up', onclick: () => move(i, -1) }, 'Up'),
      h('button', { class: 'btn sm', type: 'button', disabled: i === draft.length - 1, 'aria-label': 'Move down', onclick: () => move(i, 1) }, 'Down'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => questionForm(x, touch) }, 'Edit'),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => { draft.splice(i, 1); touch(); } }, 'Remove')));
  const draw = () => rows.replaceChildren(...(draft.length ? draft.map(row) : [h('div', { class: 'empty' }, 'No questions yet. Until you add some, your website keeps its sample questions and answers.')]));
  main.append(header('Questions', 'Questions and answers shown in the Frequently Asked Questions section of your website.', h('button', { class: 'btn solid', type: 'button', onclick: () => questionForm(null, touch, draft) }, 'Add question')), rows, bar.el);
  draw();
}
function questionForm(x, done, list) {
  const v = x || { question: '', answer: '', published: true };
  const q = h('input', { type: 'text', value: v.question, required: true, maxlength: 200, placeholder: 'How long does a logo take?' });
  const ans = h('textarea', { required: true, maxlength: 2000 }); ans.value = v.answer;
  const pub = h('input', { type: 'checkbox', checked: v.published });
  modal(x ? 'Edit question' : 'Add question', h('div', {}, field('Question', q), field('Answer', ans), h('label', { class: 'check' }, pub, 'Show on the website')),
    async () => {
      if (!q.value.trim() || !ans.value.trim()) throw new Error('Add a question and an answer');
      const rec = { question: q.value.trim(), answer: ans.value.trim(), published: pub.checked };
      if (x) Object.assign(x, rec); else list.push(rec);
      done();
    }, x ? 'Update' : 'Add question');
}

/* ---------- business moderation: client grievances you log and track (private, never shown on the website) ---------- */
const GRIEVANCE = { open: ['Open', 'warm'], progress: ['In progress', 'sun'], resolved: ['Resolved', 'mint'], closed: ['Closed', 'sky'] };
const PRIORITY = { low: ['Low', 'sky'], medium: ['Medium', 'sun'], high: ['High', 'warm'] };
async function viewGrievances(main) {
  const draft = await api('GET', '/grievances');
  const bar = savebar({ view: 'grievances', live: false, onSave: () => api('PUT', '/grievances', { items: draft }) });
  let filter = 'all';
  const tabs = h('div', { class: 'tabs' }), rows = h('div', { class: 'list' });
  const touch = () => { bar.mark(); draw(); };
  const card = g => h('div', { class: 'inq' },
    h('div', { class: 'top' }, h('div', {}, h('h3', {}, g.name), h('p', { class: 'meta muted' }, [g.contact, g.project, fmtDate(g.created_at)].filter(Boolean).join(' · '))),
      h('div', { class: 'acts' }, h('span', { class: 'pill', color: PRIORITY[g.priority][1] }, PRIORITY[g.priority][0] + ' priority'), h('span', { class: 'pill', color: GRIEVANCE[g.status][1] }, GRIEVANCE[g.status][0]))),
    h('p', { class: 'msg' }, g.issue),
    g.resolution ? h('p', { class: 'meta' }, 'Resolution: ' + g.resolution) : null,
    h('div', { class: 'bar' }, h('button', { class: 'btn sm', type: 'button', onclick: () => grievanceForm(g, touch) }, 'Edit'),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => { if (confirm('Remove this grievance?')) { draft.splice(draft.indexOf(g), 1); touch(); } } }, 'Remove')));
  const draw = () => {
    tabs.replaceChildren(...['all', ...Object.keys(GRIEVANCE)].map(k => h('button', { class: 'tab' + (filter === k ? ' on' : ''), type: 'button', onclick: () => { filter = k; draw(); } },
      (k === 'all' ? 'All' : GRIEVANCE[k][0]) + ' (' + (k === 'all' ? draft.length : draft.filter(g => g.status === k).length) + ')')));
    const list = draft.filter(g => filter === 'all' || g.status === filter);
    rows.replaceChildren(...(list.length ? list.map(card) : [h('div', { class: 'empty' }, draft.length ? 'Nothing with this status.' : 'No grievances yet. When a client sends one from the Help button on your website, it shows up here.')]));
  };
  main.append(header('Client Grievance', 'Complaints sent by clients from the Help button on your website. Each one arrives here as Open. Set its priority and status and note how you resolved it. Only you can see this list.'), tabs, rows, bar.el);
  draw();
}
function grievanceForm(g, done, list) {
  const v = g || { name: '', contact: '', project: '', issue: '', priority: 'medium', status: 'open', resolution: '' };
  const name = h('input', { type: 'text', value: v.name, required: true, maxlength: 100 });
  const contact = h('input', { type: 'text', value: v.contact, maxlength: 200, placeholder: 'Email or WhatsApp' });
  const project = h('input', { type: 'text', value: v.project, maxlength: 120, placeholder: 'Logo for Orbit Coffee' });
  const issue = h('textarea', { required: true, maxlength: 3000 }); issue.value = v.issue;
  const sel = (map, val) => { const s = h('select', {}, ...Object.entries(map).map(([k, [label]]) => h('option', { value: k }, label))); s.value = val; return s; };
  const priority = sel(PRIORITY, v.priority), status = sel(GRIEVANCE, v.status);
  const resolution = h('textarea', { maxlength: 3000, placeholder: 'What you did to sort it out' }); resolution.value = v.resolution;
  modal(g ? 'Edit grievance' : 'Add grievance', h('div', {}, field('Client name', name), h('div', { class: 'row' }, field('Contact', contact), field('Project', project)), field('Issue', issue),
      h('div', { class: 'row' }, field('Priority', priority), field('Status', status)), field('Resolution', resolution)),
    async () => {
      if (!name.value.trim() || !issue.value.trim()) throw new Error('Add the client name and the issue');
      const rec = { name: name.value.trim(), contact: contact.value.trim(), project: project.value.trim(), issue: issue.value.trim(), priority: priority.value, status: status.value, resolution: resolution.value.trim() };
      if (g) Object.assign(g, rec); else list.unshift({ ...rec, created_at: Date.now() });
      done();
    }, g ? 'Update' : 'Add grievance');
}

/* ---------- hero section: music (YouTube links) ---------- */
function ytId(u) {
  try {
    const x = new URL(String(u).trim()); const host = x.hostname.replace(/^(www|m|music)\./, ''); let id = '';
    if (host === 'youtu.be') id = x.pathname.slice(1);
    else if (host === 'youtube.com') { if (x.pathname === '/watch') id = x.searchParams.get('v') || ''; else { const m = x.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/); id = m ? m[1] : ''; } }
    return /^[\w-]{11}$/.test(id) ? id : '';
  } catch { return ''; }
}
const THUMBS = true; /* show the real YouTube thumbnail; a play-button tile is the fallback */
const imgSrc = u => u && (THUMBS || /^data:/.test(u)) ? u : ''; /* uploaded images show as thumbnails (the artifact preview can only show the ones it holds itself) */
function thumb(url) {
  const id = ytId(url);
  const box = h('div', { class: 'tthumb' });
  if (THUMBS && id) {
    /* try several YouTube thumbnail addresses in turn; if none loads, the play tile with the video ID stays */
    const srcs = ['https://i.ytimg.com/vi/' + id + '/mqdefault.jpg', 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg', 'https://img.youtube.com/vi/' + id + '/0.jpg'];
    let n = 0; const img = h('img', { alt: '', referrerpolicy: 'no-referrer', src: srcs[0] });
    img.addEventListener('error', () => { n++; if (n < srcs.length) img.src = srcs[n]; else img.remove(); });
    img.addEventListener('load', () => { if (img.naturalWidth && img.naturalWidth <= 120) { n++; if (n < srcs.length) img.src = srcs[n]; else img.remove(); } });
    box.append(img);
    box.append(h('span', { class: 'tid' }, 'YouTube · ' + id));
  }
  box.append(h('i', { class: 'tplay', 'aria-hidden': 'true' }));
  return box;
}
async function viewMusic(main) {
  const data = await api('GET', '/music');
  const draft = { enabled: true, tracks: data.tracks.map(t => ({ url: t.url, published: t.published })) };
  const bar = savebar({ view: 'music', onSave: () => api('PUT', '/music', draft) });
  const rows = h('div', { class: 'list' });
  const touch = () => { bar.mark(); draw(); };
  const move = (i, d) => { const t = draft.tracks; [t[i], t[i + d]] = [t[i + d], t[i]]; touch(); };
  const row = (t, i) => h('div', { class: 'item trow' }, thumb(t.url),
    h('div', { class: 'trk' }, h('h3', {}, 'Track ' + (i + 1)), h('p', { class: 'meta link' }, t.url),
      h('span', { class: 'pill', color: t.published ? 'mint' : 'sun' }, t.published ? 'In player' : 'Hidden')),
    h('div', { class: 'acts' },
      h('button', { class: 'btn sm', type: 'button', disabled: i === 0, 'aria-label': 'Move up', onclick: () => move(i, -1) }, 'Up'),
      h('button', { class: 'btn sm', type: 'button', disabled: i === draft.tracks.length - 1, 'aria-label': 'Move down', onclick: () => move(i, 1) }, 'Down'),
      h('a', { class: 'btn sm', href: t.url, target: '_blank', rel: 'noopener' }, 'Open'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => trackForm(t, touch) }, 'Edit'),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => { draft.tracks.splice(i, 1); touch(); } }, 'Remove')));
  const draw = () => rows.replaceChildren(...(draft.tracks.length ? draft.tracks.map(row) : [h('div', { class: 'empty' }, 'No tracks yet. Paste a YouTube link to add your first one.')]));
  main.append(header('Music', 'Tracks in the player on your hero section. Each track is a YouTube link, and the top one plays first.',
      h('button', { class: 'btn solid', type: 'button', onclick: () => trackForm(null, touch, draft.tracks) }, 'Add track')),
    rows, bar.el);
  draw();
}
function trackForm(t, done, list) {
  const v = t || { url: '', published: true };
  const url = h('input', { type: 'url', id: 'yt', value: v.url, required: true, placeholder: 'https://www.youtube.com/watch?v=...', autocomplete: 'off' });
  const hint = h('p', { class: 'hint' }, 'Paste a YouTube video link (youtube.com or youtu.be).');
  const tprev = h('div', { class: 'tprev' });
  const check = () => {
    tprev.replaceChildren();
    if (!url.value.trim()) { hint.textContent = 'Paste a YouTube video link (youtube.com or youtu.be).'; hint.className = 'hint'; return; }
    const id = ytId(url.value); if (id) tprev.append(thumb(url.value)); hint.textContent = id ? 'Link looks good. Video ID: ' + id : 'This is not a YouTube video link.'; hint.className = 'hint ' + (id ? 'good' : 'badtxt');
  };
  url.addEventListener('input', check); if (v.url) check();
  const pub = h('input', { type: 'checkbox', checked: v.published });
  modal(t ? 'Edit track' : 'Add track', h('div', {}, field('YouTube link', url), hint, tprev, h('div', { class: 'field' }), h('label', { class: 'check' }, pub, 'Include in the player')),
    async () => {
      const id = ytId(url.value); if (!id) throw new Error('Paste a valid YouTube video link');
      const rec = { url: 'https://www.youtube.com/watch?v=' + id, published: pub.checked };
      if (t) Object.assign(t, rec); else list.push(rec);
      done();
    }, t ? 'Update track' : 'Add track');
}

/* ---------- hero section: resume ---------- */
const RESUME_FRAME = 'pdf'; /* 'pdf' shows the real file in a frame */
function resumeFrame(src, name) {
  if (RESUME_FRAME === 'pdf') return h('iframe', { class: 'rframe', src, title: 'Resume preview' });
  return h('div', { class: 'sheet', role: 'img', 'aria-label': 'Resume preview' },
    h('div', { class: 'sh-head' }, h('i', { class: 'sh-av' }), h('div', {}, h('i', { class: 'sh-b w60' }), h('i', { class: 'sh-b w40 lite' }))),
    ...[90, 100, 84, 96, 70].map(w => h('i', { class: 'sh-b lite', style: 'width:' + w + '%' })), h('i', { class: 'sh-gap' }),
    ...[100, 88, 94, 76, 98, 60].map(w => h('i', { class: 'sh-b lite', style: 'width:' + w + '%' })), h('p', { class: 'sh-name' }, name));
}
async function viewResume(main) {
  const r = await api('GET', '/resume');
  const st = { fileUrl: r.fileUrl, fileName: r.fileName, size: r.size, updated: r.updated, pending: null, remove: false, blob: '' };
  const bar = savebar({ view: 'resume', onSave: async () => {
    const body = { visible: vis.checked };
    if (st.remove) body.removeFile = true;
    else if (st.pending) { const up = await api('POST', '/upload', { dataUrl: st.pending.dataUrl }); Object.assign(body, { fileUrl: up.url, fileName: st.pending.name, size: up.size || st.pending.size }); }
    await api('PUT', '/resume', body);
  } });
  const fname = h('h3', {}), fmeta = h('p', { class: 'meta' });
  const stage = h('div', { class: 'rstage' });
  const paint = () => {
    const has = st.pending || (st.fileName && !st.remove);
    fname.textContent = st.pending ? st.pending.name : (st.remove ? 'No resume uploaded' : (st.fileName || 'No resume uploaded'));
    fmeta.textContent = st.pending ? st.pending.size + ' · will upload when you save' : (has ? st.size + ' · updated ' + fmtDate(st.updated) : 'Upload a PDF so visitors can download it.');
    rm.hidden = !has;
    const src = st.pending ? st.blob : (has ? st.fileUrl + '#toolbar=0&navpanes=0' : '');
    stage.replaceChildren(has ? resumeFrame(src, fname.textContent) : h('div', { class: 'empty' }, 'No resume to preview yet. Upload a PDF on the left.'));
  };
  const file = h('input', { type: 'file', id: 'rf', accept: 'application/pdf', onchange: wrap(async () => {
    const f = file.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) { file.value = ''; throw new Error('PDF is larger than 10 MB'); }
    if (st.blob) URL.revokeObjectURL(st.blob);
    st.blob = URL.createObjectURL(f);
    st.pending = { dataUrl: await readDataUrl(f), name: f.name, size: Math.max(1, Math.round(f.size / 1024)) + ' KB' }; st.remove = false; paint(); bar.mark();
  }) });
  const rm = h('button', { class: 'btn sm danger', type: 'button', onclick: () => { st.pending = null; st.remove = true; file.value = ''; paint(); bar.mark(); } }, 'Remove file');
  const vis = h('input', { type: 'checkbox', checked: r.visible });
  const form = h('form', { class: 'card', onsubmit: e => e.preventDefault() },
    h('div', { class: 'filecard' }, h('div', { class: 'pdfbadge' }, 'PDF'), h('div', { class: 'fc-t' }, fname, fmeta), rm),
    field('Upload or replace file', dropBox(file), 'PDF up to 10 MB.'),
    h('label', { class: 'check' }, vis, 'Show the resume button on the website'));
  form.addEventListener('change', e => { if (e.target !== file) bar.mark(); });
  main.append(header('Resume', 'The file visitors download from your hero section.'),
    h('div', { class: 'rgrid' }, form, h('div', { class: 'card rprev' }, h('h2', {}, 'Preview'), stage)), bar.el); paint();
}

/* ---------- account ---------- */

/* ---------- day / night mode for the admin panel, saved in this browser ---------- */
function adminTheme() { try { return localStorage.getItem('sr-admin-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } }
function applyAdminTheme(t) { if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme'); }
applyAdminTheme(adminTheme());
/* admin look: Normal, Neu or Clay, saved in this browser. It styles the admin panel only. */
const ADMIN_STYLES = [['', 'Normal'], ['neu', 'Neu'], ['clay', 'Clay']];
function adminStyle() { try { const v = localStorage.getItem('sr-admin-style'); return v === 'neu' || v === 'clay' ? v : ''; } catch { return ''; } }
function applyAdminStyle(v) { if (v) document.documentElement.setAttribute('data-style', v); else document.documentElement.removeAttribute('data-style'); }
applyAdminStyle(adminStyle());
function styleButton() {
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'st-ico'); p.setAttribute('d', GROUP_ICONS['Appearance'][1][0]); svg.appendChild(p);
  const lbl = h('span', { class: 'mode-lbl' });
  const btn = h('button', { class: 'mode-btn style-btn', type: 'button', title: 'Change the look of the admin panel: Normal, Neu or Clay' }, h('span', { class: 'mode-ico', 'aria-hidden': 'true' }, svg), lbl);
  const paint = () => { const n = ADMIN_STYLES.find(x => x[0] === adminStyle())[1]; lbl.textContent = n; btn.setAttribute('aria-label', 'Admin panel style: ' + n + '. Click to change.'); btn.title = 'Style: ' + n + '. Click to change it (Normal, Neu, Clay).'; };
  btn.addEventListener('click', () => { const i = ADMIN_STYLES.findIndex(x => x[0] === adminStyle()), n = ADMIN_STYLES[(i + 1) % ADMIN_STYLES.length][0]; try { localStorage.setItem('sr-admin-style', n); } catch {} applyAdminStyle(n); paint(); });
  paint(); return btn;
}
function modeRow() { return h('div', { class: 'mode-row' }, modeButton(), styleButton()); }
function modeButton() {
  const NS = 'http://www.w3.org/2000/svg', mk = (tag, a) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const sun = mk('svg', { viewBox: '0 0 24 24', class: 'm-sun', 'aria-hidden': 'true' }); sun.appendChild(mk('circle', { cx: 12, cy: 12, r: 5 }));
  for (let i = 0; i < 8; i++) sun.appendChild(mk('rect', { x: 11, y: 1.5, width: 2, height: 3.6, rx: 1, transform: 'rotate(' + i * 45 + ' 12 12)' }));
  const moon = mk('svg', { viewBox: '0 0 24 24', class: 'm-moon', 'aria-hidden': 'true' }); moon.appendChild(mk('path', { d: 'M21 13.2A9 9 0 1 1 10.8 3a7.2 7.2 0 0 0 10.2 10.2z' }));
  const lbl = h('span', { class: 'mode-lbl' });
  const btn = h('button', { class: 'mode-btn', type: 'button', title: 'Switch between day and night mode' }, h('span', { class: 'mode-ico', 'aria-hidden': 'true' }, sun, moon), lbl);
  const paint = () => { const d = adminTheme() === 'dark'; lbl.textContent = d ? 'Night Mode' : 'Day Mode'; btn.setAttribute('aria-pressed', String(d)); };
  btn.addEventListener('click', () => { const n = adminTheme() === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('sr-admin-theme', n); } catch {} applyAdminTheme(n); paint(); });
  paint(); return btn;
}

/* ---------- website preview dock: stays on the right side of every admin page ---------- */
const SITE_FRAME = 'live'; /* 'live' shows the real website; the artifact preview swaps in a copy */
let dock = null, dockFrame = null, dockBody = null, dockLogin = null, dockSt = { open: true, wide: false, phone: false }, dockTab = 'site';
try { Object.assign(dockSt, JSON.parse(localStorage.getItem('sr-admin-dock') || '{}')); } catch {}
if (!matchMedia('(min-width: 900px)').matches) dockSt.open = false;
const saveDock = () => { try { localStorage.setItem('sr-admin-dock', JSON.stringify(dockSt)); } catch {} };
function siteSrc() {
  if (SITE_FRAME === 'live') return '/?preview=1';
  /* artifact preview: the website copy gets the current sample content, so every save shows up like on the real server */
  const c = window.__srPublicContent ? window.__srPublicContent() : null;
  const inject = '<script>window.__SR_PREVIEW__=true;window.__SR_CONTENT__=' + JSON.stringify(c).replace(/</g, '\u003c') + ';</scr' + 'ipt>';
  return URL.createObjectURL(new Blob([(window.__SITE_HTML__ || '').replace('<!--SR-CONTENT-->', inject)], { type: 'text/html' }));
}
function previewLook() {
  if (!dockFrame) return;
  try {
    const d = window.__srLookDraft; if (!d) return;
    const doc = dockFrame.contentDocument, r = doc.documentElement, sp = doc.getElementById('splash'); if (sp) sp.remove();
    if (d.theme === 'dark') r.setAttribute('data-theme', 'dark'); else r.removeAttribute('data-theme');
    if (d.style && d.style !== 'normal') r.setAttribute('data-style', d.style); else r.removeAttribute('data-style');
    const lb = doc.getElementById('themeLbl'); if (lb) lb.textContent = d.theme === 'dark' ? 'Night Mode' : 'Day Mode';
  } catch {}
}
function fitDock() {
  if (!dock || !dockFrame) return;
  const base = dockSt.phone ? 390 : 1280, w = dockBody.clientWidth || 400, hh = dockBody.clientHeight || 600, sc = Math.min(1, w / base);
  dockFrame.style.width = base + 'px'; dockFrame.style.height = (hh / sc) + 'px'; dockFrame.style.transform = 'scale(' + sc + ')';
  dockFrame.style.left = Math.max(0, (w - base * sc) / 2) + 'px';
}
function layoutDock() {
  if (!dock) return;
  const big = matchMedia('(min-width: 900px)').matches, iw = innerWidth, side = (document.querySelector('.shell.min') ? 84 : 270);
  /* inline dock: normal ~ a third of the window, wide ~ over half, but the page keeps room to work. Narrow windows: an overlay. */
  let w = dockSt.wide ? Math.min(Math.max(iw * .55, 480), 820) : Math.min(Math.max(iw * .3, 340), 440);
  const room = iw - side - 400; let inline = big;
  if (big && dockSt.wide && room < 480) { inline = false; w = Math.round(iw * .8); } /* not enough room beside the page: wide floats over it */
  else if (big) w = Math.round(Math.max(300, Math.min(w, room)));
  else w = dockSt.wide ? iw : Math.min(iw, 440);
  dock.classList.toggle('open', dockSt.open); dock.classList.toggle('phone', dockSt.phone); dock.classList.toggle('onlogin', dockTab === 'login'); dock.classList.toggle('float', !inline);
  dockBody.hidden = dockTab === 'login'; dockLogin.hidden = dockTab !== 'login';
  dock.querySelectorAll('[data-t]').forEach(t => t.setAttribute('aria-pressed', String(t.dataset.t === dockTab)));
  dock.style.width = w + 'px';
  document.documentElement.style.setProperty('--dock-w', inline && dockSt.open ? w + 'px' : '0px');
  dock.querySelector('[data-a="wide"]').setAttribute('aria-pressed', String(dockSt.wide));
  dock.querySelector('[data-a="phone"]').setAttribute('aria-pressed', String(dockSt.phone));
  dock.querySelector('[data-a="desk"]').setAttribute('aria-pressed', String(!dockSt.phone));
  dock.inert = !dockSt.open; document.getElementById('pvtab').hidden = dockSt.open;
  requestAnimationFrame(fitDock); setTimeout(fitDock, 320);
}
function ensureDock() {
  if (dock && dock.isConnected) { layoutDock(); return; }
  const b = (a, t, label, ...k) => h('button', { class: 'pvb', type: 'button', 'data-a': a, title: t, 'aria-label': t, onclick: () => act(a) }, ...k, label ? h('span', {}, label) : null);
  dockFrame = h('iframe', { class: 'pvframe', title: 'Website preview', src: siteSrc() });
  dockBody = h('div', { class: 'pvwrap' }, dockFrame);
  dockLogin = h('div', { class: 'pvlogin login', hidden: true });
  const tabBtn = (t, label) => h('button', { class: 'pvb', type: 'button', 'data-t': t, onclick: () => { dockTab = t; if (t === 'login') dockLogin.replaceChildren(...loginScene(loginForm('', true).form)); layoutDock(); } }, label);
  const open = h('a', { class: 'pvb', href: '/', target: '_blank', rel: 'noopener', title: 'Open the website in a new tab' }, h('span', {}, 'Open'));
  dock = h('aside', { id: 'pvdock', 'aria-label': 'Website preview' },
    h('div', { class: 'pvhead' }, h('div', { class: 'pvtabs' }, tabBtn('site', 'Website'), tabBtn('login', 'Admin login')),
      h('div', { class: 'pvctl' }, b('desk', 'Desktop view', 'Desktop'), b('phone', 'Phone view', 'Phone'), b('wide', 'Make the preview wider or narrower', 'Wider'), b('reload', 'Reload the preview', 'Reload'), open, b('close', 'Collapse the preview', '', h('i', { class: 'pv-x', 'aria-hidden': 'true' })))),
    dockBody, dockLogin, h('p', { class: 'pvhint' }, 'The real website. Click, scroll and try everything. It reloads after every save.'));
  const tab = h('button', { id: 'pvtab', type: 'button', title: 'Show the website preview', onclick: () => act('open') }, h('i', { 'aria-hidden': 'true' }), h('span', {}, 'Preview'));
  document.body.append(dock, tab);
  dockFrame.addEventListener('load', () => { previewLook(); setTimeout(previewLook, 400); setTimeout(previewLook, 1500); if (pvPending) { const t = pvPending; setTimeout(() => pvScroll(t, false), 700); } });
  if (window.ResizeObserver) new ResizeObserver(fitDock).observe(dockBody);
  addEventListener('resize', layoutDock);
  layoutDock();
}
function act(a) {
  if (a === 'reload') return reloadPreview(true);
  if (a === 'close') dockSt.open = false; else if (a === 'open') dockSt.open = true;
  else if (a === 'wide') dockSt.wide = !dockSt.wide; else if (a === 'phone') dockSt.phone = true; else if (a === 'desk') dockSt.phone = false;
  saveDock(); layoutDock();
}
function removeDock() { if (dock) dock.remove(); const t = document.getElementById('pvtab'); if (t) t.remove(); dock = dockFrame = dockBody = null; document.documentElement.style.setProperty('--dock-w', '0px'); }
/* The preview follows the menu: opening a page or a menu group scrolls the website to the part it edits. */
const GROUP_TARGET = { 'Hero section': 'top', 'Appearance': 'top', 'Work': '#work', 'Client Feedback': '#feedback', 'Project Brief': '#hire' };
const VIEW_TARGET = { style: 'top', theme: 'top', panels: 'top', 'work-branding': '#work > .brand-block', 'work-editing': '#photo', 'work-composition': '#composition', questions: '#faq' };
let pvPending = null;
const targetFor = name => VIEW_TARGET[name] || (VIEWS[name] && GROUP_TARGET[VIEWS[name][3]]) || null;
function pvScroll(target, smooth = true) {
  if (!target || !dockFrame) return;
  try {
    const w = dockFrame.contentWindow, d = w.document, el = target === 'top' ? null : d.querySelector(target);
    if (d.readyState !== 'complete' || (target !== 'top' && !el)) { pvPending = target; return; }
    w.scrollTo({ top: el ? Math.max(0, el.getBoundingClientRect().top + w.scrollY - 70) : 0, behavior: smooth ? 'smooth' : 'auto' });
    pvPending = null;
  } catch { pvPending = null; }
}
let rpTimer;
function reloadPreview(now) {
  clearTimeout(rpTimer);
  rpTimer = setTimeout(() => {
    if (!dockFrame) return;
    let y = 0; try { y = dockFrame.contentWindow.scrollY; } catch {}
    dockFrame.addEventListener('load', () => { try { dockFrame.contentWindow.scrollTo(0, y); } catch {} }, { once: true });
    dockFrame.src = siteSrc();
  }, now ? 0 : 350);
}

/* ---------- Appearance: the default look of the website for every visitor. Save applies it, Cancel discards. ---------- */
const LOOK = {
  theme: { title: 'Theme', sub: 'Day or night colours that visitors see when they first open your website.', opts: [['light', 'Day mode', 'Light background'], ['dark', 'Night mode', 'Dark background']] },
  style: { title: 'Style', sub: 'How cards, buttons and fields look on your website for every visitor.', opts: [['normal', 'Normal', 'Flat colour with thin outlines'], ['neu', 'Neu', 'Soft raised and pressed surfaces'], ['clay', 'Clay', 'Puffy rounded 3D shapes']] }
};
async function viewLook(main, kind) {
  const L = LOOK[kind], cur = await api('GET', '/look');
  const draft = { ...cur }; const btns = [];
  window.__srLookDraft = draft; if (!dockSt.open) { dockSt.open = true; saveDock(); layoutDock(); } previewLook();
  const bar = savebar({ view: kind, onSave: () => api('PUT', '/look', { [kind]: draft[kind] }) });
  const paint = () => btns.forEach(([v, b]) => b.setAttribute('aria-pressed', String(v === draft[kind])));
  const grid = h('div', { class: 'opts' }, ...L.opts.map(([v, label, sub]) => {
    const b = h('button', { class: 'opt', type: 'button', onclick: () => { draft[kind] = v; paint(); previewLook(); bar.mark(draft[kind] !== cur[kind]); } },
      h('span', { class: 'opt-pv', 'data-v': v }, h('i'), h('i'), h('i')), h('span', {}, h('b', {}, label), h('small', {}, sub)));
    btns.push([v, b]); return b;
  }));
  main.append(header(L.title, L.sub), h('div', { class: 'card' }, grid, h('p', { class: 'hint', style: 'margin-top:16px' }, 'This is the look every new visitor gets. The preview on the right shows your choice before you save. Visitors can still try the other styles on the website for themselves.')), bar.el);
  paint();
}

/* ---------- Appearance > Panels: which sections of the website are shown ---------- */
const PANELS = [
  ['hero', 'Hero intro', 'The first screen: heading, short intro, Resume and Fiverr buttons.'],
  ['marquee', 'Services ticker', 'The scrolling line of services under the hero.'],
  ['music', 'Music player', 'The player under the header.'],
  ['work', 'Work gallery', 'The heading, filters and scrolling gallery of your work.'],
  ['brands', 'Brand identities', 'The brand identity case studies below the gallery.'],
  ['photo', 'Image editing skills', 'The image editing block.'],
  ['composition', 'Image composition skills', 'The before and after slider.'],
  ['services', 'What I can make for you', 'The services list.'],
  ['hire', 'Hire form', 'The project brief form. Hiding it also hides the "Let\'s Work Together" button, so no new briefs can come in.'],
  ['about', 'About', 'The about section.'],
  ['feedback', 'Client feedback', 'The reviews from clients.'],
  ['faq', 'FAQ', 'Questions and answers.'],
  ['contact', 'Contact footer', 'The contact area at the bottom of the page.']
];
async function viewPanels(main) {
  const cur = (await api('GET', '/panels')).hidden, hidden = new Set(cur);
  const bar = savebar({ view: 'panels', onSave: () => api('PUT', '/panels', { hidden: [...hidden] }) });
  const sync = () => { window.__srPanelsDraft = [...hidden]; try { dockFrame.contentWindow.SR_panels(window.__srPanelsDraft); } catch {} bar.mark(hidden.size !== cur.length || cur.some(x => !hidden.has(x))); };
  const sw = {};
  const rows = PANELS.map(([id, name, sub]) => {
    const b = h('button', { class: 'sw', type: 'button', role: 'switch', 'aria-label': name + ' on the website', onclick: () => { if (hidden.has(id)) hidden.delete(id); else hidden.add(id); paint(); sync(); } }, h('i'));
    const pill = h('span', { class: 'pill' });
    sw[id] = () => { const on = !hidden.has(id); b.setAttribute('aria-checked', String(on)); pill.textContent = on ? 'Shown' : 'Hidden'; pill.setAttribute('color', on ? 'mint' : 'sun'); pill.style.setProperty('--c', on ? '#12B886' : '#FFC700'); pill.style.setProperty('--t', '#14102E'); };
    return h('div', { class: 'item trow panel-row' }, h('div', { class: 'trk' }, h('h3', {}, name), h('p', { class: 'meta' }, sub)), h('div', { class: 'acts' }, pill, b));
  });
  const paint = () => PANELS.forEach(([id]) => sw[id]());
  window.__srPanelsDraft = [...hidden]; if (!dockSt.open) { dockSt.open = true; saveDock(); layoutDock(); }
  main.append(header('Panels', 'Choose which sections of your main website visitors can see. The preview on the right shows your choice before you save. The logo and menu bar at the very top always stay.',
    h('button', { class: 'btn', type: 'button', onclick: () => { hidden.clear(); paint(); sync(); } }, 'Show all')), h('div', { class: 'list' }, ...rows), bar.el);
  paint();
}

/* Account > Email alerts: client activity on the website comes to this mail */
async function alertsCard() {
  const a = await api('GET', '/alerts');
  const to = h('input', { type: 'email', value: a.to, autocomplete: 'off', 'aria-label': 'Send alerts to' });
  const inst = h('input', { type: 'checkbox' }), daily = h('input', { type: 'checkbox' }); inst.checked = a.instant; daily.checked = a.daily;
  const st = h('p', { class: 'hint' });
  const paint = x => {
    st.className = 'hint ' + (!x.smtp || x.lastError ? 'badtxt' : x.lastOk ? 'good' : '');
    st.textContent = !x.smtp ? 'The server has no mail account yet, so nothing can be sent. Set SMTP_HOST, SMTP_USER and SMTP_PASS on the server (see the README).'
      : x.lastError ? 'Last mail problem: ' + x.lastError : x.lastOk ? 'Last mail sent ' + fmtDate(x.lastOk) + '.' : 'The mail account is set. Nothing sent yet.';
  };
  paint(a);
  const reload = async () => { try { paint(await api('GET', '/alerts')); } catch {} };
  const save = h('button', { class: 'btn solid', type: 'button', onclick: wrap(async () => { await api('PUT', '/alerts', { to: to.value, instant: inst.checked, daily: daily.checked }); toast('Email alerts saved'); await reload(); }) }, 'Save alerts');
  const test = h('button', { class: 'btn', type: 'button', onclick: async () => { test.disabled = true; try { const r = await api('POST', '/alerts/test'); toast('Summary sent to ' + r.to); } catch (e) { toast(e.message, true); } test.disabled = false; await reload(); } }, 'Send the latest summary now');
  return h('div', { class: 'card', style: 'margin-top:18px' }, h('h2', {}, 'Email alerts'),
    h('p', { class: 'hint', style: 'margin:6px 0 14px' }, 'Everything clients do on your website comes to your mail, so you can answer them from your own mail or WhatsApp.'),
    field('Send alerts to', to),
    h('label', { class: 'check' }, inst, 'Right away when a client sends a project brief (Hire form) or a Help message'),
    h('label', { class: 'check', style: 'margin-top:10px' }, daily, 'One daily summary of the website visits (visitors, devices, countries, where they came from, what they pressed). Sent after 9 AM for the day before, only on days when something happened.'),
    st, h('div', { class: 'acts', style: 'margin-top:12px' }, save, test));
}

async function viewAccount(main) {
  const me = await api('GET', '/me');
  const cap = captchaBox();
  const email = h('input', { type: 'email', value: me.email, required: true, autocomplete: 'username' });
  const cur = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10 });
  const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', placeholder: '6 digit code' });
  const bar = savebar({ view: 'account', live: false, onSave: () => api('PUT', '/account', { email: email.value, currentPassword: cur.value, newPassword: nw.value, otp: code.value }) });
  const ask = h('button', { class: 'btn', type: 'button', onclick: wrap(async () => { const r = await api('POST', '/account/otp', cap.body()); toast('Code sent to ' + r.sentTo); cap.refresh(); code.focus(); }) }, 'Send code to the linked email');
  const form = h('form', { class: 'card', onsubmit: e => e.preventDefault() },
    field('Email', email, 'The address you sign in with. Changing it needs a code mailed to the address linked now (' + me.email.replace(/^(.).*(@.*)$/, '$1***$2') + ').'),
    field('Current password', cur, 'Needed to save any change here.'),
    field('New password', nw, 'At least 10 characters. Leave empty to keep the current one. Changing it signs out other devices.'),
    h('div', { class: 'field' }, h('label', {}, 'Verification for an email or password change'), h('p', { class: 'hint' }, 'Solve the captcha, press the button, then type the code that arrives in your mail.'), cap.el, ask),
    field('Code from your mail', code));
  form.addEventListener('input', () => bar.mark());
  main.append(header('Account', 'Your admin sign-in details and email alerts.'), form, await alertsCard(), bar.el);
}

/* no dragging of text, images or links inside the panel (dropping files on upload boxes still works) */
document.addEventListener('dragstart', e => { if (!(e.target instanceof Element) || !e.target.closest('input, textarea')) e.preventDefault(); });
/* keep the panel upright on phones and tablets: lock where the browser allows it, otherwise show a turn-back message */
document.body.append(h('div', { class: 'rot-lock', role: 'alert' }, h('i', { class: 'rot-phone', 'aria-hidden': 'true' }), h('b', {}, 'Turn your phone upright'), h('small', {}, 'The admin panel works in portrait only.')));
const lockUpright = () => { try { const o = screen.orientation; if (o && o.lock) o.lock('portrait').catch(() => {}); } catch {} };
lockUpright(); document.addEventListener('pointerdown', lockUpright, { once: true });

boot();
