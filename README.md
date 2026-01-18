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

> These are the default mappings after installing HotPlay.You can change by going through the content.js and yeah the popup doesn't saves nor works and i am not gonna fix it because im lazy. 

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

---

## 📦 Installation (Dev)
1. Clone the repo.  
2. Load `chrome://extensions` → "Load unpacked" → choose the extension folder.  
3. Test on YouTube or any website with <video>.
