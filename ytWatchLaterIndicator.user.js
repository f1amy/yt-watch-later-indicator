// ==UserScript==
// @name         YouTube Watch Later Indicator
// @namespace    https://github.com/f1amy/yt-watch-later-indicator
// @homepageURL  https://github.com/f1amy/yt-watch-later-indicator
// @version      1.2.0
// @description  Marks thumbnails of videos already in your Watch Later playlist, and brings back a one-click "Watch later" button on thumbnail hover.
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

    // Text next to the clock icon:
    // 'auto'   = only on thumbnails at least `labelMinWidth` px wide (home, search, sidebar)
    // 'always' | 'never'
    showLabel: 'auto',
    labelMinWidth: 240,

    // Also badge Shorts thumbnails (Shorts you've added to Watch Later).
    markShorts: true,

    // A "Watch later" button in the thumbnail's top-right corner on hover, like YouTube
    // used to have: a clock adds the video, a check mark (already in Watch Later) removes it.
    // Shown on video thumbnails everywhere except the Watch Later page and Shorts.
    showButton: true,

    // Badge look. The defaults match YouTube's own duration label, with the clock
    // in YouTube's link blue so it stands out from the other labels.
    bgColor: 'rgba(0,0,0,.8)',
    fgColor: '#ffffff',
    iconColor: '#3ea6ff',

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
  const W = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
  const ORIGIN = 'https://www.youtube.com';
  const STORE_KEY = 'ytwl_cache';
  // SVG built via DOM APIs (not innerHTML) so it works under YouTube's
  // Trusted Types CSP, which blocks string-to-HTML assignment.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CLOCK_PATHS = [
    'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
    'M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  ];
  const CHECK_PATH = 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';
  // [badge label / "add" button tooltip, "remove" button tooltip]
  const LABELS = {
    en: ['Watch later', 'Remove from Watch later'],
    ru: ['Смотреть позже', 'Удалить из «Смотреть позже»'],
    uk: ['Переглянути пізніше', 'Видалити з «Переглянути пізніше»'],
    de: ['Später ansehen', 'Aus „Später ansehen“ entfernen'],
  };
  const VIDEO_ID_RE = /^[0-9A-Za-z_-]{11}$/;
  // Cards on which hovering starts YouTube's inline preview, whose mute/CC buttons take the
  // top-right corner: the button sits left of them there.
  const PREVIEW_CARDS = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer';
  const CARDS = PREVIEW_CARDS + ', yt-lockup-view-model, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer';

  let wlSet = new Set();     // current Watch Later video IDs
  let entryIds = new Map();  // playlist entry id (setVideoId) -> video id, to resolve removals made on the WL page
  let fetching = null;       // promise of the running fetch, so a forced refresh can wait for it
  let markTimer = null;      // debounce handle
  let editsSent = 0;         // edit_playlist requests seen leaving the page (to tell if YouTube acted on a click)

  const log = (...a) => CONFIG.debug && console.log('[WL-Indicator]', ...a);

  /* ----------------------------------------------------------------------
   * ytcfg / cookies helpers (used for the internal YouTube API calls)
   * -------------------------------------------------------------------- */
  function ytcfgGet(key) {
    try {
      if (W.ytcfg && typeof W.ytcfg.get === 'function') return W.ytcfg.get(key);
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
    return { client: { clientName: 'WEB', clientVersion: '2.20261001.00.00', hl: 'en', gl: 'US' } };
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

  // Recursively collect playlist entries ({ videoId, setVideoId }) from any YouTube response shape.
  function extractEntries(root) {
    const out = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const x of n) walk(x); return; }
      const pv = n.playlistVideoRenderer;
      if (pv && pv.videoId) out.push({ videoId: pv.videoId, setVideoId: pv.setVideoId });
      const lv = n.lockupViewModel;
      if (lv && lv.contentId && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') out.push({ videoId: lv.contentId });
      for (const k in n) walk(n[k]);
    })(root);
    return out;
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

  // POST to an internal YouTube API endpoint ('browse', 'browse/edit_playlist', ...).
  async function innertube(endpoint, extra) {
    const apiKey = ytcfgGet('INNERTUBE_API_KEY');
    const context = ytcfgGet('INNERTUBE_CONTEXT') || defaultContext();
    const url = `${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false${apiKey ? `&key=${apiKey}` : ''}`;
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
    if (!res.ok) { log(endpoint, 'HTTP', res.status); return null; }
    return res.json();
  }

  async function fetchWatchLater() {
    const ids = new Set();
    const entries = new Map();
    const take = (data) => {
      for (const e of extractEntries(data)) {
        ids.add(e.videoId);
        if (e.setVideoId) entries.set(e.setVideoId, e.videoId);
      }
      return extractContinuation(data);
    };
    let token = null;

    // 1) First page from rendered HTML (reliable auth via cookies).
    try {
      const res = await fetch(`${ORIGIN}/playlist?list=WL&hl=en`, { credentials: 'include' });
      if (res.ok) {
        const data = extractInitialData(await res.text());
        if (data) token = take(data);
      }
    } catch (e) { log('html fetch error', e); }

    // Fallback: if HTML gave us nothing, try the internal browse endpoint.
    if (ids.size === 0 && !token) {
      const data = await innertube('browse', { browseId: 'VLWL' });
      if (data) token = take(data);
    }

    // 2) Remaining pages via continuations.
    let page = 0;
    while (token && page < 300) {
      const data = await innertube('browse', { continuation: token });
      if (!data) break;
      const before = ids.size;
      token = take(data);
      page++;
      if (ids.size === before && !token) break;
    }

    log('fetched', ids.size, 'Watch Later videos');
    return { ids, entries };
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
  function saveCache(ts) {
    try {
      const prev = loadCache();
      GM_setValue(cacheKey(), JSON.stringify({
        ts: ts || (prev && prev.ts) || Date.now(), // a live edit doesn't make the whole list fresh
        ids: [...wlSet],
        entries: [...entryIds],
      }));
    } catch (e) { /* ignore */ }
  }

  function ensureWatchLater(force) {
    // A forced refresh asked for while a fetch is running runs right after it.
    if (fetching) return force ? fetching.then(() => ensureWatchLater(true)) : fetching;

    const cached = loadCache();
    if (cached && Array.isArray(cached.ids)) {
      wlSet = new Set(cached.ids);
      entryIds = new Map(Array.isArray(cached.entries) ? cached.entries : []);
      scheduleMark();
    }
    const fresh = cached && (Date.now() - cached.ts) < CONFIG.cacheTtlMinutes * 60000;
    if (!force && fresh) return Promise.resolve();

    fetching = (async () => {
      try {
        const { ids, entries } = await fetchWatchLater();
        const prevCount = cached && cached.ids ? cached.ids.length : 0;
        // Don't wipe a good cache if a background fetch returned empty (likely transient),
        // unless the refresh was explicitly forced from the menu.
        if (ids.size === 0 && prevCount > 0 && !force) {
          log('fetched 0 items, keeping previous cache');
        } else {
          wlSet = ids;
          entryIds = entries;
          saveCache(Date.now());
          scheduleMark();
        }
      } catch (e) {
        log('fetch failed', e);
      } finally {
        fetching = null;
      }
    })();
    return fetching;
  }

  /* ----------------------------------------------------------------------
   * Live updates: reflect Watch Later add/remove the instant the user does
   * it, by observing the internal playlist-edit API calls
   * (/youtubei/v1/browse/edit_playlist). This is language-independent (it
   * reads the request payload, not UI text), so it works for the hover
   * "Watch later" button, the Save menu, the player's Save button and the
   * Watch Later page's own "Remove" alike.
   *
   * YouTube compresses the JSON body of these requests: the page hands fetch
   * a binary body (Uint8Array/Blob) that begins with the gzip signature
   * 1f 8b. So we take a non-destructive copy of the body, detect the format
   * from its first bytes, decompress it with the browser's built-in
   * DecompressionStream, and only then parse it. The change is applied once
   * YouTube's response comes back OK; the periodic refetch reconciles later.
   *
   * Actions seen (Oct 2026):
   *   ACTION_ADD_VIDEO                { addedVideoId }   hover button / Save menu
   *   ACTION_REMOVE_VIDEO_BY_VIDEO_ID { removedVideoId } hover button / Save menu
   *   ACTION_REMOVE_VIDEO             { setVideoId }     "Remove" on the WL page (entry id only)
   * -------------------------------------------------------------------- */
  function applyPlaylistEdit(text, responseJson) {
    if (typeof text !== 'string' || !text) return;
    let req = null;
    try { req = JSON.parse(text); } catch (e) { return; }
    if (!req || req.playlistId !== 'WL' || !Array.isArray(req.actions)) return;

    // The reply to an add lists the new entry's setVideoId: remember it, so removing that
    // entry from the WL page later can be resolved without a refetch.
    for (const e of extractAddedEntries(responseJson)) entryIds.set(e.setVideoId, e.videoId);

    let changed = false, unresolved = false;
    for (const act of req.actions) {
      if (!act) continue;
      if (typeof act.addedVideoId === 'string' && VIDEO_ID_RE.test(act.addedVideoId) && !wlSet.has(act.addedVideoId)) {
        wlSet.add(act.addedVideoId); changed = true;
      }
      if (typeof act.removedVideoId === 'string' && wlSet.delete(act.removedVideoId)) changed = true;
      if (act.action === 'ACTION_REMOVE_VIDEO' && typeof act.setVideoId === 'string') {
        const id = entryIds.get(act.setVideoId);
        entryIds.delete(act.setVideoId);
        if (id) { if (wlSet.delete(id)) changed = true; }
        else unresolved = true;
      }
    }

    if (changed) {
      saveCache();
      markAll();
      log('live WL update; size now', wlSet.size);
    }
    // An entry we don't know (added in another tab or device): just refetch the list.
    if (unresolved) { log('unknown WL entry removed, refetching'); ensureWatchLater(true); }
  }

  // { playlistEditResults: [{ playlistEditVideoAddedResultData: { videoId, setVideoId } }] }
  function extractAddedEntries(res) {
    const results = (res && Array.isArray(res.playlistEditResults)) ? res.playlistEditResults : [];
    return results
      .map(r => r && r.playlistEditVideoAddedResultData)
      .filter(d => d && typeof d.videoId === 'string' && typeof d.setVideoId === 'string');
  }

  const EDIT_PLAYLIST_RE = /\/youtubei\/v1\/browse\/edit_playlist(?:[?#]|$)/;

  function requestUrlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;   // Request
      if (input && typeof input.href === 'string') return input.href; // URL
    } catch (e) { /* ignore */ }
    return '';
  }

  // Identify the encoding from the body's first bytes rather than headers.
  function sniffCompression(bytes) {
    if (bytes.length < 2) return null;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
    // zlib wrapper: CM = 8 (deflate) and the 16-bit header is a multiple of 31
    if ((bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) return 'deflate';
    return null;
  }

  async function bytesToText(bytes) {
    const format = sniffCompression(bytes);
    log('edit_playlist body:', format || 'uncompressed', bytes.length, 'bytes');
    if (!format) return new TextDecoder().decode(bytes);
    if (typeof DecompressionStream !== 'function') { log('DecompressionStream not supported'); return null; }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Response(stream).text();
  }

  // Copy a body into bytes without consuming what the page is about to send.
  // new Response(x) accepts string / ArrayBuffer / typed array / Blob /
  // URLSearchParams / FormData and takes its own copy of the data.
  function bodyToText(body) {
    return new Response(body).arrayBuffer().then(buf => bytesToText(new Uint8Array(buf)));
  }

  // Must run BEFORE the real fetch() so a stream body can be split first.
  // Returns a promise of the decoded body text, or null if there is no body.
  function captureFetchBody(input, init) {
    if (init && init.body != null) {
      let body = init.body;
      if (typeof body.getReader === 'function') {
        // ReadableStream: a stream can only be read once, so split it and
        // give the page its own branch.
        const [mine, theirs] = body.tee();
        init.body = theirs;
        body = mine;
      }
      return bodyToText(body);
    }
    if (input && typeof input.clone === 'function' && typeof input.url === 'string') {
      // Request object: read a clone, the original stays untouched for the page.
      return input.clone().arrayBuffer().then(buf => bytesToText(new Uint8Array(buf)));
    }
    return null;
  }

  function hookPlaylistEdits() {
    // fetch: YouTube's innertube client sends playlist edits this way.
    try {
      if (typeof W.fetch === 'function' && !W.fetch.__wlHooked) {
        const origFetch = W.fetch;
        const hooked = function (input, init) {
          let bodyText = null;
          try {
            if (EDIT_PLAYLIST_RE.test(requestUrlOf(input))) { editsSent++; bodyText = captureFetchBody(input, init); }
          } catch (e) { log('body capture failed', e); }

          const result = origFetch.apply(this, arguments);

          if (bodyText) {
            // Clone the response the moment it arrives: this callback is registered before the
            // page's own, so it runs first, before YouTube reads (and locks) the body.
            const copy = result.then(res => res.clone());
            Promise.all([copy, bodyText])
              .then(([res, text]) => {
                if (!res || !res.ok || !text) { log('edit_playlist not applied, HTTP', res && res.status); return; }
                return res.json().catch(() => null).then(json => applyPlaylistEdit(text, json));
              })
              .catch(e => log('edit_playlist hook error', e));
          }
          return result; // the page gets the untouched original promise
        };
        hooked.__wlHooked = true;
        W.fetch = hooked;
      }
    } catch (e) { log('fetch hook failed', e); }

    // XHR as a safety net.
    try {
      const proto = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
      if (proto && !proto.__wlHooked) {
        const origOpen = proto.open;
        const origSend = proto.send;
        proto.open = function (method, url) {
          try { this.__wlEdit = EDIT_PLAYLIST_RE.test(String(url)); } catch (e) { /* ignore */ }
          return origOpen.apply(this, arguments);
        };
        proto.send = function (body) {
          try {
            if (this.__wlEdit) editsSent++;
            if (this.__wlEdit && body != null) {
              const xhr = this;
              const bodyText = bodyToText(body);
              bodyText.catch(() => {}); // avoid unhandled rejections if the request never loads
              xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                  let json = null;
                  try { json = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
                  bodyText.then(t => { if (t) applyPlaylistEdit(t, json); })
                    .catch(e => log('edit_playlist xhr hook error', e));
                }
              });
            }
          } catch (e) { /* never break the page's request */ }
          return origSend.apply(this, arguments);
        };
        proto.__wlHooked = true;
      }
    } catch (e) { log('xhr hook failed', e); }
  }

  /* ----------------------------------------------------------------------
   * DOM marking
   * -------------------------------------------------------------------- */
  function getVideoId(href) {
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
    if (a.classList.contains('ytLockupMetadataViewModelTitle')) return false;
    // Chapter ("key moments") thumbnails in search results link to the same video.
    if (a.closest('ytd-macro-markers-list-item-renderer')) return false;
    if (isAvatarAnchor(a)) return false;
    return !!a.querySelector('img, yt-image, .yt-core-image, ytd-thumbnail, yt-thumbnail-view-model');
  }

  function labels() {
    const lang = (document.documentElement.lang || 'en').toLowerCase().split('-')[0];
    return LABELS[lang] || LABELS.en;
  }

  function buildSvg(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  function buildBadge() {
    const b = document.createElement('div');
    b.className = 'wl-badge';
    b.title = 'In Watch Later';
    b.appendChild(buildSvg(CLOCK_PATHS));
    if (CONFIG.showLabel !== 'never') {
      const span = document.createElement('span');
      span.className = 'wl-badge-text';
      span.textContent = labels()[0];
      b.appendChild(span);
    }
    return b;
  }

  function badgeOf(a) { return a.querySelector(':scope > .wl-badge'); }

  // Label only where the thumbnail is wide enough to carry it (re-checked on each scan,
  // so it follows window resizes). Thumbnails that aren't laid out yet keep their state.
  function sizeBadge(a, b) {
    if (CONFIG.showLabel !== 'auto') return;
    const w = a.getBoundingClientRect().width;
    if (w > 0) b.classList.toggle('wl-badge--icon', w < CONFIG.labelMinWidth);
  }

  /* ----------------------------------------------------------------------
   * "Watch later" hover button
   *   Clicking runs YouTube's own playlist-edit command (the one its menus use), so YouTube
   *   shows its usual "Saved to Watch later" toast with Undo, and the edit hook above updates
   *   the badge. If YouTube doesn't act on the command, the edit is sent directly instead.
   * -------------------------------------------------------------------- */
  function editCommand(videoId, add) {
    const action = add ? { addedVideoId: videoId, action: 'ACTION_ADD_VIDEO' }
                       : { removedVideoId: videoId, action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID' };
    return {
      commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/browse/edit_playlist' } },
      playlistEditEndpoint: { playlistId: 'WL', actions: [action] },
    };
  }

  async function toggleWatchLater(btn, videoId) {
    const add = !wlSet.has(videoId);
    btn.classList.add('wl-btn--busy');
    try {
      const before = editsSent;
      const cmd = editCommand(videoId, add);
      btn.dispatchEvent(new CustomEvent('yt-action', {
        bubbles: true, composed: true,
        detail: { actionName: 'yt-service-request', args: [btn, cmd], optionalAction: false, returnValue: [] },
      }));
      await new Promise(r => setTimeout(r, 1500));
      if (editsSent === before) {
        log('YouTube ignored the command, sending the edit directly');
        const body = cmd.playlistEditEndpoint;
        const json = await innertube('browse/edit_playlist', body);
        if (json) applyPlaylistEdit(JSON.stringify(body), json);
      }
      // The badge/button update when the edit's reply is applied; give it a moment.
      const t0 = Date.now();
      while (wlSet.has(videoId) !== add && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      log('toggle failed', e);
    } finally {
      btn.classList.remove('wl-btn--busy');
    }
  }

  function buildButton() {
    const b = document.createElement('button');
    b.className = 'wl-btn';
    b.type = 'button';
    const add = buildSvg(CLOCK_PATHS); add.classList.add('wl-btn-add');
    const on = buildSvg([CHECK_PATH]); on.classList.add('wl-btn-on');
    b.append(add, on);
    // The button lives inside the thumbnail link: keep clicks from opening the video.
    for (const type of ['mousedown', 'pointerdown', 'mouseup', 'pointerup']) b.addEventListener(type, e => e.stopPropagation());
    b.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const id = b.dataset.videoId;
      if (id && !b.classList.contains('wl-btn--busy')) toggleWatchLater(b, id);
    });
    return b;
  }

  function updateButton(a, id, inWL) {
    let b = a.querySelector(':scope > .wl-btn');
    if (!b) {
      b = buildButton();
      // The inline preview (ytd-video-preview) is one player YouTube moves over the hovered card;
      // in search results it covers the card's own button, so its link gets a button too.
      if (a.closest(PREVIEW_CARDS + ', ytd-video-preview')) b.classList.add('wl-btn--preview');
      a.appendChild(b);
    }
    b.dataset.videoId = id;
    b.classList.toggle('wl-btn--on', inWL);
    const [addLabel, removeLabel] = labels();
    b.title = inWL ? removeLabel : addLabel;
    b.setAttribute('aria-label', b.title);
    const w = a.getBoundingClientRect().width;
    if (w > 0) b.classList.toggle('wl-btn--sm', w < CONFIG.labelMinWidth);
  }

  // Buttons go on regular videos only (Shorts and the WL page itself are skipped).
  function wantsButton(href) {
    return CONFIG.showButton && !onWatchLaterPage() && /^\/watch\?/.test(href || '');
  }

  function processAnchor(a) {
    const href = a.getAttribute('href');
    const id = getVideoId(href);
    const desired = !!id && wlSet.has(id);
    const button = !!id && wantsButton(href);
    // Fast path: same link, same state as last time (YouTube recycles nodes as you
    // scroll, which changes the href, so that's what's compared).
    if (a.dataset.wlHref === href && a.dataset.wlState === (desired ? '1' : '0')) {
      const b = desired && badgeOf(a);
      if (b) sizeBadge(a, b);
      if (!desired || b) return;
    }
    a.dataset.wlHref = href || '';
    a.dataset.wlState = desired ? '1' : '0';
    if ((desired || button) && getComputedStyle(a).position === 'static') a.style.position = 'relative';
    if (desired && !hideBadges()) {
      let b = badgeOf(a);
      if (!b) { b = buildBadge(); a.appendChild(b); }
      sizeBadge(a, b);
    } else {
      const b = badgeOf(a);
      if (b) b.remove();
    }
    if (button) updateButton(a, id, desired);
    else { const b = a.querySelector(':scope > .wl-btn'); if (b) b.remove(); }
  }

  function onWatchLaterPage() {
    return location.pathname === '/playlist' && new URLSearchParams(location.search).get('list') === 'WL';
  }
  // The Watch Later page lists only WL videos, so every badge there is redundant.
  function hideBadges() { return CONFIG.hideOnWatchLaterPage && onWatchLaterPage(); }

  function clearAllBadges() {
    document.querySelectorAll('.wl-badge, .wl-btn').forEach(n => n.remove());
    document.querySelectorAll('[data-wl-href]').forEach(n => {
      n.removeAttribute('data-wl-href');
      n.removeAttribute('data-wl-state');
    });
  }

  const ANCHOR_SEL = CONFIG.markShorts ? 'a[href*="/watch?v="], a[href*="/shorts/"]' : 'a[href*="/watch?v="]';

  function markAll() {
    // Nothing to add on the Watch Later page (unless badges are wanted there).
    if (onWatchLaterPage() && hideBadges()) { clearAllBadges(); return; }
    document.querySelectorAll(ANCHOR_SEL).forEach(a => {
      // Anchors already classified skip the (costlier) thumbnail check.
      if ('wlHref' in a.dataset || looksLikeThumbnail(a)) processAnchor(a);
    });
  }

  function scheduleMark() {
    if (markTimer) return;
    markTimer = setTimeout(() => { markTimer = null; markAll(); }, CONFIG.rescanDebounceMs);
  }

  /* ----------------------------------------------------------------------
   * Styles
   * -------------------------------------------------------------------- */
  function injectStyles() {
    const corners = {
      'top-left': 'top:8px;left:8px;',
      'top-right': 'top:8px;right:8px;',
      'bottom-left': 'bottom:8px;left:8px;',
      'bottom-right': 'bottom:8px;right:8px;',
    };
    const pos = corners[CONFIG.badgeCorner] || corners['top-left'];
    const css =
      '.wl-badge{' +
        'position:absolute;' + pos +
        'z-index:60;' +
        'display:inline-flex;align-items:center;gap:4px;' +
        'padding:3px 7px 3px 5px;box-sizing:border-box;' +
        'border-radius:4px;' +
        'background:' + CONFIG.bgColor + ';color:' + CONFIG.fgColor + ';' +
        'font:500 12px/16px "Roboto","Arial",sans-serif;letter-spacing:.2px;white-space:nowrap;' +
        'pointer-events:none;' +
      '}' +
      '.wl-badge svg{width:16px;height:16px;flex:none;display:block;fill:' + CONFIG.iconColor + ';}' +
      // Icon-only: small thumbnails, or showLabel 'never'.
      '.wl-badge--icon,.wl-badge:not(:has(.wl-badge-text)){padding:2px;}' +
      '.wl-badge--icon .wl-badge-text{display:none;}' +
      // Shorts cards carry YouTube's own top-left chip ("New" etc.) inside the same link: stack below it.
      (CONFIG.badgeCorner.startsWith('top') ? 'a:has(> .shortsLockupViewModelHostBadge) > .wl-badge{top:32px;}' : '') +
      // Hover button: round, like YouTube's own preview buttons; hidden until the card is hovered.
      '.wl-btn{' +
        'position:absolute;top:8px;right:8px;z-index:61;' +
        'width:36px;height:36px;padding:0;margin:0;border:0;border-radius:50%;' +
        'display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.6);cursor:pointer;' +
        'opacity:0;pointer-events:none;transition:opacity .15s,background-color .15s;' +
      '}' +
      // (The preview only plays while a card is hovered, so its button shows whenever it's active.)
      ':is(' + CARDS + '):hover .wl-btn,a:hover > .wl-btn,ytd-video-preview[active] .wl-btn,.wl-btn:focus-visible{opacity:1;pointer-events:auto;}' +
      '.wl-btn:hover{background:rgba(0,0,0,.85);}' +
      '.wl-btn svg{width:20px;height:20px;fill:#fff;}' +
      '.wl-btn .wl-btn-on,.wl-btn--on .wl-btn-add{display:none;}' +
      '.wl-btn--on .wl-btn-on{display:block;fill:' + CONFIG.iconColor + ';}' +
      '.wl-btn--preview{right:56px;}' + // left of the inline preview's mute button
      '.wl-btn--sm{width:28px;height:28px;top:4px;right:4px;}' +
      '.wl-btn--sm svg{width:16px;height:16px;}' +
      '.wl-btn--busy{opacity:.5 !important;cursor:progress;}' +
      // Where YouTube still draws its own hover "Watch later" button (channel pages), it creates
      // it on hover inside the same link: step aside for it.
      'a:has(yt-thumbnail-hover-overlay-toggle-actions-view-model, ytd-thumbnail-overlay-toggle-button-renderer) > .wl-btn{display:none;}';
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
        entryIds = new Map();
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

    // New cards, and recycled ones (YouTube swaps the href on existing nodes as you scroll).
    const mo = new MutationObserver(() => scheduleMark());
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });

    // YouTube is a SPA: re-check on navigation and data updates.
    window.addEventListener('yt-navigate-finish', () => { ensureWatchLater(false); scheduleMark(); });
    window.addEventListener('yt-page-data-updated', () => scheduleMark());
    window.addEventListener('resize', () => scheduleMark());

    scheduleMark();
  }

  init();
})();
