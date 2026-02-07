// scripts/content.js - HotPlay v1.1.1
// Video controls: lock (X), volume boost, B marker, Z undo, brightness, quality (YouTube), chapters, frame step, F1 help

const STORAGE_KEY = 'vcConfig';

const DEFAULT_CONFIG = {
    shortcuts: {
        volUp: 'ArrowUp',
        volDown: 'ArrowDown',
        playPause: 'k',
        speedUp: '>',   // Shift + .
        speedDown: '<', // Shift + ,
        mute: 'm',
        seekBack: 'j',
        seekFwd: 'l',
        seekBack5: 'ArrowLeft',
        seekFwd5: 'ArrowRight'
    },
    settings: {
        volume: 40,   // stored as 0..200 percent (default 40%)
        speed: 1.0,
        muted: false,
        brightness: 100  // 50..150, applied as CSS filter (100 = normal)
    }
};

let config = null;
let activeOverlay = null;

// ---------------- Feature additions: Lock, Volume Boost, Marker (B), Undo (Z), Brightness, Help ----------------
const vcState = new WeakMap(); // per-video state: { audioCtx, sourceNode, gainNode, history:[], marker: null }
let siteLocked = false;
let lockedVideoRef = null;
let helpOverlayVisible = false;
const FRAME_STEP_DEFAULT = 1 / 30; // ~33ms for 30fps when frame rate unknown

function ensureVideoState(video) {
    if (!vcState.has(video)) {
        vcState.set(video, { audioCtx: null, sourceNode: null, gainNode: null, history: [], marker: null });
    }
    return vcState.get(video);
}

// Volume booster: up to 200% using WebAudio GainNode
function ensureAudioNodes(video) {
    try {

    // Guard: if audio node creation failed previously, skip re-creating nodes to avoid breaking playback.
    if (window.__HotPlay_audioNodeCreationFailed) { return; }

    const st = ensureVideoState(video);
    try {
        if (st.gainNode) return st;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return st;
        // create audio context lazily
        if (!st.audioCtx) {
            try {
                st.audioCtx = new AudioCtx();
            } catch (e) {
                // may be blocked until user gesture
                st.audioCtx = null;
                return st;
            }
        }
        if (!st.audioCtx) return st;
        // If we've already created a MediaElementSource for this video in another run, creating again will throw.
        // Guard: only create if not created
        if (!st.sourceNode) {
            try {
                st.sourceNode = st.audioCtx.createMediaElementSource(video);
                st.gainNode = st.audioCtx.createGain();
                st.sourceNode.connect(st.gainNode);
                st.gainNode.connect(st.audioCtx.destination);
                st.gainNode.gain.value = 1.0;
            } catch (e) {
                // Some browsers disallow multiple createMediaElementSource for the same element in different contexts.
                console.warn('VC: audio node creation failed', e);
            }
        }
    } catch (e) {
        console.warn('VC: audio nodes error', e);
    }
    return st;

    } catch (e) {
        console.warn('VC: audio node creation failed', e);
        window.__HotPlay_audioNodeCreationFailed = true;
        return;
    }
}

function applyVolumePercent(video, pct) {
    // pct is 0..200
    pct = Math.max(0, Math.min(200, Math.round(pct)));
    const st = ensureVideoState(video);
    if (pct <= 100) {
        try { video.volume = pct / 100; } catch(e){}
        if (st.gainNode) try { st.gainNode.gain.value = 1.0; } catch(e){}
    } else {
        // html5 volume = 1, then apply gain
        try { video.volume = 1.0; } catch(e){}
        const wantedGain = pct / 100.0;
        const s = ensureAudioNodes(video);
        if (s.gainNode) {
            try {
                s.gainNode.gain.value = wantedGain;
            } catch(e){
                console.warn('VC: cannot set gain', e);
            }
        } else {
            console.warn('VC: AudioContext/gain unavailable, cannot boost');
        }
    }
    // store the percent in config for persistence
    config.settings.volume = pct;
    saveConfig();
}

function getVolumePercent(video) {
    const st = vcState.get(video);
    if (st && st.gainNode) {
        try {
            const gain = st.gainNode.gain.value;
            if (gain > 1) return Math.round(gain * 100);
        } catch(e){}
    }
    try {
        return Math.round((video.volume || 0) * 100);
    } catch(e){
        return config.settings.volume || 40;
    }
}

// Brightness: CSS filter on video only (0..150%)
function applyBrightness(video, percent) {
    percent = Math.max(0, Math.min(200, Math.round(percent)));
    config.settings.brightness = percent;
    try {
        video.style.filter = percent === 100 ? 'none' : `brightness(${percent / 100})`;
    } catch (e) {}
    saveConfig();
}

function getBrightness(video) {
    return config.settings.brightness != null ? config.settings.brightness : 100;
}

function formatTime(secs) {
    if (!isFinite(secs) || secs < 0) return '0:00';
    secs = Math.floor(secs);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s2 = secs % 60;
    if (h>0) return `${h}:${String(m).padStart(2,'0')}:${String(s2).padStart(2,'0')}`;
    return `${m}:${String(s2).padStart(2,'0')}`;
}



// Marker ('B') functionality
function toggleMarker(video) {
    const st = ensureVideoState(video);
    if (!st.marker) {
        st.marker = video.currentTime;
        const t = formatTime(st.marker);
        showOverlay('pin', video, `Marker Set at ${t}`);
    } else {
        const prev = st.marker;
        video.currentTime = Math.max(0, prev || 0);
        showOverlay('pin', video, `Jumped to ${formatTime(video.currentTime)}`);
        st.marker = null;
    }
}



// History / Undo support
function pushHistory(video, action) {
    const st = ensureVideoState(video);
    st.history = st.history || [];
    st.history.push(action);
    if (st.history.length > 40) st.history.shift();
}

