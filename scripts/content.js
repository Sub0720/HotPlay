/**
 * scripts/content.js - HotPlay v1.1.2 (Patched)
 * * Changelog v1.1.2:
 * - Fixed startup race condition where shortcuts failed if storage wasn't ready.
 * - Fixed DOMException by lazy-loading AudioContexts only when needed.
 * - Fixed AudioContext suspension issues on browser restart.
 * - Improved video targeting (prioritizes main video).
 * - Removed global failure flag; audio errors are now handled per-video.
 */

const STORAGE_KEY = 'vcConfig';

const DEFAULT_CONFIG = {
    shortcuts: {
        volUp: 'ArrowUp',
        volDown: 'ArrowDown',
        playPause: 'k',
        speedUp: '>',
        speedDown: '<',
        mute: 'm',
        seekBack: 'j',
        seekFwd: 'l',
        seekBack5: 'ArrowLeft',
        seekFwd5: 'ArrowRight',
        fullscreen: 'f',
        pip: 'p'
    },
    settings: {
        volume: 40,
        speed: 1.0,
        muted: false,
        brightness: 100
    },
    lastAutoResolution: null,
    sessionStats: { watchedSeconds: 0, speedSamples: [], qualityChanges: 0, lastSpeed: 1, lastQualityTime: 0 }
};

// Initialize with defaults immediately so keys work while storage loads
let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
let activeOverlay = null;

// ---------------- Feature additions ----------------
const vcState = new WeakMap(); // per-video state
let siteLocked = false;
let lockedVideoRef = null;
let helpOverlayVisible = false;
const FRAME_STEP_DEFAULT = 1 / 30;

function ensureVideoState(video) {
    if (!vcState.has(video)) {
        vcState.set(video, { 
            audioCtx: null, 
            sourceNode: null, 
            gainNode: null, 
            history: [], 
            marker: null,
            audioError: false // Track audio failures per video, not globally
        });
    }
    return vcState.get(video);
}

// Volume booster: up to 200% using WebAudio GainNode
function ensureAudioNodes(video) {
    const st = ensureVideoState(video);
    
    // If we already failed for this specific video (e.g. CORS or limit), don't retry incessantly
    if (st.audioError) return st; 

    try {
        if (st.gainNode) {
            // Ensure context is running if we are interacting
            if (st.audioCtx && st.audioCtx.state === 'suspended') {
                st.audioCtx.resume().catch(() => {});
            }
            return st;
        }

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
            st.audioError = true;
            return st;
        }

        // Lazy creation: Create context only when actually requested
        if (!st.audioCtx) {
            try {
                st.audioCtx = new AudioCtx();
            } catch (e) {
                // Often hits limit of 6 contexts. Fail gracefully.
                st.audioError = true;
                return st;
            }
        }

        // Connect to video source
        if (!st.sourceNode && st.audioCtx) {
            try {
                // This throws DOMException if element already connected or CORS issue
                st.sourceNode = st.audioCtx.createMediaElementSource(video);
                st.gainNode = st.audioCtx.createGain();
                st.sourceNode.connect(st.gainNode);
                st.gainNode.connect(st.audioCtx.destination);
                st.gainNode.gain.value = 1.0;
            } catch (e) {
                console.warn('VC: Audio source attach failed (CORS or existing)', e);
                st.audioError = true; // Disable boost for this video only
                
                // Cleanup partials if failed
                try { if(st.gainNode) st.gainNode.disconnect(); } catch(z){}
                st.sourceNode = null;
                st.gainNode = null;
            }
        }
    } catch (e) {
        console.warn('VC: General audio error', e);
        st.audioError = true;
    }
    return st;
}

