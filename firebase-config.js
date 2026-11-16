window.NP_FIREBASE_CONFIG = {
  apiKey: "AIzaSyACoy90K8WHdxSU3_KtUiwWNPHGErT0P3w",
  authDomain: "mostwin88-febbf.firebaseapp.com",
  databaseURL: "https://mostwin88-febbf-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "mostwin88-febbf",
  storageBucket: "mostwin88-febbf.firebasestorage.app",
  messagingSenderId: "1091271266801",
  appId: "1:1091271266801:web:0b4da03572189864077450",
  measurementId: "G-5Q07GB1YD6"
};

// Default Render Node.js backend URL (used automatically across Cloudflare Pages, GitHub Pages, PWA, etc.)
window.MW_DEFAULT_BACKEND_URL = 'https://mostwin88-bakend.onrender.com';

window.MW_BACKEND_URL = window.MW_BACKEND_URL || (function () {
  try {
    var saved = localStorage.getItem('mw_backend_url');
    if (saved) return String(saved).replace(/\/+$/, '');
  } catch (_) {}
  if (typeof location !== 'undefined' && location.origin === window.MW_DEFAULT_BACKEND_URL) {
    return '';
  }
  return window.MW_DEFAULT_BACKEND_URL;
})();

window.mwApiUrl = function mwApiUrl(apiPath) {
  var p = String(apiPath || '');
  if (/^https?:\/\//i.test(p)) return p;
  var base = String(window.MW_BACKEND_URL || '').replace(/\/+$/, '');
  return base + (p.charAt(0) === '/' ? p : '/' + p);
};

// Shared authenticated API helper for all 5 panels (User, User Admin, Master, Agent, Affiliate)
window.mwApi = async function mwApi(apiPath, body, authObj) {
  var authInstance = authObj;
  if (!authInstance && typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
    try { authInstance = firebase.auth(); } catch (_) {}
  }
  var user = authInstance && authInstance.currentUser;
  if (!user) {
    throw new Error('অ্যাকাউন্ট লগইন করা নেই।');
  }
  var token = await user.getIdToken();
  var base = String(window.MW_BACKEND_URL || '').replace(/\/+$/, '');
  var res = await fetch(base + apiPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify(body || {})
  });
  var data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok || !data || data.ok === false) {
    var msg = (data && data.error) || ('সার্ভার ত্রুটি (' + res.status + ')');
    var err = new Error(msg);
    err.status = res.status;
    err.code = (data && data.code) || 'API_ERROR';
    throw err;
  }
  return data;
};
