'use strict';
/* Admin panel. All dynamic text goes through textContent (the h() helper), never innerHTML. */

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const LOGO_URL = '/admin/logo.png';
const COLORS = { accent: ['#4F3BFF', '#fff'], pink: ['#FF4FA3', '#fff'], sun: ['#FFC700', '#14102E'], warm: ['#FF5A36', '#fff'], mint: ['#12B886', '#fff'], sky: ['#22B8FF', '#14102E'] };

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
  const cap = captchaBox();
  const form = h('form', { class: 'card' },
    h('div', { class: 'shapes' }, ...['accent', 'pink', 'sun', 'mint', 'warm'].map(c => h('i', { color: c }))),
    h('h1', {}, 'Admin'), h('p', { class: 'muted' }, 'Sign in to manage your portfolio.'),
    h('div', { class: 'field' }), err,
    h('div', { class: 'field' }, h('label', {}, 'Email'), email),
    h('div', { class: 'field' }, h('label', {}, 'Password'), pw),
    h('div', { class: 'field' }, h('label', {}, 'Prove you are a person'), cap.el),
    h('button', { class: 'btn solid', type: 'submit' }, 'Sign in'));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (preview) return toast('This is only a preview of the sign in screen');
    try { await api('POST', '/login', { email: email.value, password: pw.value, ...cap.body() }); boot(); }
    catch (x) { err.hidden = false; err.textContent = x.message; cap.refresh(); }
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
const AUDIENCE = [['women', 'Women'], ['men', 'Men'], ['age13_17', 'Age 13 to 17'], ['age18_24', 'Age 18 to 24'], ['age25_34', 'Age 25 to 34'], ['age35_44', 'Age 35 to 44'], ['age45_54', 'Age 45 to 54'], ['age55_64', 'Age 55 to 64'], ['age65', 'Age 65 and above']];
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
const WORK = { logo: ['Logo', 'sun', 'Logo, Brand mark'], social: ['Social media', 'pink', 'Social media set, 9 posts'], brochure: ['Brochures', 'mint', 'Brochure, Tri-fold'], banner: ['Banners', 'warm', 'Banner, Large format'], other: ['Other printables', 'sky', 'Other printable, Stickers'], branding: ['Branding', 'accent', 'Branding, Brand identity'], editing: ['Image editing', 'pink', 'Image editing, Retouching'], composition: ['Image composition', 'sun', 'Image composition, Photo manipulation'] };
const VIEWS = {
  website: ['Website stats', 'accent', viewWebsite, 'Dashboard'],
  instagram: ['Instagram stats', 'pink', m => viewSocial(m, 'instagram'), 'Dashboard'],
  facebook: ['Facebook page stats', 'sky', m => viewSocial(m, 'facebook'), 'Dashboard'],
  fiverr: ['Fiverr stats', 'mint', m => viewSocial(m, 'fiverr'), 'Dashboard'],
  linkedin: ['LinkedIn stats', 'warm', m => viewSocial(m, 'linkedin'), 'Dashboard'],
  music: ['Music', 'pink', viewMusic, 'Hero section'],
  resume: ['Resume', 'sun', viewResume, 'Hero section'],
  ...Object.fromEntries(Object.entries(WORK).map(([k, [label, color]]) => ['work-' + k, [label, color, m => viewWork(m, k), 'Work']])),
  ...Object.fromEntries(Object.entries(BRIEF_CATS).map(([k, [label, color]]) => ['brief-' + k, [label, color, m => viewBriefs(m, k), 'Project Brief']])),
  feedbacks: ['Feedbacks', 'pink', viewFeedbacks, 'Client Feedback'],
  questions: ['Questions', 'sky', viewQuestions, 'Client Feedback'],
  grievances: ['Client Grievance', 'warm', viewGrievances, 'Business Moderation'],
  style: ['Style', 'accent', m => viewLook(m, 'style'), 'Appearance'],
  theme: ['Theme', 'sun', m => viewLook(m, 'theme'), 'Appearance'],
  panels: ['Panels', 'mint', viewPanels, 'Appearance'],
  account: ['Account', 'sky', viewAccount, null, true],
};
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
  dirty = false; current = name; location.hash = name;
  if (window.__srLookDraft || window.__srPanelsDraft) { window.__srLookDraft = null; window.__srPanelsDraft = null; reloadPreview(); }
  ensureDock();
  briefNew = await newByCat();
  let online = true; try { online = (await api('GET', '/status')).online; } catch {}
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
        h('div', { class: 'acct-row' },
          h('button', { class: 'btn sm' + (name === 'account' ? ' on' : ''), onclick: () => leave('account') }, 'Account'),
          statusMenu(online)),
        h('button', { class: 'btn sm', onclick: wrap(async () => { await api('POST', '/logout'); showLogin(); }) }, 'Sign out')));
  shell.append(side, main);
  app.replaceChildren(shell);
  try { await VIEWS[name][2](main); } catch (e) { toast(e.message, true); }
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
async function viewWebsite(main) {
  const s = await api('GET', '/stats');
  const max = Math.max(1, ...s.series.map(d => d.views));
  const short = d => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'Website views per day, last 30 days' },
    ...s.series.map(d => h('i', { class: 'bar' + (d.views ? '' : ' zero'), style: 'height:' + Math.max(3, Math.round(d.views / max * 100)) + '%', title: short(d.day) + ': ' + d.views + ' views, ' + d.visitors + ' visitors' })));
  const e = s.engagement, v = s.visitors;
  const visitN = k => (v.visit.find(x => x.k === k) || { n: 0 }).n, visitAll = visitN('New') + visitN('Returning');
  const secs = s.sections.slice().sort((a, b) => b.seconds - a.seconds), totalSec = secs.reduce((t, x) => t + x.seconds, 0) || 1;
  const topTime = secs[0], topClick = s.sections.slice().sort((a, b) => b.clicks - a.clicks)[0];
  const best = s.sections.filter(x => x.reached >= 3).sort((a, b) => b.avgSeconds - a.avgSeconds)[0];
  const maxT = Math.max(1, ...secs.map(x => x.seconds)), maxC = Math.max(1, ...secs.map(x => x.clicks));
  const table = secs.length ? h('div', { class: 'sectbl', role: 'table' },
    h('div', { class: 'st-row st-head', role: 'row' }, h('span', {}, 'Section'), h('span', {}, 'Time spent'), h('span', {}, 'Avg time per visitor'), h('span', {}, 'Reached'), h('span', {}, 'Clicks')),
    ...secs.map((x, i) => h('div', { class: 'st-row', role: 'row' },
      h('span', { class: 'st-name' }, h('em', {}, i + 1), secName(x.id)),
      h('span', { class: 'st-bar' }, h('span', { class: 'hb-track' }, fill('accent', Math.max(2, Math.round(x.seconds / maxT * 100)))), h('small', {}, Math.round(x.seconds / totalSec * 100) + '%')),
      h('span', {}, dur(x.avgSeconds)), h('span', {}, x.reachPct + '% of visits'),
      h('span', { class: 'st-bar' }, h('span', { class: 'hb-track' }, fill('pink', Math.max(2, Math.round(x.clicks / maxC * 100)))), h('b', {}, num(x.clicks)))))) : h('div', { class: 'empty' }, 'No section data yet. It fills in as people scroll through your website.');
  main.append(header('Website stats', 'Visits to your portfolio website, counted automatically. Details cover the last 30 days.'),
    h('div', { class: 'stats' }, stat(num(s.today.views), 'Views today', 'accent', num(s.today.visitors) + ' visitors'), stat(num(s.visitors7), 'Visitors, last 7 days', 'pink'), stat(num(s.views30), 'Views, last 30 days', 'mint', num(s.visitors30) + ' visitors'), stat(num(s.total), 'Views, all time', 'sun', s.since ? 'since ' + short(s.since) : 'No visits yet')),
    h('div', { class: 'card' }, h('h2', {}, 'Views per day'), bars, h('div', { class: 'baraxis' }, h('span', {}, short(s.series[0].day)), h('span', {}, 'Today')),
      h('p', { class: 'hint' }, 'A view is one page load. A visitor is one person per day, counted without storing their address. Search engine bots are left out.')),

    h('h2', { class: 'sec' }, 'Interest and interaction'),
    h('div', { class: 'stats' }, stat(dur(e.avgSeconds), 'Average time on site', 'accent', 'per visit'), stat(e.avgScroll + '%', 'Average scroll depth', 'sky', 'how far down the page'), stat(e.bounceRate + '%', 'Left within 10 seconds', 'warm', 'with no click'), stat(visitAll ? Math.round(visitN('Returning') / visitAll * 100) + '%' : '-', 'Returning visitors', 'mint', num(visitN('Returning')) + ' returning, ' + num(visitN('New')) + ' new')),
    h('div', { class: 'stats picks' },
      stat(topTime ? secName(topTime.id) : '-', 'Most time spent', 'sun', topTime ? Math.round(topTime.seconds / totalSec * 100) + '% of all reading time' : 'Not enough data yet'),
      stat(topClick && topClick.clicks ? secName(topClick.id) : '-', 'Most clicks', 'pink', topClick && topClick.clicks ? num(topClick.clicks) + ' clicks' : 'Not enough data yet'),
      stat(best ? secName(best.id) : '-', 'People stay longest on', 'accent', best ? 'about ' + dur(best.avgSeconds) + ' each' : 'Not enough data yet')),
    h('div', { class: 'card' }, h('h2', {}, 'Section by section'), table,
      h('p', { class: 'hint' }, 'Time spent counts while a section is in the middle of the screen and the visitor is active. Reached is the share of visits that scrolled to it.')),
    h('div', { class: 'card' }, h('h2', {}, 'What visitors click'), barList(s.actions, 'warm')),

    h('h2', { class: 'sec' }, 'Who visits'),
    h('div', { class: 'two' },
      h('div', { class: 'card' }, h('h2', {}, 'Device'), barList(v.device, 'accent')),
      h('div', { class: 'card' }, h('h2', {}, 'Where they come from'), barList(v.source, 'pink'))),
    h('div', { class: 'two' },
      h('div', { class: 'card' }, h('h2', {}, 'Browser'), barList(v.browser, 'sky')),
      h('div', { class: 'card' }, h('h2', {}, 'Operating system'), barList(v.os, 'mint'))),
    h('div', { class: 'card' }, h('h2', {}, 'Location'), barList(v.place.map(x => ({ k: placeName(x.k), n: x.n })), 'sun'),
      h('p', { class: 'hint' }, 'Taken from the visitor\'s device time zone, so it shows a region or city, not an exact place. Counts are visits.')));
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
async function viewWork(main, cat) {
  const [label, color, example] = WORK[cat];
  const data = await api('GET', '/work?category=' + cat);
  /* pending = a newly chosen image that uploads when you press Save */
  const draft = data.map(w => ({ title: w.title, label: w.label, image: w.image, published: w.published, pending: null }));
  /* Image composition also controls the Before / After slider of the website */
  const cmp = cat === 'composition' ? { ...(await api('GET', '/compare')), pb: null, pa: null } : null;
  const bar = savebar({ view: 'work-' + cat, onSave: async () => {
    for (const w of draft) if (w.pending) { const up = await api('POST', '/upload', { dataUrl: w.pending }); w.image = up.url; w.pending = null; }
    if (cmp) {
      if (cmp.pb) { cmp.before = (await api('POST', '/upload', { dataUrl: cmp.pb })).url; cmp.pb = null; }
      if (cmp.pa) { cmp.after = (await api('POST', '/upload', { dataUrl: cmp.pa })).url; cmp.pa = null; }
      await api('PUT', '/compare', { before: cmp.before, after: cmp.after });
    }
    await api('PUT', '/work', { category: cat, items: draft.map(({ title, label, image, published }) => ({ title, label, image, published })) });
  } });
  const rows = h('div', { class: 'list' });
  const touch = () => { bar.mark(); draw(); };
  const move = (i, d) => { [draft[i], draft[i + d]] = [draft[i + d], draft[i]]; touch(); };
  const wthumb = w => { const src = w.pending || (THUMBS && w.image); const b = h('div', { class: 'wthumb', color }); if (src) { const img = h('img', { src, alt: '' }); img.addEventListener('error', () => img.remove()); b.append(img); } else b.append(h('i', { 'aria-hidden': 'true' })); return b; };
  const row = (w, i) => h('div', { class: 'item trow' }, wthumb(w),
    h('div', { class: 'trk' }, h('h3', {}, w.title), h('p', { class: 'meta' }, w.label || 'No detail line'),
      h('span', { class: 'pill', color: w.published ? 'mint' : 'sun' }, w.published ? 'On website' : 'Hidden')),
    h('div', { class: 'acts' },
      h('button', { class: 'btn sm', type: 'button', disabled: i === 0, 'aria-label': 'Move up', onclick: () => move(i, -1) }, 'Up'),
      h('button', { class: 'btn sm', type: 'button', disabled: i === draft.length - 1, 'aria-label': 'Move down', onclick: () => move(i, 1) }, 'Down'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => workForm(w, touch) }, 'Edit'),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => { draft.splice(i, 1); touch(); } }, 'Remove')));
  const draw = () => rows.replaceChildren(...(draft.length ? draft.map(row) : [h('div', { class: 'empty' }, 'No pieces yet. Until you add one, your website keeps its sample ' + label.toLowerCase() + ' tiles.')]));
  const workForm = (w, done) => {
    const v = w || { title: '', label: '', image: '', published: true, pending: null };
    let pending = v.pending, shown = v.pending || (THUMBS && v.image) || '';
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    const prev = h('div', { class: 'tprev' });
    const paint = () => prev.replaceChildren(h('div', { class: 'wthumb big', color }, shown ? h('img', { src: shown, alt: 'Preview' }) : h('i', { 'aria-hidden': 'true' })));
    file.addEventListener('change', wrap(async () => {
      const f = file.files[0]; if (!f) return;
      if (f.size > 5 * 1024 * 1024) { file.value = ''; throw new Error('Image is larger than 5 MB'); }
      pending = await readDataUrl(f); shown = pending; paint();
    }));
    const title = h('input', { type: 'text', value: v.title, required: true, maxlength: 80, placeholder: 'Orbit Coffee' });
    const lab = h('input', { type: 'text', value: v.label, maxlength: 80, placeholder: example });
    const pub = h('input', { type: 'checkbox', checked: v.published });
    paint();
    modal(w ? 'Edit piece' : 'Add piece', h('div', {}, field('Image', file, w ? 'Choose a new image to replace the current one. PNG, JPG, WebP or GIF up to 5 MB.' : 'PNG, JPG, WebP or GIF up to 5 MB.'), prev, field('Title', title), field('Detail line', lab, 'Small text under the title, for example ' + example + '.'), h('label', { class: 'check' }, pub, 'Show on the website')),
      async () => {
        if (!title.value.trim()) throw new Error('Add a title');
        if (!pending && !v.image) throw new Error('Choose an image');
        const rec = { title: title.value.trim(), label: lab.value.trim(), published: pub.checked, pending: pending || null, image: v.image };
        if (w) Object.assign(w, rec); else draft.push(rec);
        done();
      }, w ? 'Update piece' : 'Add piece');
  };
  /* Before / After card (Image composition only): two pictures for the slider on the website */
  const compareCard = () => {
    const slot = (key, pend, name) => {
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': name + ' image' }), prev = h('div', { class: 'tprev' });
      const paint = () => { const src = cmp[pend] || (THUMBS && cmp[key]); prev.replaceChildren(h('div', { class: 'wthumb big', color: 'accent' }, src ? h('img', { src, alt: name + ' preview' }) : h('i', { 'aria-hidden': 'true' }))); clear.hidden = !(cmp[pend] || cmp[key]); };
      const clear = h('button', { class: 'btn sm', type: 'button', onclick: () => { cmp[pend] = null; cmp[key] = ''; file.value = ''; paint(); bar.mark(); } }, 'Remove');
      file.addEventListener('change', wrap(async () => {
        const f = file.files[0]; if (!f) return;
        if (f.size > 5 * 1024 * 1024) { file.value = ''; throw new Error('Image is larger than 5 MB'); }
        cmp[pend] = await readDataUrl(f); paint(); bar.mark();
      }));
      paint();
      return h('div', {}, field(name + ' image', file, 'PNG, JPG, WebP or GIF up to 5 MB.'), prev, clear);
    };
    return h('div', { class: 'card' }, h('h2', {}, 'Before and After slider'),
      h('p', { class: 'hint', style: 'margin:6px 0 14px' }, 'The "Image composition skills" slider on your website. Visitors drag it to compare the two pictures. Add both, or remove both to show the sample slider again. Use two pictures of the same size for the best result.'),
      h('div', { class: 'ba-form' }, slot('before', 'pb', 'Before'), slot('after', 'pa', 'After')));
  };
  main.append(header(label, 'Pieces shown under "' + label + '" in the Work section of your website. The top one shows first.', h('button', { class: 'btn solid', type: 'button', onclick: () => workForm(null, touch) }, 'Add piece')), ...(cmp ? [compareCard(), h('div', { style: 'height:18px' })] : []), rows, bar.el);
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
    rows.replaceChildren(...(list.length ? list.map(card) : [h('div', { class: 'empty' }, draft.length ? 'Nothing with this status.' : 'No grievances logged. Add one when a client raises a complaint, then track it until it is resolved.')]));
  };
  main.append(header('Client Grievance', 'Complaints raised by clients. Log each one, set its priority and status, and note how you resolved it. Only you can see this.', h('button', { class: 'btn solid', type: 'button', onclick: () => grievanceForm(null, touch, draft) }, 'Add grievance')), tabs, rows, bar.el);
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
function thumb(url) {
  const id = ytId(url);
  const box = h('div', { class: 'tthumb' });
  if (THUMBS && id) { const img = h('img', { src: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg', alt: '', loading: 'lazy' }); img.addEventListener('error', () => img.remove()); box.append(img); }
  box.append(h('i', { class: 'tplay', 'aria-hidden': 'true' }));
  return box;
}
async function viewMusic(main) {
  const data = await api('GET', '/music');
  const draft = { enabled: data.enabled, tracks: data.tracks.map(t => ({ url: t.url, published: t.published })) };
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
  const enabled = h('input', { type: 'checkbox', checked: draft.enabled, onchange: () => { draft.enabled = enabled.checked; bar.mark(); } });
  main.append(header('Music', 'Tracks in the player on your hero section. Each track is a YouTube link, and the top one plays first.',
      h('button', { class: 'btn solid', type: 'button', onclick: () => trackForm(null, touch, draft.tracks) }, 'Add track')),
    h('div', { class: 'card setting' }, h('label', { class: 'check' }, enabled, 'Show the music player on the website')), rows, bar.el);
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
    field('Upload or replace file', file, 'PDF up to 10 MB.'),
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
function siteSrc() { return SITE_FRAME === 'live' ? '/?preview=1' : URL.createObjectURL(new Blob([window.__SITE_HTML__ || ''], { type: 'text/html' })); }
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
  dockFrame.addEventListener('load', () => { previewLook(); setTimeout(previewLook, 400); setTimeout(previewLook, 1500); });
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
    sw[id] = () => { const on = !hidden.has(id); b.setAttribute('aria-checked', String(on)); pill.textContent = on ? 'Shown' : 'Hidden'; pill.setAttribute('color', on ? 'mint' : 'sun'); pill.style.setProperty('--c', on ? '#12B886' : '#FFC700'); pill.style.setProperty('--t', on ? '#fff' : '#14102E'); };
    return h('div', { class: 'item trow panel-row' }, h('div', { class: 'trk' }, h('h3', {}, name), h('p', { class: 'meta' }, sub)), h('div', { class: 'acts' }, pill, b));
  });
  const paint = () => PANELS.forEach(([id]) => sw[id]());
  window.__srPanelsDraft = [...hidden]; if (!dockSt.open) { dockSt.open = true; saveDock(); layoutDock(); }
  main.append(header('Panels', 'Choose which sections of your main website visitors can see. The preview on the right shows your choice before you save. The top part of the page (logo and hero) always stays.',
    h('button', { class: 'btn', type: 'button', onclick: () => { hidden.clear(); paint(); sync(); } }, 'Show all')), h('div', { class: 'list' }, ...rows), bar.el);
  paint();
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
  main.append(header('Account', 'Your admin sign-in details.'), form, bar.el);
}

boot();