function applyVolumePercent(video, pct) {
    pct = Math.max(0, Math.min(200, Math.round(pct)));
    const st = ensureVideoState(video);

    // Standard HTML5 volume
    if (pct <= 100) {
        try { video.volume = pct / 100; } catch(e){}
        // Reset gain if it exists
        if (st.gainNode) {
            try { st.gainNode.gain.value = 1.0; } catch(e){}
        }
    } else {
        // Boosting needed
        try { video.volume = 1.0; } catch(e){}
        
        // Only try to create nodes if we are actually boosting
        const s = ensureAudioNodes(video);
        
        if (s.gainNode) {
            try {
                const wantedGain = pct / 100.0;
                s.gainNode.gain.value = wantedGain;
            } catch(e){
                console.warn('VC: cannot set gain', e);
            }
        } else {
            // Fallback: If boost fails (CORS/Context limit), just keep volume at 100%
            // Do not warn repeatedly
        }
    }

    // Update global setting
    config.settings.volume = pct;
    // Don't save on every frame update, but caller (key handler) usually handles logic.
    // We defer saveConfig call to the event handler to reduce I/O spam.
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
    // saveConfig handled by caller
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
        saveConfig();
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

function queryYT(selector) {
    const el = document.querySelector(selector);
    if (el) return el;
    const host = document.querySelector('#movie_player');
    if (host && host.shadowRoot) return host.shadowRoot.querySelector(selector);
    return null;
}

function openYouTubeSettingsPanel() {
    const gear = queryYT('.ytp-settings-button');
    if (gear) { gear.click(); return true; }
    return false;
}

function openYouTubeQualitySubmenu() {
    const panel = queryYT('.ytp-panel-menu') || queryYT('.ytp-settings-menu');
    if (!panel) return false;
    const items = panel.querySelectorAll('.ytp-menuitem');
    if (!items.length) return false;
    const qualityRow = Array.from(items).find(el => /quality|qualité|calidad|qualität|画质/i.test(el.textContent || '')) || items[items.length - 1];
    qualityRow.click();
    return true;
}

function parseQualityLabel(text) {
    if (!text) return { res: null, auto: false };
    const t = (text || '').trim();
    if (/auto/i.test(t)) return { res: null, auto: true };
    const m = t.match(/(\d{3,4})\s*[pP]/);
    return { res: m ? parseInt(m[1], 10) : null, auto: false };
}

const MIN_QUALITY_RES = 240;

function getYouTubeQualityItemsOrdered(menu) {
    if (!menu) return [];
    const items = menu.querySelectorAll('.ytp-menuitem[role="menuitem"], .ytp-menuitem');
    const list = [];
    for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const text = (el.textContent || '').trim();
        const { res, auto } = parseQualityLabel(text);
        list.push({ el, res, auto, index: i });
    }
    const withRes = list.filter(x => x.res != null);
    const autoItems = list.filter(x => x.auto);
    withRes.sort((a, b) => (b.res - a.res));
    return [...withRes, ...autoItems];
}

function getEffectiveResolution(video) {
    try {
        const w = video.videoWidth || 0;
        const h = video.videoHeight || 0;
        const height = Math.max(w, h);
        if (height >= 1080) return 1080;
        if (height >= 720) return 720;
        if (height >= 480) return 480;
        if (height >= 360) return 360;
        if (height >= 240) return 240;
        if (height >= 144) return 144;
        return null;
    } catch (e) { return null; }
}

function clickYouTubeQualityOption(up, video) {
    const menu = queryYT('.ytp-quality-menu') || queryYT('.ytp-panel-menu');
    if (!menu) return false;
    const ordered = getYouTubeQualityItemsOrdered(menu);
    if (!ordered.length) return false;
    const current = menu.querySelector('.ytp-menuitem[aria-checked="true"]') || menu.querySelector('.ytp-menuitem[aria-selected="true"]');
    let currentIdx = current ? ordered.findIndex(o => o.el === current) : -1;

    const isAuto = currentIdx >= 0 && ordered[currentIdx].auto;
    if (isAuto && video) {
        const effective = getEffectiveResolution(video) || config.lastAutoResolution || 720;
        if (config) config.lastAutoResolution = effective;
        currentIdx = ordered.findIndex(o => o.res === effective);
        if (currentIdx < 0) currentIdx = ordered.findIndex(o => o.res != null && o.res <= effective);
        if (currentIdx < 0) currentIdx = 0;
    }

    let targetIdx;
    if (up) {
        if (currentIdx < 0) currentIdx = 0;
        if (currentIdx >= ordered.length - 1) return false;
        targetIdx = currentIdx + 1;
        const targetRes = ordered[targetIdx].res;
        if (targetRes !== null && targetRes < MIN_QUALITY_RES) return false;
    } else {
        if (currentIdx <= 0) return false;
        targetIdx = currentIdx - 1;
        const targetRes = ordered[targetIdx].res;
        if (targetRes !== null && targetRes < MIN_QUALITY_RES) return false;
    }

    const target = ordered[targetIdx]?.el;
    if (target) target.click();
    return !!target;
}

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

