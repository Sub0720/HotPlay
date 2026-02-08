// HotPlay popup — save/load full config, session stats, import/export, onboarding
const STORAGE_KEY = 'vcConfig';
const ONBOARDING_KEY = 'hotplay_onboarding_done';

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
    settings: { volume: 40, speed: 1.0, muted: false, brightness: 100 },
    lastAutoResolution: null,
    sessionStats: { watchedSeconds: 0, speedSamples: [], qualityChanges: 0, lastSpeed: 1, lastQualityTime: 0 }
};

const SHORTCUT_LABELS = {
    volUp: 'Volume Up',
    volDown: 'Volume Down',
    playPause: 'Play / Pause',
    speedUp: 'Speed Up',
    speedDown: 'Speed Down',
    mute: 'Mute',
    seekBack: 'Seek −10 s',
    seekFwd: 'Seek +10 s',
    seekBack5: 'Seek −5 s',
    seekFwd5: 'Seek +5 s',
    fullscreen: 'Fullscreen',
    pip: 'Picture-in-Picture'
};

let config = null;

function formatKey(k) {
    if (!k) return '';
    const key = String(k);
    if (key === 'ArrowUp') return '↑';
    if (key === 'ArrowDown') return '↓';
    if (key === 'ArrowLeft') return '←';
    if (key === 'ArrowRight') return '→';
    return key.length === 1 ? key.toUpperCase() : key;
}

async function loadConfig() {
    const data = await chrome.storage.local.get([STORAGE_KEY, ONBOARDING_KEY]);
    const saved = data[STORAGE_KEY] || {};
    config = {
        shortcuts: { ...DEFAULT_CONFIG.shortcuts, ...saved.shortcuts },
        settings: { ...DEFAULT_CONFIG.settings, ...saved.settings },
        lastAutoResolution: saved.lastAutoResolution ?? null,
        sessionStats: { ...DEFAULT_CONFIG.sessionStats, ...saved.sessionStats }
    };
    return config;
}

