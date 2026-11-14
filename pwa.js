/**
 * MOSTWIN88 — Universal Auto PWA Installer (Mobile & PC)
 * Works across: User App, User Admin, Master Admin, Agent App, Affiliate App
 */
(function () {
  'use strict';

  var path = (location.pathname || '').toLowerCase();
  var search = (location.search || '').toLowerCase();
  var appKey = 'user';
  if (path.indexOf('master') !== -1) appKey = 'master';
  else if (path.indexOf('index') !== -1 || path.indexOf('/admin') !== -1) appKey = 'admin';
  else if (path.indexOf('agent') !== -1) appKey = 'agent';
  else if (path.indexOf('affiliate') !== -1) appKey = 'affiliate';
  else if (path.indexOf('user') !== -1 || search.indexOf('ref=') !== -1 || path === '/' || path === '') appKey = 'user';

  var APP_META = {
    user:      { name: 'MOSTWIN88 App',       sw: './user-sw.js',      icon: './icon-192.png' },
    admin:     { name: 'MOSTWIN88 Admin',     sw: './admin-sw.js',     icon: './admin-icon-192.png' },
    master:    { name: 'MOSTWIN88 Master',    sw: './master-sw.js',    icon: './master-icon-192.png' },
    agent:     { name: 'MOSTWIN88 Agent',     sw: './agent-sw.js',     icon: './agent-icon-192.png' },
    affiliate: { name: 'MOSTWIN88 Affiliate', sw: './affiliate-sw.js', icon: './affiliate-icon-192.png' }
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
      navigator.serviceWorker.register(APP_META.sw).catch(function () {});
    }, { once: true });
  }

  var styleEl = document.createElement('style');
  styleEl.id = 'mw-pwa-style';
  styleEl.textContent =
    '#mwPwaBanner{position:fixed;left:12px;right:12px;bottom:calc(74px + env(safe-area-inset-bottom));max-width:440px;margin:0 auto;z-index:2147482000;background:linear-gradient(145deg,#12141c,#090a0f);border:1px solid rgba(255,184,0,.48);border-radius:16px;padding:12px 14px;display:none;align-items:center;gap:12px;box-shadow:0 16px 40px rgba(0,0,0,.78);color:#f8fafc;font-family:inherit;animation:mwPwaSlide .28s ease-out}' +
    '@media(min-width:960px){#mwPwaBanner{bottom:20px;left:auto;right:20px;width:390px}}' +
    '@keyframes mwPwaSlide{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}' +
    '.mw-pwa-ic{width:44px;height:44px;border-radius:12px;flex:none;object-fit:cover;border:1px solid rgba(255,184,0,.35)}' +
    '.mw-pwa-txt{flex:1;min-width:0}.mw-pwa-txt b{display:block;font-size:13.5px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.mw-pwa-txt small{display:block;font-size:11.5px;color:#9ca3af;margin-top:2px;line-height:1.3}' +
    '.mw-pwa-btn{background:#FFB800;color:#09090B;border:0;border-radius:10px;padding:9px 14px;font-weight:800;font-size:12.5px;cursor:pointer;white-space:nowrap;flex:none}' +
    '.mw-pwa-x{background:transparent;border:0;color:#9ca3af;font-size:16px;padding:4px 6px;cursor:pointer;flex:none}';
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
})();