function changeYouTubeQuality(up, video) {
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
                const ok = clickYouTubeQualityOption(up, video || pickTargetVideo());
                if (ok && config) {
                    config.sessionStats = config.sessionStats || { watchedSeconds: 0, speedSamples: [], qualityChanges: 0, lastSpeed: 1, lastQualityTime: 0 };
                    config.sessionStats.qualityChanges = (config.sessionStats.qualityChanges || 0) + 1;
                    config.sessionStats.lastQualityTime = Date.now();
                    saveConfig();
                }
                setTimeout(() => {
                    const back = queryYT('.ytp-settings-button');
                    if (back) back.click();
                    setTimeout(() => {
                        showYouTubePanelUI();
                        resolve(ok);
                    }, 350);
                }, 200);
            }, 400);
        }, 400);
    });
}

// ----- Generic quality -----
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
    if (m) return -parseInt(m[1], 10);
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
    options.sort((a, b) => a.order - b.order);
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
    if (target) { target.click(); return true; }
    return false;
}

function changeVideoQuality(up, video) {
    if (isYouTube()) return changeYouTubeQuality(up, video);
    return changeQualityGeneric(up);
}

// ----- YouTube: Chapters -----
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

// Lock toggle (X)
function toggleSiteLock(video) {
    try {
        const target = video || pickTargetVideo();
        if (!target) return;
        if (!siteLocked) {
            siteLocked = true;
            lockedVideoRef = target;
            const over = document.createElement('div');
            over.id = 'vc_focus_overlay';
            over.style.position = 'fixed';
            over.style.pointerEvents = 'auto';
            over.style.zIndex = '2147483646';
            over.style.background = 'transparent';
            over.style.borderRadius = '4px';
            over.setAttribute('aria-hidden','true');
            const place = () => {
                try {
                    const r = (lockedVideoRef && lockedVideoRef.getBoundingClientRect && lockedVideoRef.getBoundingClientRect()) || {left:0,top:0,width:0,height:0};
                    const left = Math.max(0, r.left);
                    const top = Math.max(0, r.top);
                    over.style.left = left + 'px';
                    over.style.top = top + 'px';
                    over.style.width = Math.max(0, r.width) + 'px';
                    over.style.height = Math.max(0, r.height) + 'px';
                } catch(e) {}
            };
            over.addEventListener('mousemove', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            over.addEventListener('mouseenter', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            over.addEventListener('mouseover', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            over.addEventListener('pointerdown', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            over.addEventListener('pointerup', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            over.addEventListener('click', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); }, true);
            document.documentElement.appendChild(over);
            place();
            const upd = () => { place(); };
            window.addEventListener('resize', upd);
            window.addEventListener('scroll', upd, true);
            try { over.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.12) inset'; } catch(e){}
            showOverlay('locked', lockedVideoRef || target, 'Focus mode');
        } else {
            siteLocked = false;
            const el = document.getElementById('vc_focus_overlay');
            if (el) { try { el.parentNode.removeChild(el); } catch(e){} }
            lockedVideoRef = null;
            showOverlay('locked', pickTargetVideo(), 'Focus off');
        }
    } catch(e) { console.warn('VC: toggleSiteLock error', e); }
}

// ---------------- Initialization ----------------

(async function init(){
    try {
        const data = await chrome.storage.local.get([STORAGE_KEY]);
        // Merge saved data into the already-initialized default config
        if (data[STORAGE_KEY]) {
            const saved = data[STORAGE_KEY];
            config.shortcuts = { ...config.shortcuts, ...(saved.shortcuts || {}) };
            config.settings = { ...config.settings, ...(saved.settings || {}) };
            config.lastAutoResolution = saved.lastAutoResolution ?? config.lastAutoResolution;
            config.sessionStats = { ...config.sessionStats, ...(saved.sessionStats || {}) };
            
            // Normalize volume
            if (config.settings.volume && config.settings.volume <= 1) {
                config.settings.volume = Math.round(config.settings.volume * 100);
            }
        }
    } catch(e) {
        console.warn('VC: Config load error (using defaults)', e);
    }

    setupGlobalKeyHandler();
    monitorVideos();

    let lastStatsSaveMin = 0;
    setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        const v = pickTargetVideo();
        if (v) {
            enforceSettings(v);
            if (config.sessionStats && !v.paused && v.readyState > 1) {
                config.sessionStats.watchedSeconds = (config.sessionStats.watchedSeconds || 0) + 3.5;
                config.sessionStats.lastSpeed = v.playbackRate;
                const arr = config.sessionStats.speedSamples || [];
                if (arr.length < 30) arr.push(v.playbackRate);
                else { arr.shift(); arr.push(v.playbackRate); }
                config.sessionStats.speedSamples = arr;
                const nowMin = Math.floor(Date.now() / 60000);
                if (nowMin !== lastStatsSaveMin) { lastStatsSaveMin = nowMin; saveConfig(); }
            }
        }
    }, 3500);

    console.log('Video Commander: initialized');
})();

function isSpaceEvent(e) {
    return e.key === ' ' || e.code === 'Space' || e.key === 'Spacebar';
}

function pickTargetVideo() {
    try {
        if (siteLocked && lockedVideoRef && document.contains(lockedVideoRef)) return lockedVideoRef;

        // 0. Explicit YouTube Main Video (avoid ad/preview videos)
        const ytMain = document.querySelector('.html5-main-video');
        if (ytMain && isElementVisible(ytMain)) return ytMain;

        // 1. Hovered video
        const hovered = document.querySelectorAll('video:hover');
        if (hovered.length) return hovered[0];

        // 2. Playing video
        const playing = Array.from(document.getElementsByTagName('video')).find(v => !v.paused && v.readyState > 1 && isElementVisible(v));
        if (playing) return playing;

        // 3. Visible video (largest)
        const vids = Array.from(document.getElementsByTagName('video')).filter(isElementVisible);
        if (vids.length) {
            // Return largest visible video area
            return vids.reduce((prev, curr) => {
                const pr = prev.getBoundingClientRect();
                const cr = curr.getBoundingClientRect();
                return (pr.width * pr.height) > (cr.width * cr.height) ? prev : curr;
            });
        }
        
        // 4. Fallback
        return document.getElementsByTagName('video')[0] || null;
    } catch(e) { return null; }
}

function isElementVisible(el) {
    try {
        const rect = el.getBoundingClientRect();
        return rect.width > 10 && rect.height > 10 && 
               rect.bottom >= 0 && rect.top <= (window.innerHeight || document.documentElement.clientHeight);
    } catch (e) { return false; }
}

// --- Overlay UI ---
function showOverlay(kind, video, value) {
    try {
        if (!video) return;
        if (activeOverlay) { activeOverlay.remove(); activeOverlay = null; }

        const iconMap = {
            vol: '🔊', mute: '🔇', seek: '►►', seekBack: '◄◄', speed: '⚡',
            play: '▶', pause: '❚❚', percent: '🔢', locked: '🔒', unlocked: '🔓',
            pin: '📌', brightness: '☀', quality: '📐'
        };

        const overlay = document.createElement('div');
        overlay.className = 'vc-overlay ' + (kind || 'play');

        const icon = document.createElement('div');
        icon.className = 'vc-icon';
        icon.textContent = iconMap[kind] || '🎬';

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

        // Dynamic Glow
        overlay.classList.add('dynamic-glow');
        try {
            const blendColor = (c1, c2, t) => [
                Math.round(c1[0] + (c2[0]-c1[0]) * t),
                Math.round(c1[1] + (c2[1]-c1[1]) * t),
                Math.round(c1[2] + (c2[2]-c1[2]) * t)
            ];
            let colorRGB = null, darkness = 0;
            if (kind === 'vol' && value) {
                const v = Number(value) || 0;
                if (v > 100) {
                    darkness = Math.min(1, (v - 100) / 100);
                    if (v <= 150) colorRGB = [0,160,0];
                    else colorRGB = blendColor([0,160,0],[160,0,0], Math.min(1, (v - 150) / 50));
                }
            } else if (kind === 'speed' && value) {
                const sp = Number(value) || 0;
                if (sp > 2) {
                    darkness = Math.min(1, (sp - 2) / 2);
                    if (sp <= 3) colorRGB = [0,160,0];
                    else colorRGB = blendColor([0,160,0],[160,0,0], Math.min(1, (sp - 3) / 1));
                }
            } else if (kind === 'brightness' && value != null) {
                const b = Number(value) || 100;
                if (b > 150) {
                    darkness = Math.min(1, (b - 150) / 50);
                    colorRGB = [200, 60, 60];
                } else if (b < 50) {
                    darkness = Math.min(1, (50 - b) / 50);
                    colorRGB = [60, 180, 80];
                }
            }
            if (colorRGB) {
                const boxAlpha = 0.08 + (0.6 * Math.min(1, darkness));
                const borderAlpha = 0.08 + (0.55 * Math.min(1, darkness));
                overlay.style.boxShadow = `0 10px 40px rgba(${colorRGB[0]},${colorRGB[1]},${colorRGB[2]},${boxAlpha})`;
                overlay.style.border = `1px solid rgba(${colorRGB[0]},${colorRGB[1]},${colorRGB[2]},${borderAlpha})`;
            } else {
                overlay.style.boxShadow = ''; overlay.style.border = '';
            }
        } catch(e) { }

        if (kind === 'vol' && value && value > 100) overlay.classList.add('boost');
        else overlay.classList.remove('boost');

        const rect = video.getBoundingClientRect();
        const marginTop = 12;
        const ovRect = overlay.getBoundingClientRect();
        let left = rect.left + Math.max(0, (rect.width - ovRect.width) / 2);
        let top = rect.top + marginTop;
        const maxLeft = Math.max(8, (window.innerWidth || document.documentElement.clientWidth) - ovRect.width - 8);
        left = Math.min(Math.max(8, left), maxLeft);
        if (top < 8) top = rect.top + 8;
        overlay.style.left = left + 'px';
        overlay.style.top = top + 'px';

        requestAnimationFrame(() => { overlay.classList.add('vc-show'); });
        const timeout = (kind === 'percent' || kind === 'seek' || kind === 'seekBack') ? 1100 : 800;
        setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); if (activeOverlay === overlay) activeOverlay = null; }, timeout);
    } catch (e) {}
}

