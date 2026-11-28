/**
 * MOSTWIN88 — Universal Auto PWA Installer (Mobile & PC)
 * Works across: User App, User Admin, Master Admin, Agent App, Affiliate App
 */
(function () {
  'use strict';

  var path = (location.pathname || '').toLowerCase();
  var search = (location.search || '').toLowerCase();
  var metaApp = document.querySelector('meta[name="mw-app"]');
  var explicitApp = metaApp ? (metaApp.getAttribute('content') || '').toLowerCase().trim() : '';
  var appKey = (explicitApp === 'user' || explicitApp === 'admin' || explicitApp === 'master' || explicitApp === 'agent' || explicitApp === 'affiliate') ? explicitApp : '';
  if (!appKey) {
    var cleanPath = path.replace(/\/index\.html$/i, '').replace(/\/+$/, '');
    var lastSeg = (cleanPath.split('/').pop() || '').toLowerCase();
    if (lastSeg.indexOf('master') !== -1) appKey = 'master';
    else if (lastSeg.indexOf('agent') !== -1) appKey = 'agent';
    else if (lastSeg.indexOf('affiliate') !== -1) appKey = 'affiliate';
    else if (lastSeg === 'user' || lastSeg === 'user.html' || search.indexOf('ref=') !== -1) appKey = 'user';
    else if (lastSeg === 'admin' || lastSeg === 'admin.html') appKey = 'admin';
    else appKey = 'user';
  }
  document.documentElement.setAttribute('data-mw-app', appKey);

  var scriptSrc = (document.currentScript && document.currentScript.src) ? document.currentScript.src : '';
  var rootBase = scriptSrc ? scriptSrc.replace(/[^/]*([?#].*)?$/, '') : '../';
  var panelScope = rootBase + appKey + '/';

  var APP_META = {
    user:      { name: 'MOSTWIN88', sw: rootBase + 'user/sw.js',      scope: rootBase + 'user/',      icon: rootBase + 'icon-192.png?v=3' },
    admin:     { name: 'Admin',     sw: rootBase + 'admin/sw.js',     scope: rootBase + 'admin/',     icon: rootBase + 'admin-logo-192.png?v=3' },
    master:    { name: 'M Admin',   sw: rootBase + 'master/sw.js',    scope: rootBase + 'master/',    icon: rootBase + 'master-logo-192.png?v=3' },
    agent:     { name: 'Agent',     sw: rootBase + 'agent/sw.js',     scope: rootBase + 'agent/',     icon: rootBase + 'agent-logo-192.png?v=3' },
    affiliate: { name: 'Partner',   sw: rootBase + 'affiliate/sw.js', scope: rootBase + 'affiliate/', icon: rootBase + 'partner-logo-192.png?v=3' }
  }[appKey];

  var deferredPrompt = null;
  var DISMISS_KEY = 'mw_pwa_dismiss_' + appKey;
  var INSTALLED_KEY = 'mw_pwa_installed_' + appKey;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  var isAndroid = /android/i.test(navigator.userAgent || '');
  var isMobile = isIOS || isAndroid || window.innerWidth <= 959;

  function isStandalone() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches ||
             window.matchMedia('(display-mode: minimal-ui)').matches ||
             navigator.standalone === true;
    } catch (e) { return false; }
  }

  function isBn() {
    try {
      if (typeof STATE !== 'undefined' && STATE && STATE.currentLanguage === 'bn') return true;
      if (typeof state !== 'undefined' && state && state.currentLang === 'bn') return true;
      if (typeof currentLanguage !== 'undefined' && currentLanguage === 'bn') return true;
      return (document.documentElement.lang || '').toLowerCase() === 'bn';
    } catch (e) { return true; }
  }

  function showMsg(msg) {
    if (typeof showToast === 'function') { showToast(msg, 'info'); return; }
    if (typeof toast === 'function') { toast(msg); return; }
    alert(msg);
  }

  // Register Service Worker early for instant Cache-First shell & zero-lag repeat opens
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    (function registerPanelSw() {
      try {
        navigator.serviceWorker.getRegistrations().then(function (regs) {
          regs.forEach(function (r) {
            if (r && r.scope === rootBase) r.unregister().catch(function () {});
          });
        }).catch(function () {});
      } catch (e) {}
      navigator.serviceWorker.register(APP_META.sw, { scope: APP_META.scope, updateViaCache: 'none' }).catch(function () {});
    })();
  }

  var styleEl = document.createElement('style');
  styleEl.id = 'mw-pwa-style';
  styleEl.textContent =
    '#mwPwaBanner{position:fixed;left:12px;right:12px;bottom:calc(74px + env(safe-area-inset-bottom));max-width:440px;margin:0 auto;z-index:2147482000;background:var(--mw-pwa-bg,linear-gradient(145deg,#FFFFFF,#FFFBEB));border:1.5px solid var(--mw-pwa-border,#FACC15);border-radius:16px;padding:12px 14px;display:none;align-items:center;gap:12px;box-shadow:0 16px 36px var(--mw-pwa-shadow,rgba(15,23,42,.16));color:var(--mw-pwa-text,#0F172A);font-family:inherit;animation:mwPwaSlide .28s ease-out}' +
    '@media(min-width:960px){#mwPwaBanner{bottom:20px;left:auto;right:20px;width:390px}}' +
    '@keyframes mwPwaSlide{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}' +
    '.mw-pwa-ic{width:44px;height:44px;border-radius:12px;flex:none;object-fit:cover;border:1.5px solid var(--mw-pwa-border,#FACC15)}' +
    '.mw-pwa-txt{flex:1;min-width:0}.mw-pwa-txt b{display:block;font-size:13.5px;color:var(--mw-pwa-text,#0F172A);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mw-pwa-txt small{display:block;font-size:11.5px;color:var(--mw-pwa-sub,#475569);margin-top:2px;line-height:1.3}' +
    '.mw-pwa-btn{background:var(--mw-pwa-btn-bg,linear-gradient(135deg,#FFE84D,#FFD000));color:var(--mw-pwa-btn-text,#111827);border:1px solid var(--mw-pwa-btn-border,#EAB308);border-radius:10px;padding:9px 14px;font-weight:800;font-size:12.5px;cursor:pointer;white-space:nowrap;flex:none}' +
    '.mw-pwa-x{background:transparent;border:0;color:var(--mw-pwa-x,#64748B);font-size:16px;padding:4px 6px;cursor:pointer;flex:none}' +
    'body[data-theme="dark"],body.dark,html[data-mw-app="agent"] body:not(.light),html[data-mw-app="affiliate"] body:not(.light){' +
    '--mw-pwa-bg:linear-gradient(145deg,#141418,#09090B);--mw-pwa-border:#FACC15;--mw-pwa-shadow:rgba(0,0,0,.8);' +
    '--mw-pwa-text:#F8FAFC;--mw-pwa-sub:#A1A1AA;--mw-pwa-btn-bg:linear-gradient(135deg,#FACC15,#CA8A04);--mw-pwa-btn-text:#050506;--mw-pwa-btn-border:#FDE047;--mw-pwa-x:#A1A1AA;' +
    '--mw-xbar-track:#121216;--mw-xbar-border:rgba(250,204,21,.28);--mw-xbar-thumb:#EAB308;--mw-xbar-thumb-hover:#FACC15}' +
    '.mw-top-xscroll{display:none;width:100%;flex:0 0 auto;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;margin:0 0 6px 0;border-radius:999px;background:var(--mw-xbar-track,#FEF9C3);border:1px solid var(--mw-xbar-border,#FDE68A);scrollbar-width:thin;scrollbar-color:var(--mw-xbar-thumb,#EAB308) transparent}' +
    '.mw-top-xscroll::-webkit-scrollbar{height:11px}' +
    '.mw-top-xscroll::-webkit-scrollbar-track{background:transparent;border-radius:999px}' +
    '.mw-top-xscroll::-webkit-scrollbar-thumb{background:var(--mw-xbar-thumb,#EAB308);border-radius:999px;border:2px solid transparent;background-clip:content-box}' +
    '.mw-top-xscroll::-webkit-scrollbar-thumb:hover{background:var(--mw-xbar-thumb-hover,#CA8A04);border:1px solid transparent;background-clip:content-box}' +
    '.mw-top-xscroll-inner{height:1px;pointer-events:none}' +
    '.mw-xscroll-host::-webkit-scrollbar:horizontal{height:0 !important;display:none !important}' +
    '.mw-xscroll-host.mw-xscroll-no-y{scrollbar-width:none}' +
    '.m-chat-fab,.ua-chat-fab,.chat-fab,#fsup{border-radius:50% !important;touch-action:none !important;user-select:none !important;-webkit-user-select:none !important;cursor:grab}' +
    '.m-chat-fab.mw-fab-drag,.ua-chat-fab.mw-fab-drag,.chat-fab.mw-fab-drag{transition:none !important;transform:scale(1.08) !important;cursor:grabbing !important}';
  document.head.appendChild(styleEl);

  var banner = null;
  function ensureBanner() {
    if (banner || !document.body) return banner;
    banner = document.createElement('div');
    banner.id = 'mwPwaBanner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Install App');
    var bn = isBn();
    banner.innerHTML =
      '<img class="mw-pwa-ic" src="' + APP_META.icon + '" alt="">' +
      '<div class="mw-pwa-txt"><b>' + APP_META.name + '</b>' +
      '<small>' + (bn ? 'ফোনে অ্যাপ ইনস্টল করুন — দ্রুত ও ল্যাগ-মুক্ত' : 'Install phone app for instant & fast access') + '</small></div>' +
      '<button type="button" class="mw-pwa-btn" id="mwPwaInstallBtn">' + (bn ? 'ইনস্টল' : 'Install') + '</button>' +
      '<button type="button" class="mw-pwa-x" id="mwPwaDismissBtn" aria-label="Close">✕</button>';
    document.body.appendChild(banner);
    document.getElementById('mwPwaInstallBtn').addEventListener('click', triggerInstall);
    document.getElementById('mwPwaDismissBtn').addEventListener('click', function () {
      try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
      hideBanner();
    });
    return banner;
  }

  function showBanner() {
    if (isStandalone()) return;
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === '1') return;
      if (localStorage.getItem(INSTALLED_KEY) === '1' && !deferredPrompt) return;
    } catch (e) {}
    if (!document.body) return;
    var b = ensureBanner();
    if (b) b.style.display = 'flex';
  }

  function hideBanner() {
    if (banner) banner.style.display = 'none';
  }

  async function triggerInstall() {
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        var choice = await deferredPrompt.userChoice;
        deferredPrompt = null;
        if (choice && choice.outcome === 'accepted') {
          try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) {}
          hideBanner();
          showMsg(isBn() ? '✅ অ্যাপ ইনস্টল শুরু হয়েছে!' : '✅ App installation started!');
          return;
        }
      } catch (e) { deferredPrompt = null; }
    }
    if (isIOS) {
      showMsg(isBn()
        ? 'iPhone এ ইনস্টল করতে: নিচের Share (⬆️) চাপুন → "Add to Home Screen" সিলেক্ট করুন।'
        : 'On iPhone/iPad: tap Share (⬆️) → "Add to Home Screen".');
    } else {
      showMsg(isBn()
        ? 'অ্যাপ ইনস্টল করতে ব্রাউজারের মেনু (⋮) খুলে "Install app" অথবা "Add to Home screen" চাপুন।'
        : 'Tap browser menu (⋮) → "Install app" or "Add to Home screen".');
    }
    hideBanner();
  }

  window.mwTriggerInstall = triggerInstall;
  if (typeof window.npTriggerInstall !== 'function') window.npTriggerInstall = triggerInstall;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    try { localStorage.removeItem(INSTALLED_KEY); } catch (err) {}
    var topBtn = document.getElementById('topbar-pwa-install-btn');
    if (topBtn && !isStandalone()) topBtn.style.display = 'inline-flex';
    setTimeout(showBanner, 900);
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) {}
    hideBanner();
    var topBtn = document.getElementById('topbar-pwa-install-btn');
    if (topBtn) topBtn.style.display = 'none';
    showMsg(isBn() ? '🎉 অ্যাপ ফোনে সফলভাবে ইনস্টল হয়েছে!' : '🎉 App installed on your device!');
  });

  function onReady() {
    if (isStandalone()) return;
    var topBtn = document.getElementById('topbar-pwa-install-btn');
    if (topBtn) topBtn.style.display = 'inline-flex';
    // Auto-show on mobile phones cleanly even if beforeinstallprompt hasn't fired yet
    if (isMobile) {
      setTimeout(function () {
        if (!isStandalone()) showBanner();
      }, 2200);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  // Universal Top Horizontal Scrollbar for all scrollable tables (moves bottom h-scroll to top)
  (function initTopTableScrollbars() {
    var hosts = new Set();
    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { scheduleSync(); }) : null;
    var rafId = 0;

    function findScrollHost(tbl) {
      var p = tbl.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        if (p.matches('.modal, .modal-body, .modal-card, .m-modal-card, .m-modal-bg, .main, .main-wrapper, .app')) break;
        if (p.matches('.table-container, .sc, .table-wrap')) return p;
        try {
          var ox = window.getComputedStyle(p).overflowX;
          if (ox === 'auto' || ox === 'scroll') return p;
        } catch (e) {}
        p = p.parentElement;
      }
      return null;
    }

    function attachHost(host, tbl) {
      if (!host || !host.parentNode || host._mwTopBar) return;
      var bar = document.createElement('div');
      bar.className = 'mw-top-xscroll';
      var inner = document.createElement('div');
      inner.className = 'mw-top-xscroll-inner';
      bar.appendChild(inner);
      host.classList.add('mw-xscroll-host');
      host.parentNode.insertBefore(bar, host);
      host._mwTopBar = bar;
      host._mwTopInner = inner;
      host._mwTable = tbl;
      bar._mwHost = host;

      var lock = 0;
      bar.addEventListener('scroll', function () {
        if (lock === 2) return;
        lock = 1;
        host.scrollLeft = bar.scrollLeft;
        requestAnimationFrame(function () { if (lock === 1) lock = 0; });
      }, { passive: true });
      host.addEventListener('scroll', function () {
        if (lock === 1) return;
        lock = 2;
        bar.scrollLeft = host.scrollLeft;
        requestAnimationFrame(function () { if (lock === 2) lock = 0; });
      }, { passive: true });

      if (ro) {
        try { ro.observe(host); if (tbl) ro.observe(tbl); } catch (e) {}
      }
      hosts.add(host);
    }

    var syncTimer = 0;

    function syncBatch() {
      var work = [];
      hosts.forEach(function (host) {
        var bar = host._mwTopBar;
        var inner = host._mwTopInner;
        if (!bar || !inner) return;
        if (!host.isConnected) {
          work.push({ remove: true, host: host, bar: bar });
          return;
        }
        var sw = host.scrollWidth || 0;
        var cw = host.clientWidth || 0;
        var sh = host.scrollHeight || 0;
        var ch = host.clientHeight || 0;
        var sl = host.scrollLeft || 0;
        work.push({ remove: false, host: host, bar: bar, inner: inner, sw: sw, cw: cw, sh: sh, ch: ch, sl: sl });
      });
      for (var k = 0; k < work.length; k++) {
        var w = work[k];
        if (w.remove) {
          if (w.bar.parentNode) w.bar.parentNode.removeChild(w.bar);
          hosts.delete(w.host);
          continue;
        }
        if (w.host.previousElementSibling !== w.bar && w.host.parentNode) {
          w.host.parentNode.insertBefore(w.bar, w.host);
        }
        var show = w.cw > 0 && w.sw > w.cw + 2;
        var wantDisp = show ? 'block' : 'none';
        if (w.bar.style.display !== wantDisp) w.bar.style.display = wantDisp;
        if (show) {
          var wStr = w.sw + 'px';
          if (w.inner.style.width !== wStr) w.inner.style.width = wStr;
          if (Math.abs(w.bar.scrollLeft - w.sl) > 1) w.bar.scrollLeft = w.sl;
          var noY = w.sh <= w.ch + 2;
          if (w.host.classList.contains('mw-xscroll-no-y') !== noY) w.host.classList.toggle('mw-xscroll-no-y', noY);
        } else if (w.host.classList.contains('mw-xscroll-no-y')) {
          w.host.classList.remove('mw-xscroll-no-y');
        }
      }
    }

    function scanAndSync() {
      rafId = 0;
      if (!document.body) return;
      var tables = document.querySelectorAll('table');
      for (var i = 0; i < tables.length; i++) {
        var tbl = tables[i];
        var host = tbl._mwResolvedHost && tbl._mwResolvedHost.isConnected ? tbl._mwResolvedHost : findScrollHost(tbl);
        if (host) {
          tbl._mwResolvedHost = host;
          if (!host._mwTopBar) attachHost(host, tbl);
          else if (ro && host._mwTable !== tbl) {
            host._mwTable = tbl;
            try { ro.observe(tbl); } catch (e) {}
          }
        }
      }
      syncBatch();
      var orphanBars = document.querySelectorAll('.mw-top-xscroll');
      for (var j = 0; j < orphanBars.length; j++) {
        var b = orphanBars[j];
        if (!b._mwHost || !b._mwHost.isConnected || b.nextElementSibling !== b._mwHost) {
          if (b.parentNode) b.parentNode.removeChild(b);
        }
      }
    }

    function scheduleSync() {
      if (syncTimer) return;
      syncTimer = setTimeout(function () {
        syncTimer = 0;
        if (!rafId) rafId = requestAnimationFrame(scanAndSync);
      }, 90);
    }

    function startObserver() {
      if (!document.body) return;
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var t = muts[i].target;
          if (t && t.nodeType === 1) {
            if (t.classList.contains('mw-top-xscroll') || t.classList.contains('mw-top-xscroll-inner')) continue;
            if (t.id === 'toast' || t.id === 'mwPwaBanner' || t.id === 'npPkLock') continue;
          }
          scheduleSync();
          return;
        }
      });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      window.addEventListener('resize', scheduleSync, { passive: true });
      window.addEventListener('mw:view', scheduleSync);
      document.addEventListener('click', scheduleSync, { passive: true });
      scanAndSync();
    }

    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver);
  })();

  // Universal Draggable Floating Live Chat Icon (placeable anywhere on display across all panels)
  (function initDraggableChatFab() {
    if (appKey === 'user') return; // user/index.html initializes its own #fsup draggable handler
    var POS_KEY = 'mw_chat_fab_pos_' + appKey;
    var SELECTOR = '.m-chat-fab, .ua-chat-fab, .chat-fab, #mLiveChatFab, #uaLiveChatFab, #liveChatFab';
    var suppressClickUntil = 0;

    function loadPos() {
      try {
        var raw = localStorage.getItem(POS_KEY);
        if (!raw) return null;
        var p = JSON.parse(raw);
        if (p && typeof p.fx === 'number' && typeof p.fy === 'number' && isFinite(p.fx) && isFinite(p.fy)) return p;
      } catch (e) {}
      return null;
    }

    function savePos(x, y) {
      try {
        var vw = Math.max(window.innerWidth || 1, 1);
        var vh = Math.max(window.innerHeight || 1, 1);
        localStorage.setItem(POS_KEY, JSON.stringify({ fx: x / vw, fy: y / vh }));
      } catch (e) {}
    }

    function applyPos(el, x, y) {
      if (!el) return null;
      var w = el.offsetWidth || 58;
      var h = el.offsetHeight || 58;
      var vw = window.innerWidth || document.documentElement.clientWidth || 360;
      var vh = window.innerHeight || document.documentElement.clientHeight || 640;
      var nx = Math.max(6, Math.min(vw - w - 6, x));
      var ny = Math.max(6, Math.min(vh - h - 6, y));
      el.style.setProperty('left', Math.round(nx) + 'px', 'important');
      el.style.setProperty('top', Math.round(ny) + 'px', 'important');
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      return [nx, ny];
    }

    var activeDragEl = null;

    function restoreIfSaved(el) {
      if (!el || !el.isConnected || el === activeDragEl || el.classList.contains('mw-fab-drag')) return;
      var w = el.offsetWidth;
      if (!w) return;
      var saved = loadPos();
      if (!saved) return;
      var vw = window.innerWidth || 360;
      var vh = window.innerHeight || 640;
      var targetX = Math.round(Math.max(6, Math.min(vw - w - 6, saved.fx * vw)));
      var targetY = Math.round(Math.max(6, Math.min(vh - (el.offsetHeight || 58) - 6, saved.fy * vh)));
      if (el.style.left === targetX + 'px' && el.style.top === targetY + 'px') return;
      applyPos(el, targetX, targetY);
    }

    function bindFab(el) {
      if (!el || el._mwDragBound) return;
      el._mwDragBound = true;
      var drag = null;

      el.addEventListener('pointerdown', function (e) {
        if (e.button && e.button !== 0) return;
        var rect = el.getBoundingClientRect();
        if (!rect.width) return;
        activeDragEl = el;
        applyPos(el, rect.left, rect.top);
        drag = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top, moved: false };
        el.classList.add('mw-fab-drag');
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      });

      el.addEventListener('pointermove', function (e) {
        if (!drag) return;
        var dx = e.clientX - drag.sx;
        var dy = e.clientY - drag.sy;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
        if (drag.moved) applyPos(el, drag.ox + dx, drag.oy + dy);
      });

      function endDrag() {
        if (!drag) return;
        var moved = drag.moved;
        drag = null;
        if (activeDragEl === el) activeDragEl = null;
        el.classList.remove('mw-fab-drag');
        if (moved) {
          suppressClickUntil = Date.now() + 400;
          var r = el.getBoundingClientRect();
          var finalPos = applyPos(el, r.left, r.top);
          if (finalPos) savePos(finalPos[0], finalPos[1]);
        }
      }

      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);
      restoreIfSaved(el);
    }

    window.addEventListener('click', function (e) {
      if (Date.now() < suppressClickUntil && e.target && e.target.closest && e.target.closest(SELECTOR)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      }
    }, true);

    function scan() {
      var fabs = document.querySelectorAll(SELECTOR);
      for (var i = 0; i < fabs.length; i++) {
        bindFab(fabs[i]);
        restoreIfSaved(fabs[i]);
      }
    }

    function boot() {
      scan();
      if (!document.body) return;
      var mo = new MutationObserver(function () { scan(); });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      window.addEventListener('resize', scan, { passive: true });
    }

    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot);
  })();
})();
