/* Brush cursor. Self-contained: needs brush.css, no other code. Mouse and trackpad only (not touch), and not with reduced motion. */
(function () {
  'use strict';
  if (!window.matchMedia || !matchMedia('(hover: hover) and (pointer: fine)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var NS = 'http://www.w3.org/2000/svg', root = document.documentElement, DEFAULT = '#14102E';
  var cur = document.createElement('div'); cur.className = 'sr-cur'; cur.setAttribute('aria-hidden', 'true');
  var svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'sr-svg'); svg.setAttribute('viewBox', '0 0 510 454');
  /* the brush icon: a handle and a tuft of bristles. The tip of the bristles is the point of the cursor. */
  [['handle', 'M509 0 L499 4 L464 27 L366 100 L255 191 L202 241 L193 252 L176 282 L198 303 L210 323 L253 300 L273 282 L328 225 L393 151 L446 87 L494 25 Z'], ['bristle', 'M184 331 L176 320 L153 300 L131 300 L109 309 L102 314 L83 335 L57 386 L39 411 L21 428 L0 439 L38 450 L73 454 L104 451 L132 441 L155 424 L166 411 L177 393 L185 374 L192 349 Z']].forEach(function (p) {
    var e = document.createElementNS(NS, 'path'); e.setAttribute('class', 'sr-' + p[0]); e.setAttribute('d', p[1]); svg.appendChild(e);
  });
  var lbl = document.createElement('span'); lbl.className = 'sr-lbl'; cur.appendChild(svg); cur.appendChild(lbl);
  document.body.appendChild(cur); root.classList.add('sr-brush-on');

  var x = -99, y = -99, raf = 0;
  function place() { raf = 0; cur.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)'; }
  window.addEventListener('pointermove', function (e) { x = e.clientX; y = e.clientY; cur.classList.add('on'); if (!raf) raf = requestAnimationFrame(place); }, { passive: true });
  document.addEventListener('pointerleave', function () { cur.classList.remove('on'); });
  root.addEventListener('mouseleave', function () { cur.classList.remove('on'); });

  /* the colour of whatever is under the brush: the nearest opaque background that is not the page's own colour */
  function parse(c) { var m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; var p = m[1].split(/[ ,\/]+/).map(parseFloat); return (p.length > 3 && p[3] < 0.6) ? null : p.slice(0, 3); }
  function same(a, b) { return Math.abs(a[0] - b[0]) < 8 && Math.abs(a[1] - b[1]) < 8 && Math.abs(a[2] - b[2]) < 8; }
  function paint(el) {
    var page = parse(getComputedStyle(document.body).backgroundColor) || parse(getComputedStyle(root).backgroundColor) || [247, 246, 255];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var c = parse(getComputedStyle(n).backgroundColor);
      if (c && !same(c, page) && (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 < 0.97) return 'rgb(' + c.join(',') + ')';
    }
    return DEFAULT;
  }

  var held = null; /* the element that was clicked: the brush stays plain over it until you move to something else */
  var HOT = 'a, button, select, input, textarea, label, summary, [role=button], [data-cursor], .chip, .nav, .tab';
  document.addEventListener('pointerover', function (e) {
    var t = e.target; if (!t || !t.closest) return;
    var hot = t.closest(HOT), text = hot && /^(INPUT|TEXTAREA)$/.test(hot.tagName) && hot.type !== 'file' && hot.type !== 'checkbox' && hot.type !== 'range';
    cur.classList.toggle('hot', !!hot);
    var label = hot && hot.getAttribute('data-cursor') || (text ? 'Type' : '');
    cur.classList.toggle('big', !!label); if (label) lbl.textContent = label;
    if (held && held.contains(t)) return;
    held = null; cur.classList.remove('fading'); cur.style.setProperty('--brush', paint(t));
  });
  document.addEventListener('pointerdown', function (e) {
    cur.classList.add('press');
    held = (e.target.closest && e.target.closest(HOT)) || e.target;
    cur.classList.add('fading'); cur.style.setProperty('--brush', DEFAULT); /* slowly back to the plain brush */
  });
  document.addEventListener('pointerup', function () { cur.classList.remove('press'); });
})();
