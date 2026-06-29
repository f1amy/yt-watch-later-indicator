// ==UserScript==
// @name         YouTube Watch Later Indicator
// @namespace    https://github.com/f1amy/yt-watch-later-indicator
// @homepageURL  https://github.com/f1amy/yt-watch-later-indicator
// @version      1.0.2
// @description  Shows a small badge on any video thumbnail that is already in your Watch Later playlist (home, search, and recommended/up-next).
// @author       F1amy
// @downloadURL  https://raw.githubusercontent.com/f1amy/yt-watch-later-indicator/main/ytWatchLaterIndicator.user.js
// @updateURL    https://raw.githubusercontent.com/f1amy/yt-watch-later-indicator/main/ytWatchLaterIndicator.user.js
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @run-at       document-idle
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  /* ----------------------------------------------------------------------
   * CONFIG — tweak these
   * -------------------------------------------------------------------- */
  const CONFIG = {
    // How long (minutes) to trust the cached Watch Later list before refetching
    // in the background. Lower = more up to date, more network. You can always
    // force a refresh from the Tampermonkey menu after adding videos.
    cacheTtlMinutes: 5,

    // Where the badge sits on the thumbnail.
    // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    // top-left is the safe default (the duration label lives bottom-right,
    // the hover buttons live top-right).
    badgeCorner: 'top-left',

    // Show the words "Watch Later" next to the clock icon. false = icon only
    // (recommended; stays readable on the tiny sidebar thumbnails).
    showLabel: false,

    // Also badge Shorts thumbnails (Shorts you've added to Watch Later).
    markShorts: true,

    // Badge look
    bgColor: '#0f0f0f',
    fgColor: '#ffffff',

    // Badge background transparency. 0 = fully see-through, 1 = solid.
    // A blur is applied behind it so the icon stays readable on busy thumbnails.
    bgOpacity: 0.55,

    // Don't show badges on the Watch Later playlist page itself
    // (every item there is in WL, so the badges are just noise).
    hideOnWatchLaterPage: true,

    // Internal: how long to wait after DOM changes before re-scanning.
    rescanDebounceMs: 250,

    // Internal: print debug info to the console.
    debug: false,
  };

  /* ----------------------------------------------------------------------
   * Constants / state
   * -------------------------------------------------------------------- */
  const ORIGIN = 'https://www.youtube.com';
  const STORE_KEY = 'ytwl_cache';
  // SVG built via DOM APIs (not innerHTML) so it works under YouTube's
  // Trusted Types CSP, which blocks string-to-HTML assignment.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CLOCK_PATHS = [
    'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
    'M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  ];
  const VIDEO_ID_RE = /^[0-9A-Za-z_-]{11}$/;

  let wlSet = new Set();   // current Watch Later video IDs
  let fetching = false;    // guard against overlapping fetches
  let markTimer = null;    // debounce handle

  const log = (...a) => CONFIG.debug && console.log('[WL-Indicator]', ...a);

  /* ----------------------------------------------------------------------
   * ytcfg / cookies helpers (used for the internal YouTube API calls)
   * -------------------------------------------------------------------- */
  function ytcfgGet(key) {
    try {
      const w = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
      if (w.ytcfg && typeof w.ytcfg.get === 'function') return w.ytcfg.get(key);
    } catch (e) { /* ignore */ }
    return undefined;
  }

  function getCookie(name) {
    const m = document.cookie.match('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Mirrors how the YouTube web client signs internal API requests.
  async function sapisidAuthHeader() {
    const sapisid = getCookie('SAPISID') || getCookie('__Secure-3PAPISID') || getCookie('__Secure-1PAPISID');
    if (!sapisid) return null;
    const ts = Math.floor(Date.now() / 1000);
    const make = async (val) => `${ts}_${await sha1Hex(`${ts} ${val} ${ORIGIN}`)}`;
    let header = `SAPISIDHASH ${await make(sapisid)}`;
    const p1 = getCookie('__Secure-1PAPISID');
    const p3 = getCookie('__Secure-3PAPISID');
    if (p1) header += ` SAPISID1PHASH ${await make(p1)}`;
    if (p3) header += ` SAPISID3PHASH ${await make(p3)}`;
    return header;
  }

  function defaultContext() {
    return { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' } };
  }

  /* ----------------------------------------------------------------------
   * Fetching the Watch Later list
   *   1) Grab the first page reliably from the rendered playlist HTML
   *      (cookies authenticate it, no special headers needed).
   *   2) Page through the rest via the internal browse endpoint.
   * -------------------------------------------------------------------- */
  function sliceBalancedJson(s, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
    return null;
  }

  function extractInitialData(html) {
    const markers = ['var ytInitialData = ', 'ytInitialData = ', 'window["ytInitialData"] = '];
    for (const m of markers) {
      const i = html.indexOf(m);
      if (i >= 0) {
        const start = html.indexOf('{', i + m.length - 1);
        if (start >= 0) {
          const json = sliceBalancedJson(html, start);
          if (json) { try { return JSON.parse(json); } catch (e) { /* try next */ } }
        }
      }
    }
    return null;
  }

  // Recursively collect video IDs from any YouTube response shape.
  function extractVideoIds(root) {
    const ids = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const x of n) walk(x); return; }
      if (n.playlistVideoRenderer && n.playlistVideoRenderer.videoId) {
        ids.push(n.playlistVideoRenderer.videoId);
      }
      if (n.lockupViewModel && n.lockupViewModel.contentId &&
          n.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
        ids.push(n.lockupViewModel.contentId);
      }
      for (const k in n) walk(n[k]);
    })(root);
    return ids;
  }

  function extractContinuation(root) {
    let token = null;
    (function walk(n) {
      if (token || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const x of n) { walk(x); if (token) return; } return; }
      if (n.continuationItemRenderer) {
        const ce = n.continuationItemRenderer.continuationEndpoint;
        const t = ce && ce.continuationCommand && ce.continuationCommand.token;
        if (t) { token = t; return; }
      }
      for (const k in n) { walk(n[k]); if (token) return; }
    })(root);
    return token;
  }

  async function browse(extra) {
    const apiKey = ytcfgGet('INNERTUBE_API_KEY');
    const context = ytcfgGet('INNERTUBE_CONTEXT') || defaultContext();
    const url = `${ORIGIN}/youtubei/v1/browse?prettyPrint=false${apiKey ? `&key=${apiKey}` : ''}`;
    const headers = { 'Content-Type': 'application/json', 'X-Origin': ORIGIN, 'X-Goog-AuthUser': '0' };
    try {
      const auth = await sapisidAuthHeader();
      if (auth) headers['Authorization'] = auth;
    } catch (e) { /* cookies are still sent via credentials */ }
    const visitor = ytcfgGet('VISITOR_DATA'); if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    const cn = ytcfgGet('INNERTUBE_CONTEXT_CLIENT_NAME'); if (cn) headers['X-Youtube-Client-Name'] = String(cn);
    const cv = ytcfgGet('INNERTUBE_CONTEXT_CLIENT_VERSION'); if (cv) headers['X-Youtube-Client-Version'] = cv;

    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(Object.assign({ context }, extra)),
    });
    if (!res.ok) { log('browse HTTP', res.status); return null; }
    return res.json();
  }

  async function fetchWatchLater() {
    const ids = new Set();
    let token = null;

    // 1) First page from rendered HTML (reliable auth via cookies).
    try {
      const res = await fetch(`${ORIGIN}/playlist?list=WL&hl=en`, { credentials: 'include' });
      if (res.ok) {
        const data = extractInitialData(await res.text());
        if (data) {
          extractVideoIds(data).forEach(id => ids.add(id));
          token = extractContinuation(data);
        }
      }
    } catch (e) { log('html fetch error', e); }

    // Fallback: if HTML gave us nothing, try the internal browse endpoint.
    if (ids.size === 0 && !token) {
      const data = await browse({ browseId: 'VLWL' });
      if (data) { extractVideoIds(data).forEach(id => ids.add(id)); token = extractContinuation(data); }
    }

    // 2) Remaining pages via continuations.
    let page = 0;
    while (token && page < 300) {
      const data = await browse({ continuation: token });
      if (!data) break;
      const before = ids.size;
      extractVideoIds(data).forEach(id => ids.add(id));
      token = extractContinuation(data);
      page++;
      if (ids.size === before && !token) break;
    }

    log('fetched', ids.size, 'Watch Later videos');
    return ids;
  }

  /* ----------------------------------------------------------------------
   * Cache (per-account, so switching Google accounts doesn't show stale data)
   * -------------------------------------------------------------------- */
  function cacheKey() {
    const ds = ytcfgGet('DATASYNC_ID') || '';
    return STORE_KEY + (ds ? ':' + ds : '');
  }
  function loadCache() {
    try { const raw = GM_getValue(cacheKey()); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function saveCache(set) {
    try { GM_setValue(cacheKey(), JSON.stringify({ ts: Date.now(), ids: [...set] })); }
    catch (e) { /* ignore */ }
  }

  async function ensureWatchLater(force) {
    if (fetching) return;

    const cached = loadCache();
    if (cached && Array.isArray(cached.ids)) {
      wlSet = new Set(cached.ids);
      scheduleMark();
    }
    const fresh = cached && (Date.now() - cached.ts) < CONFIG.cacheTtlMinutes * 60000;
    if (!force && fresh) return;

    fetching = true;
    try {
      const ids = await fetchWatchLater();
      const prevCount = cached && cached.ids ? cached.ids.length : 0;
      // Don't wipe a good cache if a background fetch returned empty (likely transient),
      // unless the refresh was explicitly forced from the menu.
      if (ids.size === 0 && prevCount > 0 && !force) {
        log('fetched 0 items, keeping previous cache');
      } else {
        wlSet = ids;
        saveCache(ids);
        scheduleMark();
      }
    } catch (e) {
      log('fetch failed', e);
    } finally {
      fetching = false;
    }
  }

  /* ----------------------------------------------------------------------
   * Live updates: optimistically reflect Watch Later add/remove the instant
   * the user does it, by observing the internal playlist-edit API calls.
   * This is language-independent (it reads the request payload, not UI text),
   * so it works for the hover "Watch later" button, the Save menu, and the
   * player's Save button alike. The periodic refetch reconciles afterwards.
   * -------------------------------------------------------------------- */
  function applyPlaylistEdit(text) {
    if (typeof text !== 'string' || !text) return;
    if (text.indexOf('addedVideoId') === -1 && text.indexOf('removedVideoId') === -1) return;

    let isWL = false;
    const adds = [];
    const rems = [];

    let obj = null;
    try { obj = JSON.parse(text); } catch (e) { obj = null; }

    if (obj) {
      isWL = obj.playlistId === 'WL';
      const actions = Array.isArray(obj.actions) ? obj.actions : [];
      for (const act of actions) {
        if (act && typeof act.addedVideoId === 'string') adds.push(act.addedVideoId);
        if (act && typeof act.removedVideoId === 'string') rems.push(act.removedVideoId);
      }
      // Some payloads nest the id elsewhere; fall back to a plain string check.
      if (!isWL && /"playlistId"\s*:\s*"WL"/.test(text)) isWL = true;
    } else {
      if (!/"playlistId"\s*:\s*"WL"/.test(text)) return;
      isWL = true;
      let m;
      const addRe = /"addedVideoId"\s*:\s*"([0-9A-Za-z_-]{11})"/g;
      while ((m = addRe.exec(text))) adds.push(m[1]);
      const remRe = /"removedVideoId"\s*:\s*"([0-9A-Za-z_-]{11})"/g;
      while ((m = remRe.exec(text))) rems.push(m[1]);
    }

    if (!isWL) return;

    let changed = false;
    for (const id of adds) if (VIDEO_ID_RE.test(id) && !wlSet.has(id)) { wlSet.add(id); changed = true; }
    for (const id of rems) if (wlSet.delete(id)) changed = true;

    if (changed) {
      saveCache(wlSet);
      scheduleMark();
      log('optimistic WL update; size now', wlSet.size);
    }
  }

  function hookPlaylistEdits() {
    const w = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

    // Hook fetch (YouTube's innertube API uses fetch for playlist edits).
    try {
      if (typeof w.fetch === 'function' && !w.fetch.__wlHooked) {
        const origFetch = w.fetch;
        const hooked = function (input, init) {
          try {
            const body = init && init.body;
            if (typeof body === 'string') applyPlaylistEdit(body);
          } catch (e) { /* never break the page's request */ }
          return origFetch.apply(this, arguments);
        };
        hooked.__wlHooked = true;
        w.fetch = hooked;
      }
    } catch (e) { log('fetch hook failed', e); }

    // Hook XHR as a safety net.
    try {
      const XHR = w.XMLHttpRequest;
      if (XHR && XHR.prototype && !XHR.prototype.__wlHooked) {
        const origSend = XHR.prototype.send;
        XHR.prototype.send = function (body) {
          try { if (typeof body === 'string') applyPlaylistEdit(body); } catch (e) {}
          return origSend.apply(this, arguments);
        };
        XHR.prototype.__wlHooked = true;
      }
    } catch (e) { log('xhr hook failed', e); }
  }

  /* ----------------------------------------------------------------------
   * DOM marking
   * -------------------------------------------------------------------- */
  function getVideoId(a) {
    const href = a.getAttribute('href');
    if (!href) return null;
    try {
      const u = new URL(href, ORIGIN);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      if (CONFIG.markShorts) {
        const m = u.pathname.match(/^\/shorts\/([^/?#]+)/);
        if (m) return m[1];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // Channel-avatar links can also point at /watch on some home-page cards, which
  // caused a duplicate badge to land on the author's avatar. A link is treated
  // as an avatar (and skipped) when it carries an avatar element but no real
  // video thumbnail element.
  function isAvatarAnchor(a) {
    if (a.closest('#avatar-link, yt-decorated-avatar-view-model, yt-avatar-shape, .yt-spec-avatar-shape')) return true;
    const hasAvatar = a.querySelector('#avatar, yt-img-shadow#avatar, yt-decorated-avatar-view-model, yt-avatar-shape, .yt-spec-avatar-shape');
    if (!hasAvatar) return false;
    const hasThumb = a.querySelector('ytd-thumbnail, yt-thumbnail-view-model, yt-image');
    return !hasThumb;
  }

  // Only treat anchors that actually contain a thumbnail image as targets,
  // so we badge the thumbnail and not the title/avatar/other links.
  function looksLikeThumbnail(a) {
    if (isAvatarAnchor(a)) return false;
    return !!a.querySelector('img, yt-image, .yt-core-image, ytd-thumbnail, yt-thumbnail-view-model');
  }

  function ensurePositioned(a) {
    if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
  }

  function buildClockSvg() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of CLOCK_PATHS) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  function addBadge(a) {
    if (a.querySelector(':scope > .wl-badge')) return;
    const b = document.createElement('div');
    b.className = 'wl-badge' + (CONFIG.showLabel ? ' wl-badge--label' : '');
    b.title = 'In Watch Later';
    b.appendChild(buildClockSvg());
    if (CONFIG.showLabel) {
      const span = document.createElement('span');
      span.className = 'wl-badge-text';
      span.textContent = 'Watch Later';
      b.appendChild(span);
    }
    a.appendChild(b);
  }

  function removeBadge(a) {
    a.querySelectorAll(':scope > .wl-badge').forEach(n => n.remove());
  }

  function processAnchor(a) {
    const id = getVideoId(a);
    if (!id) { removeBadge(a); a.removeAttribute('data-wl-id'); return; }
    const desired = wlSet.has(id);
    // Reconcile only when something changed (handles DOM nodes YouTube recycles
    // for new videos as you scroll).
    if (a.dataset.wlId === id && a.dataset.wlState === (desired ? '1' : '0')) return;
    a.dataset.wlId = id;
    a.dataset.wlState = desired ? '1' : '0';
    if (desired) { ensurePositioned(a); addBadge(a); }
    else { removeBadge(a); }
  }

  // The Watch Later page lists only WL videos, so every badge there is redundant.
  function isWatchLaterPage() {
    if (!CONFIG.hideOnWatchLaterPage) return false;
    try {
      if (location.pathname !== '/playlist') return false;
      return new URLSearchParams(location.search).get('list') === 'WL';
    } catch (e) { return false; }
  }

  function clearAllBadges() {
    document.querySelectorAll('.wl-badge').forEach(n => n.remove());
    document.querySelectorAll('[data-wl-id]').forEach(n => {
      n.removeAttribute('data-wl-id');
      n.removeAttribute('data-wl-state');
    });
  }

  function markAll() {
    // Suppress badges entirely on the Watch Later playlist page.
    if (isWatchLaterPage()) { clearAllBadges(); return; }

    const sel = CONFIG.markShorts
      ? 'a[href*="/watch?v="], a[href*="/shorts/"]'
      : 'a[href*="/watch?v="]';
    document.querySelectorAll(sel).forEach(a => {
      if (looksLikeThumbnail(a)) processAnchor(a);
    });
  }

  function scheduleMark() {
    if (markTimer) return;
    markTimer = setTimeout(() => { markTimer = null; markAll(); }, CONFIG.rescanDebounceMs);
  }

  /* ----------------------------------------------------------------------
   * Styles
   * -------------------------------------------------------------------- */
  function hexToRgba(hex, alpha) {
    try {
      let h = String(hex).trim().replace(/^#/, '');
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      if ([r, g, b].some(Number.isNaN)) return hex;
      const a = (typeof alpha === 'number' && alpha >= 0 && alpha <= 1) ? alpha : 1;
      return `rgba(${r},${g},${b},${a})`;
    } catch (e) { return hex; }
  }

  function injectStyles() {
    const corners = {
      'top-left': 'top:6px;left:6px;',
      'top-right': 'top:6px;right:6px;',
      'bottom-left': 'bottom:6px;left:6px;',
      'bottom-right': 'bottom:6px;right:6px;',
    };
    const pos = corners[CONFIG.badgeCorner] || corners['top-left'];
    const bg = hexToRgba(CONFIG.bgColor, CONFIG.bgOpacity);
    const css =
      '.wl-badge{' +
        'position:absolute;' + pos +
        'z-index:60;' +
        'display:inline-flex;align-items:center;gap:4px;' +
        'height:22px;padding:0 5px;box-sizing:border-box;' +
        'border-radius:6px;' +
        'background:' + bg + ';color:' + CONFIG.fgColor + ';' +
        'font:500 11px/1 "Roboto","Arial",sans-serif;' +
        'box-shadow:0 1px 3px rgba(0,0,0,.35);' +
        '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);' +
        'pointer-events:none;' +
      '}' +
      // Drop-shadow keeps the white clock readable now that the background is see-through.
      '.wl-badge svg{width:15px;height:15px;display:block;fill:' + CONFIG.fgColor + ';' +
        'filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.55));}' +
      '.wl-badge--label{padding:0 7px 0 5px;}' +
      '.wl-badge-text{white-space:nowrap;text-shadow:0 1px 1.5px rgba(0,0,0,.55);}';
    if (typeof GM_addStyle === 'function') GM_addStyle(css);
    else { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }
  }

  /* ----------------------------------------------------------------------
   * Menu + init
   * -------------------------------------------------------------------- */
  function registerMenu() {
    try {
      GM_registerMenuCommand('Refresh Watch Later now', () => ensureWatchLater(true));
      GM_registerMenuCommand('Clear cached list', () => {
        try { GM_setValue(cacheKey(), ''); } catch (e) {}
        wlSet = new Set();
        clearAllBadges();
        scheduleMark();
      });
    } catch (e) { /* menu API unavailable */ }
  }

  function init() {
    // Install the live add/remove hooks as early as possible.
    hookPlaylistEdits();

    injectStyles();
    registerMenu();
    ensureWatchLater(false);

    const mo = new MutationObserver(() => scheduleMark());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // YouTube is a SPA: re-check on navigation and data updates.
    window.addEventListener('yt-navigate-finish', () => { ensureWatchLater(false); scheduleMark(); });
    window.addEventListener('yt-page-data-updated', () => scheduleMark());

    // Safety net for recycled/virtualized list nodes.
    setInterval(scheduleMark, 2000);

    scheduleMark();
  }

  init();
})();
