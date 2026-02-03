// scripts/content.js - generalized for all sites with video elements
// FINAL: adds site lock (X), volume boost up to 200%, B marker, Z undo, and top-center overlays

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
        muted: false
    }
};

let config = null;
let activeOverlay = null;

// ---------------- Feature additions: Lock, Volume Boost, Marker (B), Undo (Z) ----------------
const vcState = new WeakMap(); // per-video state: { audioCtx, sourceNode, gainNode, history:[], marker: null }
let siteLocked = false;
let lockedVideoRef = null; // DOM element reference when siteLocked

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
    } else {
        showOverlay('play', video, 'Undone');
    }
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

    // periodic enforcement to counter site resets
    setInterval(() => {
        const v = pickTargetVideo();
        if (v) enforceSettings(v);
    }, 1500);

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
            pin: '📌'
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

// --- Keyboard handling ---
function setupGlobalKeyHandler() {
    const handler = (e) => {
        if (!config) return;

        const key = e.key;
        // 1. Context Check: Don't block typing in inputs (unless user is focused on a text field)
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        if (['input','textarea','select'].includes(activeTag) || document.activeElement?.isContentEditable) return;

        const bindings = config.shortcuts;
        const video = pickTargetVideo();
        if (!video) return;

        const isNumber = !isNaN(parseInt(key)) && key.trim() !== '';
        const isSpace = isSpaceEvent(e);
        const normalizedBindings = Object.values(bindings).map(k => (k||'').toLowerCase());
        
        // 2. Identify if this is a key we care about
        const isOurKey = normalizedBindings.includes(key.toLowerCase()) || isNumber || isSpace || ['b', 'z', 'x'].includes(key.toLowerCase());

        if (isOurKey) {
            // 3. NUCLEAR OPTION: Stop the website from ever seeing this event
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // Only process logic on keydown to avoid double-triggering
            if (e.type === 'keydown') {
                handleLogic(video, key, bindings, isNumber, isSpace);
            }
        }
    };

    // Attach to both down and up, using useCapture = true
    window.addEventListener('keydown', handler, true);
    window.addEventListener('keyup', handler, true);
}

// Move your logic into a separate helper to keep the handler clean
function handleLogic(video, key, bindings, isNumber, isSpace) {
    const matchKey = (k) => (k.length === 1 ? key.toLowerCase() === k.toLowerCase() : key === k);

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
        // speed enforcement
        if (Math.abs((video.playbackRate||1) - (config.settings.speed||1)) > 0.05) {
            video.playbackRate = config.settings.speed || 1;
        }
        // volume enforcement: apply percent (may create audio nodes if boosting)
        if (typeof config.settings.volume !== 'undefined') {
            try {
                applyVolumePercent(video, config.settings.volume);
            } catch(e){}
        }
        // muted
        video.muted = !!config.settings.muted;
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