// ----- Help Center (F1) -----
function getHelpShortcutsList() {
    const bindings = config?.shortcuts || DEFAULT_CONFIG.shortcuts;
    const k = (name) => (bindings[name] || name.toUpperCase());
    return [
        { key: 'F1', desc: 'Show this help' },
        { key: k('playPause'), desc: 'Play / Pause' },
        { key: 'Space', desc: 'Play / Pause' },
        { key: k('mute'), desc: 'Mute / Unmute' },
        { key: k('volUp'), desc: 'Volume up' },
        { key: k('volDown'), desc: 'Volume down' },
        { key: k('seekBack'), desc: 'Seek −10 s' },
        { key: k('seekFwd'), desc: 'Seek +10 s' },
        { key: k('seekBack5'), desc: 'Seek −5 s' },
        { key: k('seekFwd5'), desc: 'Seek +5 s' },
        { key: k('speedUp'), desc: 'Speed up' },
        { key: k('speedDown'), desc: 'Speed down' },
        { key: '0–9', desc: 'Jump to 0%–90%' },
        { key: 'B', desc: 'Set marker / jump to marker' },
        { key: 'Z', desc: 'Undo last action' },
        { key: 'X', desc: 'Focus lock on video' },
        { key: 'Shift + R', desc: 'Reset speed, volume, brightness' },
        { key: 'Shift + Z', desc: 'Undo reset' },
        { key: '−', desc: 'Decrease brightness' },
        { key: '=', desc: 'Increase brightness' },
        { key: ";", desc: 'Decrease video quality' },
        { key: "'", desc: 'Increase video quality' },
        { key: 'Shift + ;', desc: 'Increase quality' },
        { key: "Shift + '", desc: 'Decrease quality' },
        { key: k('fullscreen'), desc: 'Toggle fullscreen' },
        { key: k('pip'), desc: 'Toggle Picture-in-Picture' },
        { key: 'Shift + ←', desc: 'Previous chapter' },
        { key: 'Shift + →', desc: 'Next chapter' },
        { key: '/', desc: 'Frame-by-frame' }
    ];
}