function undoLast(video) {
    const st = ensureVideoState(video);
    if (!st.history || st.history.length === 0) {
        showOverlay('play', video, 'Nothing to undo');
        return;
    }
    const act = st.history.pop();
    if (!act) return;
    if (act.type === 'seek') {
        video.currentTime = act.prev;
        showOverlay('seekBack', video, Math.round(Math.abs(act.prev - act.next)));
    } else if (act.type === 'speed') {
        video.playbackRate = act.prev;
        config.settings.speed = act.prev;
        saveConfig();
        showOverlay('speed', video, act.prev);
    } else if (act.type === 'play') {
        if (act.prevPaused) { video.pause(); showOverlay('pause', video, null); }
        else { const p = video.play(); showOverlay('play', video, null); if (p && p.catch) p.catch(()=>{}); }
    } else if (act.type === 'volume') {
        applyVolumePercent(video, act.prev);
        showOverlay('vol', video, act.prev);
    } else if (act.type === 'reset') {
        if (act.prevSpeed != null) video.playbackRate = act.prevSpeed;
        if (act.prevVol != null) applyVolumePercent(video, act.prevVol);
        if (act.prevBrightness != null) applyBrightness(video, act.prevBrightness);
        config.settings.speed = act.prevSpeed;
        config.settings.volume = act.prevVol;
        config.settings.brightness = act.prevBrightness;
        saveConfig();
        showOverlay('play', video, 'Reset undone');
    } else {
        showOverlay('play', video, 'Undone');
    }
}

// ----- YouTube: Quality (Shift+; / Shift+') -----
function isYouTube() {
    try { return /youtube\.com|youtu\.be/i.test(window.location.href); } catch (e) { return false; }
}

// YouTube player controls can be in document or inside #movie_player shadow root
function queryYT(selector) {
    const el = document.querySelector(selector);
    if (el) return el;
    const host = document.querySelector('#movie_player');
    if (host && host.shadowRoot) return host.shadowRoot.querySelector(selector);
    return null;
}
function queryYTAll(selector) {
    const list = document.querySelectorAll(selector);
    if (list.length) return list;
    const host = document.querySelector('#movie_player');
    if (host && host.shadowRoot) return host.shadowRoot.querySelectorAll(selector);
    return [];
}

// Open main settings panel (gear)
function openYouTubeSettingsPanel() {
    const gear = queryYT('.ytp-settings-button');
    if (gear) {
        gear.click();
        return true;
    }
    return false;
}

// Click the "Quality" row to open the quality submenu (Quality is usually last in the list)
function openYouTubeQualitySubmenu() {
    const panel = queryYT('.ytp-panel-menu') || queryYT('.ytp-settings-menu');
    if (!panel) return false;
    const items = panel.querySelectorAll('.ytp-menuitem');
    if (!items.length) return false;
    const qualityRow = Array.from(items).find(el => /quality|qualité|calidad|qualität|画质/i.test(el.textContent || '')) || items[items.length - 1];
    qualityRow.click();
    return true;
}

// up = true → decrease quality (next in list); up = false → increase quality (previous in list)
function clickYouTubeQualityOption(up) {
    const menu = queryYT('.ytp-quality-menu') || queryYT('.ytp-panel-menu');
    if (!menu) return false;
    const items = menu.querySelectorAll('.ytp-menuitem[role="menuitem"], .ytp-menuitem');
    if (!items.length) return false;
    const current = menu.querySelector('.ytp-menuitem[aria-checked="true"]') || menu.querySelector('.ytp-menuitem[aria-selected="true"]');
    let idx = current ? Array.from(items).indexOf(current) : -1;
    if (up) {
        if (idx < 0) return false;
        if (idx >= items.length - 1) return false;
        idx = idx + 1;
    } else {
        if (idx < 0) idx = 0;
        else if (idx <= 0) return false;
        else idx = idx - 1;
    }
    const target = items[idx];
    if (target) target.click();
    return !!target;
}

// Hide all settings/quality panels (main menu + submenus) so quality change is invisible
const YT_PANEL_HIDE_STYLE = [
    '.ytp-panel { opacity: 0 !important; transition: none !important; pointer-events: auto !important; }',
    '.ytp-settings-panel { opacity: 0 !important; transition: none !important; pointer-events: auto !important; }',
    '.ytp-panel-menu { opacity: 0 !important; transition: none !important; pointer-events: auto !important; }',
    '.ytp-panel-container { opacity: 0 !important; transition: none !important; pointer-events: auto !important; }',
    '.ytp-popup { opacity: 0 !important; transition: none !important; pointer-events: auto !important; }',
    '[class*="ytp-panel"] { opacity: 0 !important; transition: none !important; pointer-events: auto !important; }'
].join(' ');
const YT_PANEL_HIDE_ID = 'vc-hide-yt-panel';

function hideYouTubePanelUI() {
    try {
        if (document.getElementById(YT_PANEL_HIDE_ID)) return;
        const style = document.createElement('style');
        style.id = YT_PANEL_HIDE_ID;
        style.textContent = YT_PANEL_HIDE_STYLE;
        document.head.appendChild(style);
        const host = document.querySelector('#movie_player');
        if (host && host.shadowRoot && !host.shadowRoot.getElementById(YT_PANEL_HIDE_ID)) {
            const srStyle = document.createElement('style');
            srStyle.id = YT_PANEL_HIDE_ID;
            srStyle.textContent = YT_PANEL_HIDE_STYLE;
            host.shadowRoot.appendChild(srStyle);
        }
    } catch (e) {}
}

