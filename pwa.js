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
    user:      { name: 'MOSTWIN88 App',       sw: rootBase + 'user/sw.js',      scope: rootBase + 'user/',      icon: rootBase + 'icon-192.png?v=3' },
    admin:     { name: 'MOSTWIN88 Admin',     sw: rootBase + 'admin/sw.js',     scope: rootBase + 'admin/',     icon: rootBase + 'admin-icon-192.png' },
    master:    { name: 'MOSTWIN88 Master',    sw: rootBase + 'master/sw.js',    scope: rootBase + 'master/',    icon: rootBase + 'master-icon-192.png' },
    agent:     { name: 'MOSTWIN88 Agent',     sw: rootBase + 'agent/sw.js',     scope: rootBase + 'agent/',     icon: rootBase + 'agent-icon-192.png' },
    affiliate: { name: 'MOSTWIN88 Affiliate', sw: rootBase + 'affiliate/sw.js', scope: rootBase + 'affiliate/', icon: rootBase + 'affiliate-icon-192.png' }
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

  // Register Service Worker early for instant installability & zero-lag static cache
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(APP_META.sw, { scope: APP_META.scope }).catch(function () {});
    }, { once: true });
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
    '.mw-xscroll-host.mw-xscroll-no-y{scrollbar-width:none}';
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

    function syncOne(host) {
      var bar = host._mwTopBar;
      var inner = host._mwTopInner;
      if (!bar || !inner) return;
      if (!host.isConnected) {
        if (bar.parentNode) bar.parentNode.removeChild(bar);
        hosts.delete(host);
        return;
      }
      if (host.previousElementSibling !== bar && host.parentNode) {
        host.parentNode.insertBefore(bar, host);
      }
      var sw = host.scrollWidth || 0;
      var cw = host.clientWidth || 0;
      var show = cw > 0 && sw > cw + 2;
      var wantDisp = show ? 'block' : 'none';
      if (bar.style.display !== wantDisp) bar.style.display = wantDisp;
      if (show) {
        var wStr = sw + 'px';
        if (inner.style.width !== wStr) inner.style.width = wStr;
        if (Math.abs(bar.scrollLeft - host.scrollLeft) > 1) bar.scrollLeft = host.scrollLeft;
        var noY = host.scrollHeight <= host.clientHeight + 2;
        if (host.classList.contains('mw-xscroll-no-y') !== noY) host.classList.toggle('mw-xscroll-no-y', noY);
      } else {
        if (host.classList.contains('mw-xscroll-no-y')) host.classList.remove('mw-xscroll-no-y');
      }
    }

    function scanAndSync() {
      rafId = 0;
      if (!document.body) return;
      var tables = document.querySelectorAll('table');
      for (var i = 0; i < tables.length; i++) {
        var host = findScrollHost(tables[i]);
        if (host) {
          if (!host._mwTopBar) attachHost(host, tables[i]);
          else if (ro && host._mwTable !== tables[i]) {
            host._mwTable = tables[i];
            try { ro.observe(tables[i]); } catch (e) {}
          }
        }
      }
      hosts.forEach(syncOne);
      var orphanBars = document.querySelectorAll('.mw-top-xscroll');
      for (var j = 0; j < orphanBars.length; j++) {
        var b = orphanBars[j];
        if (!b._mwHost || !b._mwHost.isConnected || b.nextElementSibling !== b._mwHost) {
          if (b.parentNode) b.parentNode.removeChild(b);
        }
      }
    }

    function scheduleSync() {
      if (rafId) return;
      rafId = requestAnimationFrame(scanAndSync);
    }

    function startObserver() {
      if (!document.body) return;
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var t = muts[i].target;
          if (t && t.nodeType === 1 && (t.classList.contains('mw-top-xscroll') || t.classList.contains('mw-top-xscroll-inner'))) continue;
          scheduleSync();
          return;
        }
      });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      window.addEventListener('resize', scheduleSync, { passive: true });
      window.addEventListener('mw:view', scheduleSync);
      document.addEventListener('click', function () { setTimeout(scheduleSync, 40); }, { passive: true });
      scanAndSync();
    }

    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver);
  })();
})();