function showHelpOverlay() {
    if (helpOverlayVisible) { hideHelpOverlay(); return; }
    const wrap = document.getElementById('vc-help-overlay');
    if (wrap) { wrap.classList.add('vc-show'); helpOverlayVisible = true; return; }
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
            hideHelpOverlay(); e.preventDefault(); e.stopPropagation();
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
        // Safe check: config must exist, but we init it synchronously now
        if (!config) return;

        const key = e.key;
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        if (['input','textarea','select'].includes(activeTag) || document.activeElement?.isContentEditable) return;

        if (key === 'F1') {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
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
        
        const isOurKey = normalizedBindings.includes(key.toLowerCase()) || isNumber || isSpace || ['b', 'z', 'x'].includes(key.toLowerCase()) || (isHotPlayOnly && key !== 'F1');

        if (isOurKey) {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            if (e.type === 'keydown') {
                try {
                    handleLogic(video, key, bindings, isNumber, isSpace, e);
                } catch(err) {
                    console.warn('VC: Key handler crash recovered', err);
                }
            }
        }
    };
    window.addEventListener('keydown', handler, true);
    window.addEventListener('keyup', handler, true);
}

function handleLogic(video, key, bindings, isNumber, isSpace, e) {
    const matchKey = (k) => (k.length === 1 ? key.toLowerCase() === k.toLowerCase() : key === k);
    const shift = e && e.shiftKey;

    if (key === 'F1') { showHelpOverlay(); return; }
    
    // --- Play/Pause (Space / k) ---
    // Moved up for responsiveness
    if (matchKey(bindings.playPause) || isSpace) {
        if (video.paused) {
            pushHistory(video, {type:'play', prevPaused: true});
            // Auto-resume audio context if needed
            const st = vcState.get(video);
            if(st && st.audioCtx && st.audioCtx.state === 'suspended') { st.audioCtx.resume().catch(()=>{}); }
            
            video.play().then(() => showOverlay('play', video, null)).catch(() => {});
        } else {
            pushHistory(video, {type:'play', prevPaused: false});
            video.pause();
            showOverlay('pause', video, null);
        }
        return;
    }

    if (key === '/') {
        const wasPaused = video.paused;
        video.pause();
        const step = FRAME_STEP_DEFAULT;
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + step);
        showOverlay('play', video, 'Frame');
        if (!wasPaused) setTimeout(() => { video.play().catch(() => {}); }, 120);
        return;
    }
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
    if (key === ';' && !shift) {
        showOverlay('quality', video, 'Quality…');
        changeVideoQuality(true, video).then((ok) => {
            const v = pickTargetVideo();
            if (ok) showOverlay('quality', v, 'Quality ↓');
            else showOverlay('quality', v, isYouTube() ? 'Already at lowest' : 'Quality: not available');
        });
        return;
    }
    if (key === "'" && !shift) {
        showOverlay('quality', video, 'Quality…');
        changeVideoQuality(false, video).then((ok) => {
            const v = pickTargetVideo();
            if (ok) showOverlay('quality', v, 'Quality ↑');
            else showOverlay('quality', v, isYouTube() ? 'Already at highest' : 'Quality: not available');
        });
        return;
    }
    if (shift && key === ';') {
        showOverlay('quality', video, 'Quality…');
        changeVideoQuality(false, video).then((ok) => {
            const v = pickTargetVideo();
            if (ok) showOverlay('quality', v, 'Quality ↑');
            else showOverlay('quality', v, 'Quality: not available');
        });
        return;
    }
    if (shift && key === "'") {
        showOverlay('quality', video, 'Quality…');
        changeVideoQuality(true, video).then((ok) => {
            const v = pickTargetVideo();
            if (ok) showOverlay('quality', v, 'Quality ↓');
            else showOverlay('quality', v, 'Quality: not available');
        });
        return;
    }
    if (shift && key === 'ArrowLeft') {
        if (!goToPrevChapter(video)) showOverlay('seekBack', video, 'No prev chapter');
        return;
    }
    if (shift && key === 'ArrowRight') {
        if (!goToNextChapter(video)) showOverlay('seek', video, 'No next chapter');
        return;
    }
    if (key.toLowerCase() === 'b') { toggleMarker(video); return; }
    if (key.toLowerCase() === 'z') { undoLast(video); return; }
    if (key.toLowerCase() === 'x') { toggleSiteLock(video); return; }
    if (matchKey(bindings.fullscreen)) {
        try {
            const doc = document;
            if (doc.fullscreenElement) {
                doc.exitFullscreen().then(() => showOverlay('play', video, 'Fullscreen off')).catch(() => {});
            } else {
                const target = video.closest?.('.html5-video-player') || video.parentElement || video;
                (target.requestFullscreen || target.webkitRequestFullscreen)?.call(target);
                showOverlay('play', video, 'Fullscreen');
            }
        } catch (e) { showOverlay('play', video, 'Fullscreen unavailable'); }
        return;
    }
    if (matchKey(bindings.pip)) {
        try {
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().then(() => showOverlay('play', video, 'PiP off')).catch(() => {});
            } else if (document.pictureInPictureEnabled && video.readyState >= 2) {
                video.requestPictureInPicture().then(() => showOverlay('play', video, 'PiP on')).catch(() => showOverlay('play', video, 'PiP unavailable'));
            } else {
                showOverlay('play', video, 'PiP unavailable');
            }
        } catch (e) { showOverlay('play', video, 'PiP unavailable'); }
        return;
    }
    if (isNumber) {
        const n = parseInt(key);
        const pct = n * 10;
        if (video.duration) {
            const targetTime = video.duration * (pct / 100);
            pushHistory(video, { type: 'seek', prev: video.currentTime, next: targetTime });
            video.currentTime = targetTime;
            showOverlay('num', video, `${pct}%`);
            saveConfig();
        }
        return;
    }
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
    }
}