function showYouTubePanelUI() {
    try {
        const el = document.getElementById(YT_PANEL_HIDE_ID);
        if (el) el.remove();
        const host = document.querySelector('#movie_player');
        if (host && host.shadowRoot) {
            const srEl = host.shadowRoot.getElementById(YT_PANEL_HIDE_ID);
            if (srEl) srEl.remove();
        }
    } catch (e) {}
}

function changeYouTubeQuality(up) {
    if (!isYouTube()) return Promise.resolve(false);
    hideYouTubePanelUI();
    if (!openYouTubeSettingsPanel()) {
        showYouTubePanelUI();
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        setTimeout(() => {
            if (!openYouTubeQualitySubmenu()) {
                const back = queryYT('.ytp-settings-button');
                if (back) back.click();
                setTimeout(() => { showYouTubePanelUI(); resolve(false); }, 350);
                return;
            }
            setTimeout(() => {
                const ok = clickYouTubeQualityOption(up);
                setTimeout(() => {
                    const back = queryYT('.ytp-settings-button');
                    if (back) back.click();
                    // Restore UI only after panel has fully closed so the popup never flashes
                    setTimeout(() => {
                        showYouTubePanelUI();
                        resolve(ok);
                    }, 350);
                }, 200);
            }, 400);
        }, 400);
    });
}

// ----- Generic quality (any site): find quality/settings UI and cycle -----
const QUALITY_LEVEL_TEXT = /auto|(\d{3,4})\s*[pP]|hd|sd|high|low|best|worst/i;

function collectRoots() {
    const roots = [document];
    try {
        const walk = (root) => {
            const all = root.querySelectorAll('*');
            for (const el of all) {
                if (el.shadowRoot) roots.push(el.shadowRoot);
            }
        };
        walk(document);
        const host = document.querySelector('#movie_player');
        if (host && host.shadowRoot) {
            if (!roots.includes(host.shadowRoot)) roots.push(host.shadowRoot);
            host.shadowRoot.querySelectorAll('*').forEach(el => { if (el.shadowRoot) roots.push(el.shadowRoot); });
        }
    } catch (e) {}
    return roots;
}

function isClickable(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const tag = (el.tagName || '').toLowerCase();
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    const ok = ['button', 'a', 'menuitem', 'option', 'listbox'].includes(role) ||
        ['button', 'a'].includes(tag) || el.onclick || el.getAttribute?.('onclick') ||
        (el.closest && (el.closest('[role="menu"]') || el.closest('[role="listbox"]') || el.closest('button') || el.closest('a')));
    return !!ok;
}

function qualityLevelOrder(text) {
    if (!text) return -1;
    const m = text.match(/(\d{3,4})\s*[pP]/);
    if (m) return -parseInt(m[1], 10); // higher res first (1080 -> -1080)
    if (/auto/i.test(text)) return 0;
    if (/hd|high/i.test(text)) return -720;
    if (/sd|low/i.test(text)) return -360;
    return -999;
}