function renderShortcutsList() {
    const list = document.getElementById('shortcuts-list');
    list.innerHTML = '';
    const bindings = config.shortcuts || {};
    const entries = [
        { key: 'F1', desc: 'Show help' },
        { key: formatKey(bindings.playPause), desc: 'Play / Pause' },
        { key: formatKey(bindings.volUp), desc: 'Volume up' },
        { key: formatKey(bindings.volDown), desc: 'Volume down' },
        { key: formatKey(bindings.seekBack), desc: 'Seek −10 s' },
        { key: formatKey(bindings.seekFwd), desc: 'Seek +10 s' },
        { key: formatKey(bindings.seekBack5), desc: 'Seek −5 s' },
        { key: formatKey(bindings.seekFwd5), desc: 'Seek +5 s' },
        { key: formatKey(bindings.speedUp), desc: 'Speed up' },
        { key: formatKey(bindings.speedDown), desc: 'Speed down' },
        { key: formatKey(bindings.mute), desc: 'Mute' },
        { key: formatKey(bindings.fullscreen), desc: 'Fullscreen' },
        { key: formatKey(bindings.pip), desc: 'Picture-in-Picture' },
        { key: 'B', desc: 'Marker' },
        { key: 'Z', desc: 'Undo' },
        { key: 'X', desc: 'Focus lock' },
        { key: '− =', desc: 'Brightness' },
        { key: "; '", desc: 'Quality' },
        { key: 'Shift + R', desc: 'Reset' },
        { key: '/', desc: 'Frame step' }
    ];
    entries.forEach(({ key, desc }) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span class="desc">${desc}</span><kbd>${key}</kbd>`;
        list.appendChild(row);
    });
}

function renderShortcutsEdit() {
    const container = document.getElementById('shortcuts-edit');
    container.innerHTML = '';
    const bindings = config.shortcuts || {};
    for (const [action, label] of Object.entries(SHORTCUT_LABELS)) {
        const row = document.createElement('div');
        row.className = 'setting-row';
        const val = bindings[action] ?? '';
        row.innerHTML = `<label>${label}</label><input type="text" data-action="${action}" value="${val}" maxlength="20" placeholder="key">`;
        container.appendChild(row);
    }
}

function renderStats() {
    const stats = config.sessionStats || {};
    const watched = Math.floor((stats.watchedSeconds || 0) / 60);
    const minutes = watched % 60;
    const hours = Math.floor(watched / 60);
    const watchedStr = hours > 0 ? `${hours}h ${minutes}m` : `${watched}m`;
    document.getElementById('stat-watched').textContent = watchedStr;
    const samples = stats.speedSamples || [];
    const avgSpeed = samples.length ? (samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2) : (stats.lastSpeed || 1);
    document.getElementById('stat-speed').textContent = avgSpeed + '×';
    document.getElementById('stat-quality').textContent = String(stats.qualityChanges || 0);
}

async function saveConfig() {
    const inputs = document.querySelectorAll('#shortcuts-edit input[data-action]');
    const shortcuts = { ...config.shortcuts };
    inputs.forEach(inp => {
        const action = inp.getAttribute('data-action');
        const val = (inp.value || '').trim();
        if (action && val) shortcuts[action] = val;
    });
    config.shortcuts = shortcuts;
    await chrome.storage.local.set({
        [STORAGE_KEY]: {
            shortcuts: config.shortcuts,
            settings: config.settings,
            lastAutoResolution: config.lastAutoResolution,
            sessionStats: config.sessionStats
        }
    });
    chrome.runtime.sendMessage({ type: 'broadcastConfig' }).catch(() => {});
    const btn = document.getElementById('save');
    const orig = btn.textContent;
    btn.textContent = 'Saved!';
    btn.style.background = '#00a86b';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 1200);
}

function resetSessionStats() {
    config.sessionStats = {
        watchedSeconds: 0,
        speedSamples: [],
        qualityChanges: 0,
        lastSpeed: 1,
        lastQualityTime: 0
    };
    chrome.storage.local.set({ [STORAGE_KEY]: config });
    renderStats();
}

function exportSettings() {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hotplay-settings.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

function importSettings(file) {
    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const imported = JSON.parse(reader.result);
            config.shortcuts = { ...config.shortcuts, ...imported.shortcuts };
            config.settings = { ...config.settings, ...imported.settings };
            if (imported.sessionStats) config.sessionStats = { ...config.sessionStats, ...imported.sessionStats };
            if (imported.lastAutoResolution != null) config.lastAutoResolution = imported.lastAutoResolution;
            await chrome.storage.local.set({ [STORAGE_KEY]: config });
            renderShortcutsList();
            renderShortcutsEdit();
            renderStats();
        } catch (e) {
            alert('Invalid file');
        }
    };
    reader.readAsText(file);
}

async function showOnboardingIfNeeded() {
    const data = await chrome.storage.local.get([ONBOARDING_KEY]);
    if (data[ONBOARDING_KEY]) return;
    document.getElementById('onboarding').hidden = false;
}

function hideOnboarding() {
    document.getElementById('onboarding').hidden = true;
    chrome.storage.local.set({ [ONBOARDING_KEY]: true });
}

// Optional: set your Buy Me a Coffee URL (default is generic)
document.getElementById('coffee-link').href = 'https://buymeacoffee.com/skaax007';

document.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    renderShortcutsList();
    renderShortcutsEdit();
    renderStats();

    document.getElementById('save').addEventListener('click', saveConfig);
    document.getElementById('reset-stats').addEventListener('click', resetSessionStats);
    document.getElementById('export-btn').addEventListener('click', exportSettings);
    document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
    document.getElementById('import-file').addEventListener('change', (e) => {
        const f = e.target.files?.[0];
        if (f) importSettings(f);
        e.target.value = '';
    });
    document.getElementById('onboarding-done').addEventListener('click', hideOnboarding);
    document.getElementById('reset-onboarding').addEventListener('click', async () => {
        await chrome.storage.local.remove(ONBOARDING_KEY);
        document.getElementById('onboarding').hidden = false;
    });

    showOnboardingIfNeeded();
});