// --- Persistence ---
function saveConfig() {
    if (config) chrome.storage.local.set({ [STORAGE_KEY]: config });
}

function enforceSettings(video) {
    if (!config) return;
    try {
        if (Math.abs((video.playbackRate||1) - (config.settings.speed||1)) > 0.05) {
            video.playbackRate = config.settings.speed || 1;
        }
        
        // Optimize: check before applying expensive audio op
        const currentVol = getVolumePercent(video);
        const targetVol = config.settings.volume;
        // Only apply if mismatch or if we need to ensure boost logic is active for >100
        if (typeof targetVol !== 'undefined' && (currentVol !== targetVol || targetVol > 100)) {
            // Apply, but don't force creation of audio context if we are just maintaining standard volume
            // We only force create if user explicitly interacts, which calls applyVolumePercent directly.
            // Here in "enforce", we only fix standard props unless we already have audio nodes.
            const st = vcState.get(video);
            if (targetVol <= 100 || (st && st.gainNode)) {
                 applyVolumePercent(video, targetVol);
            }
        }

        video.muted = !!config.settings.muted;
        if (typeof config.settings.brightness !== 'undefined') {
            try { applyBrightness(video, config.settings.brightness); } catch(e){}
        }
    } catch (e) { }
}

// --- Observe DOM for dynamic videos ---
function monitorVideos() {
    const markAndAttach = (v) => {
        try {
            if (v.dataset.vcAttached) return;
            v.dataset.vcAttached = '1';
            
            // Apply simple settings immediately (speed, mute)
            if (config.settings?.speed) v.playbackRate = config.settings.speed;
            v.muted = !!config.settings.muted;
            if (typeof config.settings?.brightness !== 'undefined') applyBrightness(v, config.settings.brightness);

            // Volume: If <= 100, just set it. If > 100, we DO NOT auto-create AudioContext to avoid startup lag/crash.
            // We wait for user interaction to boost.
            if (config.settings.volume <= 100) {
                 v.volume = config.settings.volume / 100;
            }

            v.addEventListener('play', () => enforceSettings(v));

            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of m.removedNodes) {
                        if (node === v || (node.contains && node.contains(v))) {
                            const st = vcState.get(v);
                            if (st) {
                                if (st.gainNode) try { st.gainNode.disconnect(); } catch(e){}
                                if (st.audioCtx && st.audioCtx.state !== 'closed') try { st.audioCtx.close(); } catch(e){}
                            }
                            vcState.delete(v);
                            observer.disconnect();
                        }
                    }
                }
            });
            observer.observe(document.documentElement || document.body, { childList: true, subtree: true });

        } catch (e) { }
    };

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'configUpdated') {
        chrome.storage.local.get([STORAGE_KEY]).then((data) => {
            if (data[STORAGE_KEY]) {
                const saved = data[STORAGE_KEY];
                config.shortcuts = { ...DEFAULT_CONFIG.shortcuts, ...(saved.shortcuts || {}) };
                config.settings = { ...DEFAULT_CONFIG.settings, ...(saved.settings || {}) };
                config.lastAutoResolution = saved.lastAutoResolution ?? config.lastAutoResolution;
                config.sessionStats = { ...DEFAULT_CONFIG.sessionStats, ...(saved.sessionStats || {}) };
            }
            sendResponse({ ok: true });
        });
        return true;
    }
});

window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === 'VC_GET_STATE') {
        window.postMessage({ type: 'VC_STATE', state: config }, '*');
    }
});
