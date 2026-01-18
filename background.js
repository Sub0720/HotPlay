// background.js - MV3 service worker for simple state storage and broadcasting
const DEFAULT_STATE = {
  shortcuts: {},
  settings: {}
};

async function getState() {
  const data = await chrome.storage.local.get(['state']);
  return data.state || DEFAULT_STATE;
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(['state']);
  if (!data.state) await chrome.storage.local.set({ state: DEFAULT_STATE });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return sendResponse({ ok: false });
    if (msg.type === 'getState') {
      sendResponse(await getState());
    } else if (msg.type === 'setState') {
      await chrome.storage.local.set({ state: msg.state });
      await broadcastState(msg.state);
      sendResponse({ ok: true });
    } else if (msg.type === 'patchState') {
      const st = await getState();
      const newState = Object.assign({}, st, msg.patch);
      await chrome.storage.local.set({ state: newState });
      await broadcastState(newState);
      sendResponse({ ok: true });
    } else sendResponse({ ok: false });
  })();
  return true;
});

async function broadcastState(state) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try { chrome.tabs.sendMessage(tab.id, { type: 'stateUpdate', state }); } catch (e) {}
    }
  } catch (e) { console.warn('broadcast failed', e); }
}