function findQualityOptions(roots) {
    const options = [];
    for (const root of roots) {
        try {
            const all = root.querySelectorAll('*');
            for (const el of all) {
                const text = (el.textContent || '').trim();
                if (text.length >= 2 && text.length < 60 && QUALITY_LEVEL_TEXT.test(text) && isClickable(el)) {
                    options.push({ el, text, order: qualityLevelOrder(text) });
                }
            }
        } catch (e) {}
    }
    const seen = new Set();
    return options.filter(({ el, text }) => {
        const k = text.replace(/\s/g, '').toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function findQualityOrSettingsTrigger(roots) {
    const triggers = [];
    const qualityWords = /quality|qualit[ée]|calidad|画质|resolution|settings|gear|cog|设置/i;
    for (const root of roots) {
        try {
            const buttons = root.querySelectorAll('button, [role="button"], a, [role="menuitem"], [class*="setting"], [class*="quality"], [aria-label]');
            for (const el of buttons) {
                const text = (el.textContent || '').trim();
                const label = (el.getAttribute && el.getAttribute('aria-label')) || '';
                const combined = (text + ' ' + label).toLowerCase();
                if (qualityWords.test(combined) && isClickable(el)) triggers.push(el);
            }
        } catch (e) {}
    }
    return triggers;
}

function changeQualityGeneric(up) {
    const roots = collectRoots();
    const options = findQualityOptions(roots);
    if (options.length === 0) {
        const triggers = findQualityOrSettingsTrigger(roots);
        if (triggers.length > 0) {
            triggers[0].click();
            return new Promise((resolve) => {
                setTimeout(() => {
                    const options2 = findQualityOptions(collectRoots());
                    const ok = clickGenericQualityOption(options2, up);
                    resolve(ok);
                }, 500);
            });
        }
        return Promise.resolve(false);
    }
    return Promise.resolve(clickGenericQualityOption(options, up));
}

function clickGenericQualityOption(options, up) {
    if (!options.length) return false;
    options.sort((a, b) => a.order - b.order); // highest quality first (most negative)
    const current = options.findIndex(o => {
        const el = o.el;
        return el.getAttribute?.('aria-checked') === 'true' || el.getAttribute?.('aria-selected') === 'true' ||
            el.classList?.contains('active') || el.classList?.contains('selected') || el.getAttribute?.('data-selected') === 'true';
    });
    let idx = current >= 0 ? current : 0;
    if (up) {
        if (idx >= options.length - 1) return false;
        idx = idx + 1;
    } else {
        if (idx <= 0) return false;
        idx = idx - 1;
    }
    const target = options[idx]?.el;
    if (target) {
        target.click();
        return true;
    }
    return false;
}

function changeVideoQuality(up) {
    if (isYouTube()) return changeYouTubeQuality(up);
    return changeQualityGeneric(up);
}

// ----- YouTube: Chapters (Shift+← / Shift+→) -----
function getYouTubeChapterTimes() {
    const times = [];
    try {
        const chipBar = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="chapters"] .ytd-macro-markers-list-renderer, ytd-macro-markers-list-renderer');
        const links = chipBar ? chipBar.querySelectorAll('a.ytd-macro-markers-list-item-renderer, [class*="macro-markers"] a') : [];
        links.forEach(a => {
            const href = a.getAttribute('href') || '';
            const t = href.match(/[?&]t=(\d+)/);
            if (t) times.push(parseInt(t[1], 10));
        });
        if (times.length) return [...new Set(times)].sort((a, b) => a - b);
        const desc = document.querySelector('#description-inline-expander a[href*="&t="], #description a[href*="&t="]');
        if (desc) {
            const match = desc.getAttribute('href').match(/[?&]t=(\d+)/);
            if (match) times.push(parseInt(match[1], 10));
        }
        const segments = document.querySelectorAll('ytd-macro-markers-list-item-renderer, [class*="macro-markers-list-item"]');
        segments.forEach(el => {
            const a = el.querySelector('a[href*="t="]');
            if (a) {
                const m = a.getAttribute('href').match(/[?&]t=(\d+)/);
                if (m) times.push(parseInt(m[1], 10));
            }
        });
        return [...new Set(times)].sort((a, b) => a - b);
    } catch (e) {}
    return times;
}

function goToPrevChapter(video) {
    const times = getYouTubeChapterTimes();
    const t = video.currentTime;
    const prev = times.filter(x => x < t - 1).pop();
    if (prev != null) {
        video.currentTime = prev;
        pushHistory(video, { type: 'seek', prev: t, next: prev });
        showOverlay('seekBack', video, Math.round(t - prev));
        return true;
    }
    return false;
}

function goToNextChapter(video) {
    const times = getYouTubeChapterTimes();
    const t = video.currentTime;
    const next = times.find(x => x > t + 1);
    if (next != null) {
        const prevTime = video.currentTime;
        video.currentTime = next;
        pushHistory(video, { type: 'seek', prev: prevTime, next });
        showOverlay('seek', video, Math.round(next - prevTime));
        return true;
    }
    return false;
}

// Lock toggle (X): prevent switching active video by hover/click until unlocked
function toggleSiteLock(video) {
    try {
        // Focus mode: create an overlay that sits exactly over the target video element
        // and intercepts pointer events to prevent site hover-UI from appearing. This
        // intentionally does NOT block the rest of the page so the site remains usable.
        const target = video || pickTargetVideo();
        if (!target) return;
        const existing = document.getElementById('vc_focus_overlay');
        if (!siteLocked) {
            siteLocked = true;
            lockedVideoRef = target;
            // create overlay
            const over = document.createElement('div');
            over.id = 'vc_focus_overlay';
            over.style.position = 'fixed';
            over.style.pointerEvents = 'auto';
            over.style.zIndex = '2147483646';
            over.style.background = 'transparent';
            over.style.borderRadius = '4px';
            over.setAttribute('aria-hidden','true');
            // place and size it to the video rect
            const place = () => {
                try {
                    const r = (lockedVideoRef && lockedVideoRef.getBoundingClientRect && lockedVideoRef.getBoundingClientRect()) || {left:0,top:0,width:0,height:0};
                    // clamp values inside viewport
                    const left = Math.max(0, r.left);
                    const top = Math.max(0, r.top);
                    over.style.left = left + 'px';
                    over.style.top = top + 'px';
                    over.style.width = Math.max(0, r.width) + 'px';
                    over.style.height = Math.max(0, r.height) + 'px';
                } catch(e) {}
            };
            // capture pointer events to prevent hover UI, but allow scroll/keyboard for page
            over.addEventListener('mousemove', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            over.addEventListener('mouseenter', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            over.addEventListener('mouseover', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            over.addEventListener('pointerdown', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            over.addEventListener('pointerup', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            over.addEventListener('click', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            // allow keyboard and other inputs to work as normal
            document.documentElement.appendChild(over);
            place();
            // update overlay on resize/scroll
            const upd = () => { place(); };
            window.addEventListener('resize', upd);
            window.addEventListener('scroll', upd, true);
            // small visual dim to indicate focus-mode
            try { over.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.12) inset'; } catch(e){}
            // show overlay message near the video
            showOverlay('locked', lockedVideoRef || target, 'Focus mode');
        } else {
            // remove overlay and restore
            siteLocked = false;
            const el = document.getElementById('vc_focus_overlay');
            if (el) {
                try { el.parentNode.removeChild(el); } catch(e){}
            }
            lockedVideoRef = null;
            showOverlay('locked', pickTargetVideo(), 'Focus off');
        }
    } catch(e) { console.warn('VC: toggleSiteLock error', e); }
}



// Save/restore for potential future per-site storage could be added here
// ---------------- End feature additions ----------------

(async function init(){
    const data = await chrome.storage.local.get([STORAGE_KEY]);
    config = { ...DEFAULT_CONFIG, ...(data[STORAGE_KEY] || {}) };

    // ensure nested merging
    config.shortcuts = { ...DEFAULT_CONFIG.shortcuts, ...(data[STORAGE_KEY]?.shortcuts || {}) };
    config.settings = { ...DEFAULT_CONFIG.settings, ...(data[STORAGE_KEY]?.settings || {}) };

    // normalize volume stored value if it's in 0..1 (older versions) -> convert to percent
    if (config.settings.volume && config.settings.volume <= 1) {
        config.settings.volume = Math.round(config.settings.volume * 100);
    }

    setupGlobalKeyHandler();
    monitorVideos();

    // periodic enforcement to counter site resets (only when tab visible to reduce lag)
    setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        const v = pickTargetVideo();
        if (v) enforceSettings(v);
    }, 3500);

    console.log('Video Commander: initialized');
})();

// helper: check if event is space key across browsers
function isSpaceEvent(e) {
    return e.key === ' ' || e.code === 'Space' || e.key === 'Spacebar';
}

// --- Video discovery & targeting ---
function pickTargetVideo() {
    // If site locked and we still have a reference that is in the DOM, use that
    try {
        if (siteLocked && lockedVideoRef && document.contains(lockedVideoRef)) return lockedVideoRef;
    } catch(e){}

    // 1. Hovered video
    const hovered = document.querySelectorAll('video:hover');
    if (hovered.length) return hovered[0];

    // 2. Playing video (most likely target)
    const playing = Array.from(document.getElementsByTagName('video')).find(v => !v.paused && v.readyState > 1);
    if (playing) return playing;

    // 3. Visible video
    const vids = Array.from(document.getElementsByTagName('video'));
    for (const v of vids) {
        if (isElementVisible(v)) return v;
    }

    // 4. any video
    return vids[0] || null;
}

function isElementVisible(el) {
    try {
        const rect = el.getBoundingClientRect();
        return rect.width > 10 && rect.height > 10 && rect.bottom >= 0 && rect.top <= (window.innerHeight || document.documentElement.clientHeight);
    } catch (e) { return false; }
}

// --- Overlay UI ---
function showOverlay(kind, video, value) {
    try {
        if (!video) return;
        // remove old
        if (activeOverlay) { activeOverlay.remove(); activeOverlay = null; }

        const iconMap = {
            vol: '🔊',
            mute: '🔇',
            seek: '►►',
            seekBack: '◄◄',
            speed: '⚡',
            play: '▶',
            pause: '❚❚',
            percent: '🔢',
            locked: '🔒',
            unlocked: '🔓',
            pin: '📌',
            brightness: '☀',
            quality: '📐'
        };

        const overlay = document.createElement('div');
        overlay.className = 'vc-overlay ' + (kind || 'play');

        const icon = document.createElement('div');
        icon.className = 'vc-icon';
        icon.textContent = iconMap[kind] || '🎬';

        // if we're showing a numeric keycap or custom emoji, prefer the provided value
        if (kind === 'num' && value) { icon.textContent = value; overlay.classList.add('num'); }
        if (kind === 'pin') { icon.textContent = iconMap['pin']; }

        const txt = document.createElement('div');
        txt.className = 'vc-text';
        let text = '';

        switch (kind) {
            case 'num': text = ''; break;
            case 'vol': text = `Volume: ${Math.round(value)}%`; break;
            case 'mute': text = value ? 'Muted' : 'Unmuted'; break;
            case 'seek': text = (value>0?('+'+value+'s'): (value<0? (value+'s'): 'Seek')); break;
            case 'seekBack': text = `${Math.abs(value)}s back`; break;
            case 'speed': text = `Speed: ${value}x`; break;
            case 'play': text = typeof value === 'string' ? value : 'Playing'; break;
            case 'pause': text = 'Paused'; break;
            case 'percent': text = `Marker: ${value}%`; break;
            case 'pin': text = (typeof value === 'string' && value.length>0) ? value : 'Marker set'; break;
            case 'brightness': text = `Brightness: ${value}%`; break;
            case 'quality': text = typeof value === 'string' ? value : 'Quality'; break;
            default: text = String(value || '');
        }
        txt.textContent = text;

        overlay.appendChild(icon);
        overlay.appendChild(txt);
        document.body.appendChild(overlay);
        activeOverlay = overlay;

        // DYNAMIC GLOW: for volume (>100 green, >150 red) and speed (>2 green, >3 red)
            overlay.classList.add('dynamic-glow');
            try {
                // helper to blend two RGB colors
                const blendColor = (c1, c2, t) => [
                    Math.round(c1[0] + (c2[0]-c1[0]) * t),
                    Math.round(c1[1] + (c2[1]-c1[1]) * t),
                    Math.round(c1[2] + (c2[2]-c1[2]) * t)
                ];
                let colorRGB = null, darkness = 0;
                if (kind === 'vol' && value) {
                    const v = Number(value) || 0;
                    if (v > 100) {
                        darkness = Math.min(1, (v - 100) / 100); // 100..200 -> 0..1
                        if (v <= 150) {
                            colorRGB = [0,160,0];
                        } else {
                            const t = Math.min(1, (v - 150) / 50); // 150..200 -> 0..1 blend to red
                            colorRGB = blendColor([0,160,0],[160,0,0], t);
                        }
                    }
                } else if (kind === 'speed' && value) {
                    const sp = Number(value) || 0;
                    if (sp > 2) {
                        darkness = Math.min(1, (sp - 2) / 2); // 2..4 -> 0..1
                        if (sp <= 3) {
                            colorRGB = [0,160,0];
                        } else {
                            const t = Math.min(1, (sp - 3) / 1); // 3..4 -> blend
                            colorRGB = blendColor([0,160,0],[160,0,0], t);
                        }
                    }
                }
                if (colorRGB) {
                    const boxAlpha = 0.08 + (0.6 * darkness); // 0.08..0.68
                    const borderAlpha = 0.08 + (0.55 * darkness);
                    overlay.style.boxShadow = `0 10px 40px rgba(${colorRGB[0]},${colorRGB[1]},${colorRGB[2]},${boxAlpha})`;
                    overlay.style.border = `1px solid rgba(${colorRGB[0]},${colorRGB[1]},${colorRGB[2]},${borderAlpha})`;
                } else {
                    overlay.style.boxShadow = ''; overlay.style.border = '';
                }
            } catch(e) { /* ignore */ }


        // add 'boost' class for volume >100
        if (kind === 'vol' && value && value > 100) overlay.classList.add('boost');
        else overlay.classList.remove('boost');

        // position at top-center of video (measure after append)
        const rect = video.getBoundingClientRect();
        const marginTop = 12;
        const ovRect = overlay.getBoundingClientRect();
        let left = rect.left + Math.max(0, (rect.width - ovRect.width) / 2);
        let top = rect.top + marginTop;
        // ensure overlay stays within viewport horizontally
        const maxLeft = Math.max(8, (window.innerWidth || document.documentElement.clientWidth) - ovRect.width - 8);
        left = Math.min(Math.max(8, left), maxLeft);
        if (top < 8) top = rect.top + 8; // avoid negative
        overlay.style.left = left + 'px';
        overlay.style.top = top + 'px';

        // small show animation
        requestAnimationFrame(() => { overlay.classList.add('vc-show'); });

        // remove after timeout (longer for percent/seek)
        const timeout = (kind === 'percent' || kind === 'seek' || kind === 'seekBack') ? 1100 : 800;
        setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); if (activeOverlay === overlay) activeOverlay = null; }, timeout);
    } catch (e) { console.warn('Overlay failed', e); }
}

// ----- Help Center (F1) -----
function getHelpShortcutsList() {
    const bindings = config?.shortcuts || DEFAULT_CONFIG.shortcuts;
    return [
        { key: 'F1', desc: 'Show this help' },
        { key: 'K', desc: 'Play / Pause' },
        { key: 'Space', desc: 'Play / Pause' },
        { key: 'M', desc: 'Mute / Unmute' },
        { key: '↑', desc: 'Volume up' },
        { key: '↓', desc: 'Volume down' },
        { key: 'J', desc: 'Seek −10 s' },
        { key: 'L', desc: 'Seek +10 s' },
        { key: '←', desc: 'Seek −5 s' },
        { key: '→', desc: 'Seek +5 s' },
        { key: 'Shift + .', desc: 'Speed up' },
        { key: 'Shift + ,', desc: 'Speed down' },
        { key: '0–9', desc: 'Jump to 0%–90%' },
        { key: 'B', desc: 'Set marker / jump to marker' },
        { key: 'Z', desc: 'Undo last action' },
        { key: 'X', desc: 'Focus lock on video' },
        { key: 'Shift + R', desc: 'Reset speed, volume, brightness' },
        { key: 'Z (after reset)', desc: 'Undo reset' },
        { key: '−', desc: 'Decrease brightness (video only)' },
        { key: '=', desc: 'Increase brightness (video only)' },
        { key: ";", desc: 'Decrease video quality' },
        { key: "'", desc: 'Increase video quality' },
        { key: 'Shift + ;', desc: 'Increase video quality' },
        { key: "Shift + '", desc: 'Decrease video quality' },
        { key: 'Shift + ←', desc: 'Previous chapter' },
        { key: 'Shift + →', desc: 'Next chapter' },
        { key: '/', desc: 'Frame-by-frame (one frame)' }
    ];
}

function showHelpOverlay() {
    if (helpOverlayVisible) {
        hideHelpOverlay();
        return;
    }
    const wrap = document.getElementById('vc-help-overlay');
    if (wrap) {
        wrap.classList.add('vc-show');
        helpOverlayVisible = true;
        return;
    }
    const overlay = document.createElement('div');
    overlay.id = 'vc-help-overlay';
    overlay.setAttribute('aria-label', 'HotPlay shortcuts');
    const panel = document.createElement('div');
    panel.id = 'vc-help-panel';
    panel.innerHTML = '<h2>HotPlay Shortcuts</h2>';
    const section = document.createElement('div');
    section.className = 'vc-help-section';
    const rows = getHelpShortcutsList();
    rows.forEach(({ key, desc }) => {
        const row = document.createElement('div');
        row.className = 'vc-help-row';
        row.innerHTML = `<span class="vc-help-key">${key}</span><span class="vc-help-desc">${desc}</span>`;
        section.appendChild(row);
    });
    panel.appendChild(section);
    const footer = document.createElement('div');
    footer.className = 'vc-help-footer';
    footer.textContent = 'Press F1 or click outside to close. Extension shortcuts override site shortcuts when conflicting.';
    panel.appendChild(footer);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideHelpOverlay(); });
    panel.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(overlay);
    helpOverlayVisible = true;
    overlay.classList.add('vc-show');
    const onKey = (e) => {
        if (e.key === 'Escape' || e.key === 'F1') {
            hideHelpOverlay();
            e.preventDefault();
            e.stopPropagation();
        }
    };
    window.addEventListener('keydown', onKey, true);
    overlay.dataset.cleanup = '1';
    overlay._helpKeyHandler = onKey;
}

function hideHelpOverlay() {
    const wrap = document.getElementById('vc-help-overlay');
    if (wrap) {
        wrap.classList.remove('vc-show');
        if (wrap._helpKeyHandler) window.removeEventListener('keydown', wrap._helpKeyHandler, true);
    }
    helpOverlayVisible = false;
}

// --- Keyboard handling ---
function setupGlobalKeyHandler() {
    const handler = (e) => {
        if (!config) return;

        const key = e.key;
        // 1. Context Check: Don't block typing in inputs
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        if (['input','textarea','select'].includes(activeTag) || document.activeElement?.isContentEditable) return;

        // F1 works even without a video (show help)
        if (key === 'F1') {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (e.type === 'keydown') showHelpOverlay();
            return;
        }

        const bindings = config.shortcuts;
        const video = pickTargetVideo();
        if (!video) return;

        const isNumber = !isNaN(parseInt(key)) && key.trim() !== '';
        const isSpace = isSpaceEvent(e);
        const normalizedBindings = Object.values(bindings).map(k => (k||'').toLowerCase());
        const isHotPlayOnly = key === 'F1' || key === '/' || (e.shiftKey && key.toLowerCase() === 'r') || key === '-' || key === '=' ||
            key === ';' || key === "'" ||
            (e.shiftKey && (key === ';' || key === "'" || key === 'ArrowLeft' || key === 'ArrowRight'));
        // 2. Identify if this is a key we care about (extension overrides site when conflicting)
        const isOurKey = normalizedBindings.includes(key.toLowerCase()) || isNumber || isSpace || ['b', 'z', 'x'].includes(key.toLowerCase()) || (isHotPlayOnly && key !== 'F1');

        if (isOurKey) {
            // 3. NUCLEAR OPTION: Stop the website from ever seeing this event
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // Only process logic on keydown to avoid double-triggering
            if (e.type === 'keydown') {
                handleLogic(video, key, bindings, isNumber, isSpace, e);
            }
        }
    };

    // Attach to both down and up, using useCapture = true
    window.addEventListener('keydown', handler, true);
    window.addEventListener('keyup', handler, true);
}

// Move your logic into a separate helper to keep the handler clean
function handleLogic(video, key, bindings, isNumber, isSpace, e) {
    const matchKey = (k) => (k.length === 1 ? key.toLowerCase() === k.toLowerCase() : key === k);
    const shift = e && e.shiftKey;

    // --- F1 Help ---
    if (key === 'F1') {
        showHelpOverlay();
        return;
    }
    // --- / Frame step ---
    if (key === '/') {
        const wasPaused = video.paused;
        video.pause();
        const step = FRAME_STEP_DEFAULT;
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + step);
        showOverlay('play', video, 'Frame');
        if (!wasPaused) setTimeout(() => { video.play().catch(() => {}); }, 120);
        return;
    }
    // --- Shift+R Reset ---
    if (e.shiftKey && key.toLowerCase() === 'r') {
        const prevSpeed = video.playbackRate || 1;
        const prevVol = getVolumePercent(video);
        const prevBrightness = getBrightness(video);
        pushHistory(video, { type: 'reset', prevSpeed, prevVol, prevBrightness });
        video.playbackRate = 1;
        config.settings.speed = 1;
        applyVolumePercent(video, 40);
        config.settings.volume = 40;
        applyBrightness(video, 100);
        showOverlay('play', video, 'Reset — Z to undo');
        saveConfig();
        return;
    }
    // --- − / + Brightness ---
    if (key === '-') {
        const cur = getBrightness(video);
        const next = Math.max(0, cur - 10);
        applyBrightness(video, next);
        showOverlay('brightness', video, next);
        return;
    }
    if (key === '=') {
        const cur = getBrightness(video);
        const next = Math.min(200, cur + 10);
        applyBrightness(video, next);
        showOverlay('brightness', video, next);
        return;
    }
    // --- ; / ' Quality: ; = decrease, ' = increase (YouTube + any site with quality UI) ---
    if (key === ';' && !shift) {
        showOverlay('quality', video, 'Quality…');
        changeVideoQuality(true).then((ok) => {
            const v = pickTargetVideo();
            if (ok) showOverlay('quality', v, 'Quality ↓');
            else showOverlay('quality', v, isYouTube() ? 'Already at lowest' : 'Quality: not available');
        });
        return;
    }
    if (key === "'" && !shift) {
        showOverlay('quality', video, 'Quality…');
        changeVideoQuality(false).then((ok) => {
            const v = pickTargetVideo();
            if (ok) showOverlay('quality', v, 'Quality ↑');
            else showOverlay('quality', v, isYouTube() ? 'Already at highest' : 'Quality: not available');
        });
        return;
    }
    // --- Shift+; / Shift+' Quality ---
    if (shift && key === ';') {
        showOverlay('quality', video, 'Quality…');
        changeVideoQuality(false).then((ok) => {
            const v = pickTargetVideo();
            if (ok) showOverlay('quality', v, 'Quality ↑');
            else showOverlay('quality', v, 'Quality: not available');
        });
        return;
    }
    if (shift && key === "'") {
        showOverlay('quality', video, 'Quality…');
        changeVideoQuality(true).then((ok) => {
            const v = pickTargetVideo();
            if (ok) showOverlay('quality', v, 'Quality ↓');
            else showOverlay('quality', v, 'Quality: not available');
        });
        return;
    }
    // --- Shift+← / Shift+→ Chapters ---
    if (shift && key === 'ArrowLeft') {
        if (!goToPrevChapter(video)) showOverlay('seekBack', video, 'No prev chapter');
        return;
    }
    if (shift && key === 'ArrowRight') {
        if (!goToNextChapter(video)) showOverlay('seek', video, 'No next chapter');
        return;
    }

    // --- B Key ---
    if (key.toLowerCase() === 'b') {
        // toggles marker: first press sets marker, second press jumps to it
        toggleMarker(video);
        return;
    }
    // --- Z Key ---
    if (key.toLowerCase() === 'z') {
        undoLast(video);
        return;
    }
    // --- X Key ---
    if (key.toLowerCase() === 'x') {
        toggleSiteLock(video);
        return;
    }
    // --- Numbers ---
    if (isNumber) {
		const n = parseInt(key);
		const pct = n * 10;

		if (video.duration) {
			const targetTime = video.duration * (pct / 100);
			
			pushHistory(video, {
				type: 'seek', 
				prev: video.currentTime, 
				next: targetTime
			});

			video.currentTime = targetTime;

			// Pure text overlay: "50%" or "0%"
			showOverlay('num', video, `${pct}%`);
			
			saveConfig();
		}
		return;
	}

    // --- Standard Shortcuts ---
    if (matchKey(bindings.volUp)) {
        let prevVol = getVolumePercent(video);
        let newVol = Math.min(200, (config.settings.volume||40) + 5);
        pushHistory(video, {type:'volume', prev: prevVol, next: newVol});
        config.settings.volume = newVol;
        applyVolumePercent(video, newVol);
        video.muted = false;
        showOverlay('vol', video, newVol);
        saveConfig();
    } else if (matchKey(bindings.volDown)) {
        let prevVol = getVolumePercent(video);
        let newVol = Math.max(0, (config.settings.volume||40) - 5);
        pushHistory(video, {type:'volume', prev: prevVol, next: newVol});
        config.settings.volume = newVol;
        applyVolumePercent(video, newVol);
        showOverlay('vol', video, newVol);
        saveConfig();
    } else if (matchKey(bindings.speedUp)) {
        let prevSpeed = video.playbackRate || 1;
        let newSpeed = Math.min(4.0, (config.settings.speed||1.0) + 0.25);
        pushHistory(video, {type:'speed', prev: prevSpeed, next: newSpeed});
        config.settings.speed = newSpeed;
        video.playbackRate = newSpeed;
        showOverlay('speed', video, newSpeed);
        saveConfig();
    } else if (matchKey(bindings.speedDown)) {
        let prevSpeed = video.playbackRate || 1;
        let newSpeed = Math.max(0.25, (config.settings.speed||1.0) - 0.25);
        pushHistory(video, {type:'speed', prev: prevSpeed, next: newSpeed});
        config.settings.speed = newSpeed;
        video.playbackRate = newSpeed;
        showOverlay('speed', video, newSpeed);
        saveConfig();
    } else if (matchKey(bindings.mute)) {
        video.muted = !video.muted;
        config.settings.muted = video.muted;
        showOverlay('mute', video, video.muted);
        saveConfig();
    } else if (matchKey(bindings.seekBack)) {
        pushHistory(video, {type:'seek', prev: video.currentTime, next: Math.max(0, video.currentTime - 10)});
        video.currentTime = Math.max(0, video.currentTime - 10);
        showOverlay('seekBack', video, 10);
    } else if (matchKey(bindings.seekFwd)) {
        pushHistory(video, {type:'seek', prev: video.currentTime, next: Math.min(video.duration||Infinity, video.currentTime + 10)});
        video.currentTime = Math.min(video.duration||Infinity, video.currentTime + 10);
        showOverlay('seek', video, 10);
    } else if (matchKey(bindings.seekBack5)) {
        pushHistory(video, {type:'seek', prev: video.currentTime, next: Math.max(0, video.currentTime - 5)});
        video.currentTime = Math.max(0, video.currentTime - 5);
        showOverlay('seekBack', video, 5);
    } else if (matchKey(bindings.seekFwd5)) {
        pushHistory(video, {type:'seek', prev: video.currentTime, next: Math.min(video.duration||Infinity, video.currentTime + 5)});
        video.currentTime = Math.min(video.duration||Infinity, video.currentTime + 5);
        showOverlay('seek', video, 5);
    } else if (matchKey(bindings.playPause) || isSpace) {
        if (video.paused) {
            pushHistory(video, {type:'play', prevPaused: true});
            video.play().then(() => showOverlay('play', video, null)).catch(() => {});
        } else {
            pushHistory(video, {type:'play', prevPaused: false});
            video.pause();
            showOverlay('pause', video, null);
        }
    }
}

