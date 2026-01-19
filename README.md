# 🚀 HotPlay

HotPlay is a lightweight Chrome extension that lets you control YouTube or any website with < video > using keyboard shortcuts **while hovering** — no clicking required. Designed for speed, focus, and clean UX.

---

## ✨ Key Features

- 🎯 Control playback with **hover + keyboard**
- 📺 Works on **Videos, Shorts, Mini-player, Theatre & Fullscreen**
- 🖥️ Visual overlay showing active shortcuts & live feedback
- 🔊 Smart volume icons: **🔊 → 🔉 → 🔈 → 🔇**
- ⚡ Playback speed control in **±0.25x** steps
- 🧷 Temporary markers, undo last action & focus-lock mode
- ⛔ Spacebar blocked by default to prevent scrolling (optional)

---

## ⌨️ Default Keyboard Shortcuts

> These are the default mappings after installing HotPlay.
> You can change the shortcuts in content.js. The popup doesn’t save shortcut changes, and I’m not fixing it because I’m lazy.

### Playback
- **K** — Play / Pause (hover-based)  
- **Space** — Disabled by default (made to act like `K`)  
- **M** — Mute / Unmute (🔇 / 🔊)

### Volume
- **Arrow Up** — Volume up (upto 200%)  
- **Arrow Down** — Volume down

### Seeking
- **← Left Arrow** — Seek backward (configurable)  
- **→ Right Arrow** — Seek forward (configurable)

### Speed
- **Shift + .** — Increase speed by **0.25x** (max **4x**)  
- **Shift + ,** — Decrease speed by **0.25x**

### Power Features
- **B** — Temporary marker (press again to jump back - Works like a Bookmark)  
- **Z** — Undo last action (seek / speed / play-pause)  
- **X** — Focus Lock (locks controls to a specific area)

> When volume exceeds **100%** (if enabled), HotPlay visually marks boosted volume and supports up to **200%**.

---

## 🧠 How It Works

HotPlay listens for keyboard input only when your mouse is hovering over YouTube elements or any website with < video > (thumbnails, video player, Shorts). This enables instant control without clicks while avoiding page-level conflicts. The Spacebar is blocked by default to prevent unwanted scrolling.

This extension is especially useful for Students and also useful when you can’t control a video, such as when hovering over YouTube thumbnails, where you can watch the video but can’t skip it. It works on any website that plays videos, including Instagram.

If the extension is not working for some reason, or if it shows an error in chrome://extensions, simply remove it and reinstall it in your browser.

---

## 📦 Installation (Dev)
1. Clone the repo.  
2. Load `chrome://extensions` → "Load unpacked" → choose the extension folder.  
3. Test on YouTube or any website which has video play (it perfectly works on every website).
