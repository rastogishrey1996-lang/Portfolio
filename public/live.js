/* Connects the website to the admin panel. The music and resume saved in /admin/ are read from /api/public/content
   each time a visitor opens the page, so a saved change is live straight away.
   Nothing saved means the page keeps what it already shows. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var q = function (s, r) { return (r || document).querySelector(s); };
  var qa = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
  var NO_MUSIC = { enabled: true, tracks: [] };

  /* ---------- visit counter and engagement (feeds Website stats in the admin panel) ---------- */
  var PREVIEW = /[?&]preview=1/.test(location.search); /* the admin panel's preview frame: no visit counting, and the admin controls the look */
  (function track() {
    if (PREVIEW) return;
    var returning = false;
    try { returning = !!localStorage.getItem('sr_seen'); localStorage.setItem('sr_seen', '1'); } catch (e) {}
    var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    function post(path, body, beacon) {
      var data = JSON.stringify(body);
      try { if (beacon && navigator.sendBeacon && navigator.sendBeacon(path, new Blob([data], { type: 'application/json' }))) return; } catch (e) {}
      try { fetch(path, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: data }).catch(function () {}); } catch (e) {}
    }
    post('/api/public/hit', { returning: returning, tz: tz, ref: document.referrer || '' });

    var parts = [], secs = {}, clicks = {}, actions = {}, vis = {}, active = 0, maxScroll = 0, first = true, lastAct = Date.now();
    var hero = q('.hero'); if (hero) parts.push(['hero', hero]);
    qa('section[id], footer[id]').forEach(function (e) { parts.push([e.id, e]); });
    function idOf(el) { var p = el && el.closest ? el.closest('.hero, section[id], footer[id]') : null; return p ? (p.classList.contains('hero') ? 'hero' : p.id) : ''; }
    if ('IntersectionObserver' in window) {
      /* a section counts as "being read" while it crosses the middle line of the screen */
      var io = new IntersectionObserver(function (es) { es.forEach(function (e) { vis[e.target.getAttribute('data-sid')] = e.isIntersecting; }); }, { rootMargin: '-50% 0px -49% 0px', threshold: 0 });
      parts.forEach(function (p) { p[1].setAttribute('data-sid', p[0]); io.observe(p[1]); });
    }
    ['scroll', 'mousemove', 'keydown', 'touchstart', 'click'].forEach(function (ev) { window.addEventListener(ev, function () { lastAct = Date.now(); }, { passive: true }); });
    window.addEventListener('scroll', function () {
      var h = document.documentElement, d = (window.scrollY + window.innerHeight) / Math.max(1, h.scrollHeight);
      if (d > maxScroll) maxScroll = d;
    }, { passive: true });
    setInterval(function () {
      if (document.visibilityState !== 'visible' || Date.now() - lastAct > 60000) return;
      active++; for (var k in vis) if (vis[k]) secs[k] = (secs[k] || 0) + 1;
    }, 1000);

    /* a click counts for its section, and for a named action when it is one of the main buttons */
    function label(el) {
      var a = el.closest('a'), href = a ? (a.getAttribute('href') || '') : '', id = el.closest('[id]') ? el.closest('[id]').id : '';
      if (/wa\.me/.test(href)) return 'WhatsApp'; if (/^mailto:/.test(href)) return 'Email'; if (/fiverr\.com/.test(href)) return 'Fiverr';
      if (/linkedin\./.test(href)) return 'LinkedIn'; if (/instagram\./.test(href)) return 'Instagram'; if (/facebook\./.test(href)) return 'Facebook';
      if (/\.pdf(\?|#|$)/.test(href) || (el.closest('.cta-row') && /resume/i.test(el.textContent))) return 'Resume';
      if (/^plPlay$/.test(id) || el.closest('#plPlay')) return 'Music play'; if (el.closest('#plNext,#plPrev')) return 'Music skip'; if (el.closest('#plBtn')) return 'Music track list';
      if (href.charAt(0) === '#' && href.length > 1) return 'Menu: ' + href.slice(1);
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 28);
      return t ? 'Button: ' + t.replace(/[^\w .&:/+-]/g, '') : '';
    }
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('a, button, summary, [role="button"]') : null; if (!el) return;
      var sid = idOf(el); if (sid) clicks[sid] = (clicks[sid] || 0) + 1;
      var l = label(el); if (l && Object.keys(actions).length < 12) actions[l] = (actions[l] || 0) + 1;
    }, true);
    var fm = $('form'); if (fm) fm.addEventListener('submit', function () { actions['Hire form sent'] = (actions['Hire form sent'] || 0) + 1; });

    function flush() {
      if (!active && !Object.keys(clicks).length) return;
      post('/api/public/engage', { first: first, seconds: active, scroll: Math.round(Math.min(1, maxScroll) * 100), sections: secs, clicks: clicks, actions: actions }, true);
      first = false; secs = {}; clicks = {}; actions = {}; active = 0;
    }
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
  })();

  fetch('/api/public/content', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d) apply(d); else player(NO_MUSIC); })
    .catch(function () { player(NO_MUSIC); });

  function apply(d) {
    [['look', function () { look(d.look, true); }], ['availability', function () { availability(d.online !== false); }], ['resume', function () { resume(d.resume); }], ['work', function () { work(d.work); }], ['compare', function () { compare(d.compare); }], ['panels', function () { var hd = d.panelsHidden || []; if (PREVIEW) { try { if (parent.__srPanelsDraft) hd = parent.__srPanelsDraft; } catch (e) {} } else { try { localStorage.setItem('sr-panels', JSON.stringify(hd)); } catch (e) {} } panels(hd); }], ['feedbacks', function () { reviews(d.feedbacks); }], ['questions', function () { faq(d.questions); }], ['player', function () { player(d.music || NO_MUSIC); }]
    ].forEach(function (p) { try { p[1](); } catch (e) { if (window.console) console.warn('live.js ' + p[0], e); } });
  }

  /* ---------- default look: the style and theme chosen in the admin panel apply to every visitor. A visitor who picks day or night keeps their own choice. ---------- */
  function look(L, save) {
    if (!L) return;
    var r = document.documentElement, own = null;
    if (PREVIEW) { try { if (parent.__srLookDraft) L = parent.__srLookDraft; } catch (e) {} save = false; }
    else { try { own = localStorage.getItem('sr-theme'); } catch (e) {} }
    if (!own) {
      if (L.theme === 'dark') r.setAttribute('data-theme', 'dark'); else r.removeAttribute('data-theme');
      var lb = $('themeLbl'), tb = $('themeBtn'); if (lb) lb.textContent = L.theme === 'dark' ? 'Night Mode' : 'Day Mode'; if (tb) tb.setAttribute('aria-pressed', L.theme === 'dark' ? 'true' : 'false');
    }
    if (L.style === 'neu' || L.style === 'clay') r.setAttribute('data-style', L.style); else r.removeAttribute('data-style');
    var sb = $('styleBtn'); if (sb) sb.setAttribute('data-state', L.style || 'normal');
    if (save) { try { localStorage.setItem('sr-look', JSON.stringify(L)); } catch (e) {} }
  }
  if (!PREVIEW) try { look(JSON.parse(localStorage.getItem('sr-look') || 'null')); } catch (e) {}

  /* ---------- hero badge: "Taking new projects" follows the Online / Offline status in the admin panel ---------- */
  function availability(on) {
    var st = q('.status'); if (!st) return;
    var tn = [].slice.call(st.childNodes).filter(function (n) { return n.nodeType === 3; }).pop();
    var text = on ? 'Taking new projects' : 'Not taking new projects right now';
    if (tn) tn.nodeValue = text; else st.appendChild(document.createTextNode(text));
    st.classList.toggle('off', !on);
  }

  /* ---------- panels: sections hidden in the admin (Appearance > Panels) ---------- */
  var PANEL_SEL = { music: ['#music'], work: ['#work > .sec-head', '#work > .filters', '#work > .grid', '#work > .gprog', '#work > .ghint'], brands: ['#work > .brand-block'], photo: ['#photo'], composition: ['#composition'], services: ['#services'], hire: ['#hire'], about: ['#about'], feedback: ['#feedback'], faq: ['#faq'], contact: ['#contact'] };
  var PANEL_NAV = { work: '#work', services: '#services', about: '#about', faq: '#faq', contact: '#contact', hire: '#hire' };
  function panels(hidden) {
    if (!hidden) return;
    if (!document.getElementById('sr-hide-css')) { var st = document.createElement('style'); st.id = 'sr-hide-css'; st.textContent = '.sr-hide{display:none!important}'; document.head.appendChild(st); }
    qa('.sr-hide').forEach(function (e) { e.classList.remove('sr-hide'); });
    var hide = function (e) { if (e) e.classList.add('sr-hide'); };
    hidden.forEach(function (id) {
      (PANEL_SEL[id] || []).forEach(function (s) { qa(s).forEach(hide); });
      if (PANEL_NAV[id]) qa('header.nav a[href="' + PANEL_NAV[id] + '"]').forEach(hide);
    });
    if (hidden.indexOf('photo') > -1 && hidden.indexOf('composition') > -1) qa('.photo-pair').forEach(hide);
  }
  window.SR_panels = panels;
  if (!PREVIEW) try { panels(JSON.parse(localStorage.getItem('sr-panels') || 'null')); } catch (e) {}

  /* ---------- Image composition slider: the Before and After pictures uploaded in the admin replace the sample drawings ---------- */
  function compare(c) {
    var ba = $('ba'); if (!ba || !c || !c.before || !c.after) return;
    [['.ba-before', c.before, 'Before'], ['.ba-after', c.after, 'After']].forEach(function (x) {
      var box = q(x[0], ba); if (!box) return;
      var img = box.querySelector('img.ba-photo');
      if (!img) { img = document.createElement('img'); img.className = 'ba-photo'; img.alt = x[2] + ' image'; img.decoding = 'async'; img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block'; var svg = box.querySelector('svg'); if (svg) svg.style.display = 'none'; box.insertBefore(img, box.firstChild); }
      img.src = x[1];
    });
  }

  /* ---------- work: pieces added in the admin replace the sample tiles of their category ---------- */
  var EXTRA_CATS = { branding: 'Branding', editing: 'Image Editing', composition: 'Image Composition' };
  function work(w) {
    var grid = $('grid'); if (!grid || !w) return; var changed = false;
    Object.keys(w).forEach(function (cat) {
      var list = w[cat]; if (!list || !list.length) return; changed = true;
      if (!q('.filters .chip[data-f="' + cat + '"]') && EXTRA_CATS[cat]) {
        var chip = document.createElement('button'); chip.className = 'chip'; chip.setAttribute('data-f', cat); chip.setAttribute('aria-pressed', 'false'); chip.textContent = EXTRA_CATS[cat];
        var box = q('.filters'); if (box) box.appendChild(chip);
      }
      var old = qa('.tile[data-t="' + cat + '"]', grid), anchor = old.length ? old[old.length - 1].nextSibling : q('.tile.cta', grid);
      old.forEach(function (t) { t.parentNode.removeChild(t); });
      list.forEach(function (p) {
        var a = document.createElement('article'); a.className = 'tile rv in sq'; a.setAttribute('data-t', cat); a.setAttribute('data-cursor', 'View');
        var idx = document.createElement('span'); idx.className = 'idx'; a.appendChild(idx);
        var art = document.createElement('div'); art.className = 'art art-img';
        var img = document.createElement('img'); img.src = p.image; img.alt = p.title; img.loading = 'lazy'; img.decoding = 'async'; art.appendChild(img); a.appendChild(art);
        var cap = document.createElement('div'); cap.className = 'cap'; var box = document.createElement('div');
        var h3 = document.createElement('h3'); h3.textContent = p.title; box.appendChild(h3);
        if (p.label) { var m = document.createElement('span'); m.className = 'mono'; m.textContent = p.label; box.appendChild(m); }
        cap.appendChild(box); a.appendChild(cap);
        grid.insertBefore(a, anchor && anchor.parentNode === grid ? anchor : q('.tile.cta', grid));
      });
    });
    if (!changed) return;
    qa('.tile[data-t] .idx', grid).forEach(function (s, i) { s.textContent = (i < 9 ? '0' : '') + (i + 1); });
    if (window.SR_work) window.SR_work();
  }

  /* ---------- client feedback ---------- */
  function reviews(list) {
    var grid = $('fbGrid'); if (!grid || !list || !list.length) return;
    var first = q('.fb-stars', grid); var stars = first ? first.outerHTML : '';
    var tones = [['var(--accent)', 'var(--on-accent)'], ['var(--pink)', 'var(--ink)'], ['var(--sun)', 'var(--ink)'], ['var(--sky)', 'var(--ink)'], ['var(--mint)', 'var(--ink)'], ['var(--warm)', 'var(--ink)']];
    grid.textContent = '';
    list.forEach(function (t, i) {
      var f = document.createElement('figure'); f.className = 'fb-card';
      if (stars) f.insertAdjacentHTML('beforeend', stars);
      var bq = document.createElement('blockquote'); bq.textContent = t.quote; f.appendChild(bq);
      var cap = document.createElement('figcaption');
      var av = document.createElement('span'); av.className = 'fb-av'; av.setAttribute('aria-hidden', 'true');
      av.style.setProperty('--c', tones[i % tones.length][0]); av.style.setProperty('--t', tones[i % tones.length][1]);
      av.textContent = t.name.split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
      var who = document.createElement('span'), b = document.createElement('b'); b.textContent = t.name; who.appendChild(b);
      if (t.role) { var m = document.createElement('span'); m.className = 'mono'; m.textContent = t.role; who.appendChild(m); }
      cap.appendChild(av); cap.appendChild(who); f.appendChild(cap); grid.appendChild(f);
    });
    grid.setAttribute('aria-label', 'Client reviews, scroll sideways');
    var gh = q('#feedback .ghint span'); if (gh) gh.textContent = list.length + ' review' + (list.length > 1 ? 's' : '');
  }

  /* ---------- questions (FAQ) ---------- */
  function faq(list) {
    var box = q('#faq .faq'); if (!box || !list || !list.length) return;
    box.textContent = '';
    list.forEach(function (x, i) {
      var d = document.createElement('details'); d.className = 'faq-i rv in';
      var s = document.createElement('summary');
      var n = document.createElement('span'); n.className = 'faq-n'; n.textContent = (i < 9 ? '0' : '') + (i + 1);
      var qq = document.createElement('span'); qq.className = 'faq-q'; qq.textContent = x.q;
      var xx = document.createElement('span'); xx.className = 'faq-x'; xx.setAttribute('aria-hidden', 'true');
      s.appendChild(n); s.appendChild(qq); s.appendChild(xx); d.appendChild(s);
      var p = document.createElement('p'); p.textContent = x.a; d.appendChild(p); box.appendChild(d);
    });
  }

  /* ---------- resume button ---------- */
  function resume(r) {
    var b = q('.cta-row button.btn.solid'); if (!b) return;
    if (!r || !r.url) { b.style.display = 'none'; return; }
    var a = document.createElement('a');
    a.className = b.className; a.href = r.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = r.label || 'Resume';
    b.parentNode.replaceChild(a, b);
  }

  /* ---------- hire form: also send the brief to the Project Brief section of the admin panel ---------- */
  var fm = $('form');
  if (fm) fm.addEventListener('submit', function () {
    try {
      var need = qa('#svcChips .dd-opt[aria-pressed="true"], #svcChips .chip[aria-pressed="true"]').map(function (b) { return b.getAttribute('data-v'); });
      if (!need.length) return;
      var v = function (id) { return ($(id) || {}).value || ''; };
      fetch('/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: v('name'), email: v('email'), business: v('biz'), whatsapp: v('wa'), service: need.join(', '), message: v('details'), size: v('size'), quality: v('quality'), neededBy: v('when') }) }).catch(function () {});
    } catch (e) {}
  });

  /* ---------- music player: plays the YouTube links from the admin ---------- */
  function player(m) {
    var pl = $('player'); if (!pl || pl.getAttribute('data-live')) return; pl.setAttribute('data-live', '1');
    if (m.enabled === false) { pl.style.display = 'none'; return; }
    var T = m.tracks || [], list = $('plList');
    var btnList = $('plBtn');
    btnList.addEventListener('click', function () { var o = list.classList.toggle('open'); btnList.setAttribute('aria-expanded', o ? 'true' : 'false'); });
    document.addEventListener('click', function (e) { if (!list.contains(e.target)) { list.classList.remove('open'); btnList.setAttribute('aria-expanded', 'false'); } });
    if (!T.length) {
      var e = document.createElement('li'); e.className = 'pl-empty'; e.textContent = 'No songs yet. Songs added by the admin will show up here.'; $('plTracks').appendChild(e);
      ['plPlay', 'plNext', 'plPrev'].forEach(function (id) { $(id).disabled = true; }); return;
    }
    var n = T.length, idx = 0, playing = false, yt = null, ready = false, want = false, muted = false, vol = 70, errs = 0;
    function fmt(s) { s = Math.floor(s || 0); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
    function ui() {
      pl.classList.toggle('on', playing);
      $('plPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
      $('plTitle').textContent = 'Track ' + (idx + 1); $('plSub').textContent = playing ? 'Playing' : (want ? 'Loading' : 'Paused');
      qa('#plTracks button').forEach(function (b, i) { b.classList.toggle('now', i === idx); });
    }
    T.forEach(function (t, i) {
      var li = document.createElement('li'), b = document.createElement('button'); b.type = 'button';
      var a = document.createElement('span'); a.className = 'tn'; a.textContent = i + 1;
      var nm = document.createElement('span'); nm.textContent = 'Track ' + (i + 1);
      var tm = document.createElement('span'); tm.className = 'tm'; tm.textContent = '';
      b.appendChild(a); b.appendChild(nm); b.appendChild(tm);
      b.addEventListener('click', function () { go(i, true); }); li.appendChild(b); $('plTracks').appendChild(li);
    });
    $('plDur').textContent = '0:00';

    /* hidden YouTube player, created the first time someone presses play */
    function init() {
      var host = document.createElement('div'); host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;height:200px;overflow:hidden;pointer-events:none';
      var slot = document.createElement('div'); host.appendChild(slot); document.body.appendChild(host);
      function make() {
        yt = new YT.Player(slot, { width: 200, height: 200, videoId: T[idx].vid, playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: location.origin }, events: {
          onReady: function () { ready = true; yt.setVolume(vol); if (muted) yt.mute(); if (want) yt.playVideo(); },
          onStateChange: function (ev) {
            if (ev.data === 1) { playing = true; errs = 0; } else if (ev.data === 2) playing = false;
            else if (ev.data === 0) { go(idx + 1, true); return; }
            ui();
          },
          onError: function () { errs++; if (errs < n) go(idx + 1, true); else { playing = false; want = false; ui(); } } } });
      }
      if (window.YT && YT.Player) return make();
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () { if (prev) prev(); make(); };
      var s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
    }
    function start() { want = true; if (!yt) init(); else if (ready) yt.playVideo(); ui(); }
    function pause() { want = false; playing = false; if (yt && ready) yt.pauseVideo(); ui(); }
    function go(i, play) {
      idx = (i + n) % n; $('plFill').style.width = '0%'; $('plCur').textContent = '0:00'; $('plDur').textContent = '0:00';
      if (play) want = true;
      if (yt && ready) { if (want) yt.loadVideoById(T[idx].vid); else yt.cueVideoById(T[idx].vid); }
      else if (play && !yt) init();
      ui();
    }
    $('plPlay').addEventListener('click', function () { (playing || want) ? pause() : start(); });
    $('plNext').addEventListener('click', function () { go(idx + 1, want); });
    $('plPrev').addEventListener('click', function () { go(idx - 1, want); });
    $('plVol').addEventListener('input', function (e) { vol = +e.target.value; if (vol > 0) muted = false; if (yt && ready) { yt.setVolume(vol); muted ? yt.mute() : yt.unMute(); } $('plMute').classList.toggle('muted', muted || vol === 0); });
    $('plMute').addEventListener('click', function () { muted = !muted; if (yt && ready) muted ? yt.mute() : yt.unMute(); $('plMute').classList.toggle('muted', muted || vol === 0); });
    q('.pl-bar', pl).addEventListener('click', function (e) {
      if (!yt || !ready) return; var r = this.getBoundingClientRect(), d = yt.getDuration();
      if (d) yt.seekTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d, true);
    });
    setInterval(function () {
      if (!yt || !ready || !playing) return;
      var c = yt.getCurrentTime(), d = yt.getDuration();
      if (d) { $('plFill').style.width = (c / d * 100) + '%'; $('plCur').textContent = fmt(c); $('plDur').textContent = fmt(d); }
    }, 500);
    ui();
  }
})();