// --- Persistence ---
function saveConfig() {
    chrome.storage.local.set({ [STORAGE_KEY]: config });
}

function enforceSettings(video) {
    if (!config) return;
    try {
        if (Math.abs((video.playbackRate||1) - (config.settings.speed||1)) > 0.05) {
            video.playbackRate = config.settings.speed || 1;
        }
        if (typeof config.settings.volume !== 'undefined') {
            try { applyVolumePercent(video, config.settings.volume); } catch(e){}
        }
        video.muted = !!config.settings.muted;
        if (typeof config.settings.brightness !== 'undefined') {
            try { applyBrightness(video, config.settings.brightness); } catch(e){}
        }
    } catch (e) { console.warn('enforceSettings failed', e); }
}

// --- Observe DOM for dynamic videos ---
function monitorVideos() {
    const markAndAttach = (v) => {
        try {
            if (v.dataset.vcAttached) return;
            v.dataset.vcAttached = '1';
            // apply current settings
            if (config.settings?.speed) v.playbackRate = config.settings.speed;
            if (typeof config.settings?.volume !== 'undefined') applyVolumePercent(v, config.settings.volume);
            v.muted = !!config.settings.muted;
            if (typeof config.settings?.brightness !== 'undefined') applyBrightness(v, config.settings.brightness);

            // keep enforcement on play in case site overwrites
            v.addEventListener('play', () => enforceSettings(v));

            // cleanup on element removal: when video removed from DOM, release audio nodes reference
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of m.removedNodes) {
                        if (node === v || (node.contains && node.contains(v))) {
                            // video removed; let GC handle AudioContext but null references
                            const st = vcState.get(v);
                            if (st && st.gainNode) {
                                try { st.gainNode.disconnect(); } catch(e){}
                            }
                            vcState.delete(v);
                            observer.disconnect();
                        }
                    }
                }
            });
            observer.observe(document.documentElement || document.body, { childList: true, subtree: true });

        } catch (e) { /* ignore */ }
    };

    // initial attach
    const videos = Array.from(document.getElementsByTagName('video'));
    videos.forEach(markAndAttach);

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName && node.tagName.toLowerCase() === 'video') markAndAttach(node);
                const vids = node.querySelectorAll && node.querySelectorAll('video');
                if (vids && vids.length) vids.forEach(markAndAttach);
            }
        }
    });

    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

// optional: expose a simple message API
window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === 'VC_GET_STATE') {
        window.postMessage({ type: 'VC_STATE', state: config }, '*');
    }
});
