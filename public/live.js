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
  var PREVIEW = /[?&]preview=1/.test(location.search) || window.__SR_PREVIEW__ === true; /* the admin panel's preview frame: no visit counting, and the admin controls the look */
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

  function apply(d) {
    [['look', function () { look(d.look, true); }], ['availability', function () { availability(d.online !== false); }], ['resume', function () { resume(d.resume); }], ['work', function () { work(d.work); }], ['compare', function () { compare(d.compare); }], ['slots', function () { if (!PREVIEW || !window.__srNoSlots) slots(d.slots); }], ['panels', function () { var hd = d.panelsHidden || []; if (PREVIEW) { try { if (parent.__srPanelsDraft) hd = parent.__srPanelsDraft; } catch (e) {} } else { try { localStorage.setItem('sr-panels', JSON.stringify(hd)); } catch (e) {} } panels(hd); }], ['feedbacks', function () { reviews(d.feedbacks); }], ['questions', function () { faq(d.questions); }], ['player', function () { player(d.music || NO_MUSIC); }], ['editvideo', function () { editVideo(d.editVideo); }]
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
  if (!PREVIEW) try { look(JSON.parse(localStorage.getItem('sr-look') || 'null') || { style: 'neu', theme: 'light' }); } catch (e) {}

  /* ---------- hero badge: "Taking new projects" follows the Online / Offline status in the admin panel ---------- */
  function availability(on) {
    var st = q('.status'); if (!st) return;
    var tn = [].slice.call(st.childNodes).filter(function (n) { return n.nodeType === 3; }).pop();
    var text = on ? 'Taking new projects' : 'Not taking new projects right now';
    if (tn) tn.nodeValue = text; else st.appendChild(document.createTextNode(text));
    st.classList.toggle('off', !on);
  }

  /* ---------- panels: sections hidden in the admin (Appearance > Panels) ---------- */
  var PANEL_SEL = { hero: ['main > .hero'], marquee: ['#marq'], music: ['#music'], work: ['#work > .sec-head', '#work > .filters', '#work > .grid', '#work > .gprog', '#work > .ghint'], brands: ['#work > .brand-block'], photo: ['#photo'], composition: ['#composition'], services: ['#services'], hire: ['#hire'], about: ['#about'], feedback: ['#feedback'], faq: ['#faq'], contact: ['#contact'] };
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
      var list = w[cat]; if (!list || !list.length) return;
      if (cat === 'branding') { brands(list); return; } /* branding pieces fill the "Brand identities" cards, each opening its PDF */
      changed = true;
      if (!q('.filters .chip[data-f="' + cat + '"]') && EXTRA_CATS[cat]) {
        var chip = document.createElement('button'); chip.className = 'chip'; chip.setAttribute('data-f', cat); chip.setAttribute('aria-pressed', 'false'); chip.textContent = EXTRA_CATS[cat];
        var box = q('.filters'); if (box) box.appendChild(chip);
      }
      var old = qa('.tile[data-t="' + cat + '"]', grid), anchor = old.length ? old[old.length - 1].nextSibling : q('.tile.cta', grid);
      old.forEach(function (t) { t.parentNode.removeChild(t); });
      list.forEach(function (p) {
        var a = document.createElement('article'); a.className = 'tile rv in'; /* 4:5 portrait tile, the 1080 x 1350 size the admin asks for */ a.setAttribute('data-t', cat); a.setAttribute('data-cursor', 'View');
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

  /* ---------- Image editing video: a YouTube link from the admin plays right inside the video box ---------- */
  function editVideo(v) {
    var box = q('#photo .vid'); if (!box || !v || !/^[\w-]{11}$/.test(v.vid)) return;
    box.removeAttribute('role'); box.setAttribute('aria-label', 'Image editing video');
    box.textContent = ''; box.style.cursor = 'pointer';
    var img = document.createElement('img'); img.alt = ''; img.className = 'vid-art'; img.decoding = 'async'; img.style.objectFit = 'cover';
    var srcs = ['https://i.ytimg.com/vi/' + v.vid + '/maxresdefault.jpg', 'https://i.ytimg.com/vi/' + v.vid + '/hqdefault.jpg'], n = 0;
    img.onerror = function () { n++; if (n < srcs.length) img.src = srcs[n]; };
    img.onload = function () { if (img.naturalWidth <= 120 && n < srcs.length - 1) { n++; img.src = srcs[n]; } };
    img.src = srcs[0]; box.appendChild(img);
    var play = document.createElement('button'); play.type = 'button'; play.className = 'vid-play'; play.setAttribute('aria-label', 'Play video'); play.style.border = '0'; play.style.cursor = 'pointer';
    play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>'; box.appendChild(play);
    var cap = document.createElement('span'); cap.className = 'vid-cap'; cap.innerHTML = '<span class="mono">Video</span><strong>Watch the edit</strong>'; box.appendChild(cap);
    function start() {
      if (box.querySelector('iframe')) return;
      var f = document.createElement('iframe');
      f.referrerPolicy = 'strict-origin-when-cross-origin'; /* YouTube needs to know which site embeds it, or it shows "video player configuration error" */
      f.src = 'https://www.youtube-nocookie.com/embed/' + v.vid + '?autoplay=1&rel=0&playsinline=1' + (/^https?:$/.test(location.protocol) ? '&origin=' + encodeURIComponent(location.origin) : '');
      f.title = 'Image editing video'; f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; f.allowFullscreen = true;
      f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0';
      box.textContent = ''; box.style.cursor = ''; box.appendChild(f);
    }
    box.addEventListener('click', start);
  }

  /* ---------- brand identities: 1920 x 1080 thumbnail + PDF per piece, replacing the sample cards ---------- */
  function brands(list) {
    var g = q('.brand-block .bgrid'); if (!g) return;
    qa('.bcase:not(.bcta)', g).forEach(function (c) { c.parentNode.removeChild(c); });
    var cta = q('.bcta', g);
    list.forEach(function (p, i) {
      var a = document.createElement('a'); a.className = 'bcase rv in';
      if (p.file) { a.href = p.file; a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('data-cursor', 'Open PDF'); }
      var art = document.createElement('div'); art.className = 'bart';
      var img = document.createElement('img'); img.src = p.image; img.alt = p.title; img.loading = 'lazy'; img.decoding = 'async';
      img.style.cssText = 'display:block;width:100%;aspect-ratio:16/9;object-fit:cover;transition:transform .6s cubic-bezier(.2,.8,.2,1)';
      a.addEventListener('mouseenter', function () { img.style.transform = 'scale(1.05)'; }); a.addEventListener('mouseleave', function () { img.style.transform = ''; });
      art.appendChild(img); a.appendChild(art);
      var cap = document.createElement('div'); cap.className = 'bcap';
      var m = document.createElement('span'); m.className = 'mono'; m.textContent = 'Brand identity · ' + (i < 9 ? '0' : '') + (i + 1); cap.appendChild(m);
      var h4 = document.createElement('h4'); h4.textContent = p.title; cap.appendChild(h4);
      if (p.label) { var d = document.createElement('p'); d.textContent = p.label; cap.appendChild(d); }
      if (p.file) { var o = document.createElement('span'); o.className = 'open'; o.textContent = 'Open full branding PDF \u2197'; cap.appendChild(o); }
      a.appendChild(cap);
      g.insertBefore(a, cta && cta.parentNode === g ? cta : null);
    });
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


  /* ---- content slots: every image, video, file link and heading/paragraph of the page that the admin panel can replace.
     SR_scan() lists them (the admin panel calls it); slots(map) applies the saved replacements. A slot key is
     section + kind + its number inside that section, so the same page always gives the same keys. ---- */
  var SLOT_SKIP = '#grid, #plList, #ba, #fbGrid, #faq .faq, .nav, .lb, #lb, form, #player, .sr-ins, .cta-shapes';
  var SLOT_SEL = 'img, svg[viewBox], .vid, video, a[href], h1, h2, h3, .sec-head > p, .about > p';
  var FILE_RE = /\.(pdf|docx?|pptx?|xlsx?|zip)(\?|#|$)/i;
  function slotList() {
    var out = [], cnt = {};
    qa(SLOT_SEL).forEach(function (el) {
      if (el.closest(SLOT_SKIP)) return;
      var tag = el.tagName.toLowerCase(), kind = '';
      if (tag === 'img') kind = 'image';
      else if (tag === 'svg') { var vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/); if (!el.closest('.vid') && +vb[2] >= 200) kind = 'image'; }
      else if (tag === 'video' || el.classList.contains('vid')) { if (!(tag === 'video' && el.closest('.vid'))) kind = 'video'; }
      else if (tag === 'a') { if (FILE_RE.test(el.getAttribute('data-sr-orig') || el.getAttribute('href') || '')) kind = 'file'; }
      else if (!el.children.length && el.textContent.trim()) kind = 'text';
      if (!kind) return;
      var sec = el.closest('section, footer'), sid = sec ? (sec.id || 'top') : 'top', n = (cnt[sid + kind] = (cnt[sid + kind] || 0) + 1);
      var box = el.closest('.brand-block, section, footer'), hd = box && box !== el ? q('h2, h3', box) : null;
      out.push({ key: sid + '-' + kind + '-' + n, kind: kind, section: sid, n: n, el: el, context: hd ? hd.textContent.trim().slice(0, 40) : '' });
    });
    return out;
  }
  window.SR_scan = function () {
    return slotList().map(function (x) {
      var cur = x.kind === 'text' ? (x.el.getAttribute('data-sr-orig') != null ? x.el.getAttribute('data-sr-orig') : x.el.textContent.trim()) : x.kind === 'file' ? (x.el.getAttribute('data-sr-orig') || x.el.getAttribute('href') || '') : x.kind === 'image' && x.el.tagName === 'IMG' ? (x.el.getAttribute('data-sr-orig') || x.el.getAttribute('src') || '') : '';
      if (/^data:/.test(cur)) cur = '';
      return { key: x.key, kind: x.kind, section: x.section, n: x.n, context: x.context, current: cur.slice(0, 300) };
    });
  };
  function slots(map) {
    map = map || {};
    slotList().forEach(function (x) {
      var el = x.el, v = map[x.key] && map[x.key].value, on = typeof v === 'string' && v !== '';
      if (x.kind === 'text') {
        if (el.getAttribute('data-sr-orig') == null) { if (!on) return; el.setAttribute('data-sr-orig', el.textContent); }
        el.textContent = on ? v : el.getAttribute('data-sr-orig');
      } else if (x.kind === 'file') {
        if (el.getAttribute('data-sr-orig') == null) { if (!on) return; el.setAttribute('data-sr-orig', el.getAttribute('href')); }
        el.setAttribute('href', on ? v : el.getAttribute('data-sr-orig')); if (on) el.setAttribute('target', '_blank');
      } else if (x.kind === 'image' && el.tagName === 'IMG') {
        if (el.getAttribute('data-sr-orig') == null) { if (!on) return; el.setAttribute('data-sr-orig', el.getAttribute('src')); }
        el.setAttribute('src', on ? v : el.getAttribute('data-sr-orig'));
      } else {
        var nx = el.nextElementSibling, ins = nx && nx.classList.contains('sr-ins') ? nx : null;
        if (!on) { if (ins) ins.remove(); [].slice.call(el.tagName === 'svg' ? [el] : el.children).forEach(function (c) { if (c.hasAttribute('data-sr-hid')) { c.style.display = ''; c.removeAttribute('data-sr-hid'); } }); return; }
        if (!ins) {
          ins = document.createElement(x.kind === 'video' ? 'video' : 'img'); ins.className = 'sr-ins ' + (el.getAttribute('class') || '');
          if (x.kind === 'video') { ins.controls = true; ins.setAttribute('playsinline', ''); ins.preload = 'metadata'; }
          else ins.alt = '';
          ins.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover;position:' + (x.kind === 'video' ? 'absolute;inset:0' : 'static');
          if (x.kind === 'video') { [].slice.call(el.children).forEach(function (c) { c.style.display = 'none'; c.setAttribute('data-sr-hid', '1'); }); el.appendChild(ins); }
          else { el.setAttribute('data-sr-hid', '1'); el.style.display = 'none'; el.parentNode.insertBefore(ins, el.nextSibling); }
        }
        ins.setAttribute('src', v);
      }
    });
  }
  /* the copy that "Apply on main website" wrote into this HTML file: shown first, so the page carries its saved content even before (or without) the server answering */
  var baked = null;
  if (!PREVIEW) try { baked = JSON.parse(document.getElementById('sr-baked').textContent); } catch (e) {}
  if (baked) { try { apply(baked); } catch (e) {} }
  (window.__SR_CONTENT__ ? Promise.resolve(window.__SR_CONTENT__) /* the artifact preview hands the content over directly */ : fetch('/api/public/content', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }))
    .then(function (d) { if (d) apply(d); else if (!baked) player(NO_MUSIC); })
    .catch(function () { if (!baked) player(NO_MUSIC); });
})();

/* ---------- Help button: floats above "Back to the Top" and sends a client grievance to Dashboard > Client Grievance ---------- */
(function () {
  if (document.getElementById('helpFab')) return;
  var css = document.createElement('style');
  css.textContent =
    '.help-fab{position:fixed;right:max(16px,env(safe-area-inset-right,0px));bottom:calc(max(16px,env(safe-area-inset-bottom,0px)) + 60px);z-index:30;display:inline-flex;align-items:center;gap:10px;height:48px;padding:0 20px 0 14px;border:1.5px solid var(--line);border-radius:999px;background:var(--surface);color:var(--fg);font:600 15px var(--f-body);cursor:pointer;box-shadow:0 14px 28px -16px rgba(0,0,0,.45);transition:transform .25s,background .25s,color .25s}' +
    '.help-fab:hover{transform:translateY(-3px);background:var(--accent);color:var(--on-accent);border-color:var(--accent)}' +
    '.help-fab i{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--accent);color:var(--on-accent);font:700 14px var(--f-body);font-style:normal}' +
    '.help-fab:hover i{background:var(--on-accent);color:var(--accent)}' +
    '@media (max-width:760px){.help-fab{height:44px;padding:0 16px 0 12px;font-size:14px;bottom:calc(max(16px,env(safe-area-inset-bottom,0px)) + 56px)}}' +
    '.help-ov{position:fixed;inset:0;z-index:80;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(10,8,30,.55)}' +
    '.help-ov.open{display:flex}' +
    '.help-box{width:min(520px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:22px;padding:26px}' +
    '.help-box h2{margin:0 0 6px;font:700 24px var(--f-body)}' +
    '.help-box .hp{margin:0 0 18px;color:var(--muted);font-size:15px}' +
    '.help-box .hp-row{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}' +
    '.help-box .hp-msg{margin:0 0 14px;font-size:14px}.help-box .hp-msg.bad{color:var(--warm)}' +
    '.help-trap{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}';
  document.head.appendChild(css);

  var fab = document.createElement('button');
  fab.id = 'helpFab'; fab.type = 'button'; fab.className = 'help-fab'; fab.setAttribute('aria-haspopup', 'dialog'); fab.setAttribute('aria-label', 'Help');
  fab.innerHTML = '<i aria-hidden="true">?</i>Help';
  var ov = document.createElement('div');
  ov.className = 'help-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'helpTitle');
  ov.innerHTML =
    '<form class="help-box" id="helpForm" autocomplete="off" novalidate>' +
    '<h2 id="helpTitle">Need help?</h2>' +
    '<p class="hp">Had a problem with an order, delivery or changes? Tell me what went wrong and I will get back to you.</p>' +
    '<div class="field"><label class="req" for="hpName">Your name</label><input id="hpName" type="text" maxlength="100" placeholder="Your name"></div>' +
    '<div class="field"><label class="req" for="hpContact">Email or WhatsApp number</label><input id="hpContact" type="text" maxlength="200" placeholder="you@example.com or +91 98765 43210"></div>' +
    '<div class="field"><label for="hpProject">Project (optional)</label><input id="hpProject" type="text" maxlength="120" placeholder="e.g. Logo for Orbit Coffee"></div>' +
    '<div class="field"><label class="req" for="hpIssue">What is the problem?</label><textarea id="hpIssue" maxlength="2000" placeholder="Describe the issue"></textarea></div>' +
    '<input class="help-trap" id="hpWeb" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">' +
    '<p class="hp-msg" id="hpMsg" role="status" aria-live="polite"></p>' +
    '<div class="hp-row"><button type="button" class="btn ghost" id="hpClose">Close</button><button type="submit" class="btn solid" id="hpSend">Send</button></div>' +
    '</form>';
  document.body.appendChild(fab); document.body.appendChild(ov);

  var form = ov.querySelector('#helpForm'), msg = ov.querySelector('#hpMsg'), send = ov.querySelector('#hpSend');
  function el(id) { return ov.querySelector(id); }
  function open() { ov.classList.add('open'); msg.textContent = ''; msg.className = 'hp-msg'; setTimeout(function () { el('#hpName').focus(); }, 30); }
  function close() { ov.classList.remove('open'); fab.focus(); }
  fab.addEventListener('click', open);
  el('#hpClose').addEventListener('click', close);
  ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov.classList.contains('open')) close(); });
  function say(t, bad) { msg.textContent = t; msg.className = 'hp-msg' + (bad ? ' bad' : ''); }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = el('#hpName').value.trim(), contact = el('#hpContact').value.trim(), issue = el('#hpIssue').value.trim();
    if (!name || !contact || !issue) { say('Please fill in your name, how to reach you, and the problem.', true); return; }
    send.disabled = true; say('Sending...', false);
    if (window.__SR_CONTENT__) { setTimeout(function () { send.disabled = false; form.reset(); say('Thank you. Your message has been sent and I will get back to you soon.', false); }, 300); return; } /* artifact preview: nothing is sent */
    fetch('/api/grievances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, contact: contact, project: el('#hpProject').value.trim(), issue: issue, website: el('#hpWeb').value }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        send.disabled = false;
        if (!x.ok) { say((x.d && x.d.error) || 'Could not send. Please try again.', true); return; }
        form.reset(); say('Thank you. Your message has been sent and I will get back to you soon.', false);
      })
      .catch(function () { send.disabled = false; say('Could not send. Please check your connection and try again.', true); });
  });
})();

/* ---------- Viewer: PDFs and work pictures open in a window on this page instead of another tab or site, with a full screen button ---------- */
(function () {
  if (document.getElementById('srViewer')) return;
  var css = document.createElement('style');
  css.textContent =
    '.sr-v{position:fixed;inset:0;z-index:90;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(10,8,30,.72)}' +
    '.sr-v.open{display:flex}' +
    '.sr-vp{display:flex;flex-direction:column;width:min(1100px,100%);height:min(88vh,860px);background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:22px;overflow:hidden}' +
    '.sr-vp.full{position:fixed;inset:0;width:100vw;height:100vh;height:100dvh;border-radius:0;border:0;z-index:2}' +
    '.sr-vp:fullscreen{width:100vw;height:100vh;border-radius:0;border:0}' +
    '.sr-vh{display:flex;align-items:center;gap:10px;padding:12px 14px 12px 20px;border-bottom:1px solid var(--line)}' +
    '.sr-vt{flex:1;min-width:0;margin:0;font:700 16px var(--f-body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.sr-vb{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px;border:1.5px solid var(--line);border-radius:999px;background:var(--bg);color:var(--fg);font:600 14px var(--f-body);cursor:pointer;white-space:nowrap}' +
    '.sr-vb:hover{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}' +
    '.sr-vb svg{width:16px;height:16px;fill:currentColor}' +
    '.sr-vc{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:var(--bg);overflow:auto}' +
    '.sr-vc iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}' +
    '.sr-vc .sr-vm{padding:30px;text-align:center;color:var(--muted);font-size:16px}' +
    '@media (max-width:600px){.sr-v{padding:0}.sr-vp{height:100vh;height:100dvh;border-radius:0;border:0}.sr-vb span{display:none}.sr-vb{padding:0 12px}}';
  document.head.appendChild(css);

  var ICO_FULL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h7v3H6v4H3zM14 3h7v7h-3V6h-4zM3 14h3v4h4v3H3zM18 14h3v7h-7v-3h4z"/></svg>';
  var ICO_EXIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h3v7H4V7h4zM13 3h3v4h4v3h-7zM4 14h7v7H8v-4H4zM13 14h7v3h-4v4h-3z"/></svg>';
  var ov = document.createElement('div');
  ov.id = 'srViewer'; ov.className = 'sr-v'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'srVt');
  ov.innerHTML = '<div class="sr-vp" id="srVp"><div class="sr-vh"><h2 class="sr-vt" id="srVt"></h2>' +
    '<button type="button" class="sr-vb" id="srVf" aria-label="Full screen">' + ICO_FULL + '<span>Full screen</span></button>' +
    '<button type="button" class="sr-vb" id="srVx" aria-label="Close">Close</button></div><div class="sr-vc" id="srVc"></div></div>';
  document.body.appendChild(ov);
  var panel = ov.querySelector('#srVp'), body = ov.querySelector('#srVc'), title = ov.querySelector('#srVt'), fbtn = ov.querySelector('#srVf'), xbtn = ov.querySelector('#srVx');
  var back = null, isFull = false;

  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function label() { isFull = !!fsEl() || panel.classList.contains('full'); fbtn.innerHTML = (isFull ? ICO_EXIT : ICO_FULL) + '<span>' + (isFull ? 'Exit full screen' : 'Full screen') + '</span>'; fbtn.setAttribute('aria-label', isFull ? 'Exit full screen' : 'Full screen'); }
  function leaveFull() {
    panel.classList.remove('full');
    if (fsEl()) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} }
    label();
  }
  function enterFull() {
    var rq = panel.requestFullscreen || panel.webkitRequestFullscreen;
    if (rq) { try { var p = rq.call(panel); if (p && p.catch) p.catch(function () { panel.classList.add('full'); label(); }); label(); return; } catch (e) {} }
    panel.classList.add('full'); label(); /* browsers without a full screen API (some phones): fill the whole window instead */
  }
  fbtn.addEventListener('click', function () { if (isFull) leaveFull(); else enterFull(); });
  document.addEventListener('fullscreenchange', label); document.addEventListener('webkitfullscreenchange', label);
  function close() { leaveFull(); ov.classList.remove('open'); body.textContent = ''; document.documentElement.style.overflow = ''; if (back && back.focus) { try { back.focus(); } catch (e) {} } back = null; }
  xbtn.addEventListener('click', close);
  ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !ov.classList.contains('open')) return;
    if (panel.classList.contains('full')) { leaveFull(); e.stopPropagation(); } else if (!fsEl()) close(); /* with real full screen the browser's own Esc leaves it first */
  }, true);

  function show(t, node) {
    title.textContent = t || 'Preview'; body.textContent = ''; body.appendChild(node);
    back = document.activeElement; ov.classList.add('open'); document.documentElement.style.overflow = 'hidden'; label(); xbtn.focus();
  }
  function note(t) { var d = document.createElement('div'); d.className = 'sr-vm'; d.textContent = t; return d; }
  function openPdf(url, t) {
    var holder = document.createElement('div'); holder.style.cssText = 'position:absolute;inset:0'; holder.appendChild(note('Loading...'));
    show(t, holder);
    var done = function (ok) {
      holder.textContent = '';
      if (!ok) { holder.appendChild(note('This PDF is not available yet.')); return; }
      var f = document.createElement('iframe'); f.title = t || 'PDF preview'; f.src = url + (url.indexOf('#') < 0 ? '#view=FitH' : ''); holder.appendChild(f);
    };
    try { fetch(url, { method: 'HEAD', cache: 'no-store' }).then(function (r) { done(r.ok); }).catch(function () { done(true); }); } catch (e) { done(true); }
  }
  /* every PDF link opens here (work tiles already open in the page's own project viewer) */
  var down = null;
  document.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || ov.contains(e.target)) return;
    if (down && (Math.abs(e.clientX - down.x) > 6 || Math.abs(e.clientY - down.y) > 6)) return; /* a drag, not a click */
    var a = e.target.closest && e.target.closest('a[href]');
    if (a) {
      var href = a.getAttribute('href') || '';
      if (/\.pdf(?:[?#].*)?$/i.test(href)) {
        e.preventDefault();
        var tt = (a.querySelector('h3, h4') || {}).textContent || (a.textContent || '').trim() || 'PDF preview';
        openPdf(href, tt.replace(/\s+/g, ' ').trim().slice(0, 80)); return;
      }
    }
  }, true);
})();
