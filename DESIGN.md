# HotPlay v1.1.2 — Design & Product Specification

**Version:** 1.1.2  
**Status:** Design direction + feature roadmap  
**Audience:** Premium desktop browser extension for YouTube with smart overlays and auto-skip (SponsorBlock-style).

---

## 1. Visual Design Direction

### 1.1 Style Principles
- **Modern, minimal, premium** — not flashy; feels native to YouTube but visually superior.
- **Glassmorphism** — subtle backdrop blur (`backdrop-filter: blur(12–20px)`), translucent backgrounds (`rgba(0,0,0,0.35)`), soft borders.
- **High contrast** — readable over any video (dark overlay + white/light text; optional light variant).
- **Typography** — Clean sans-serif (Inter / SF Pro–like), strong hierarchy (icon + title + optional subtitle).

### 1.2 Color Palette
| Role        | Hex       | Usage                          |
|------------|-----------|---------------------------------|
| Primary    | `#6C5CE7` | CTAs, skip actions, brand       |
| Accent     | `#00B894` | Success, auto-skip ON, confirm  |
| Neutral dark | `#1a1a1a` | Overlay background (base)     |
| Neutral light | `#e8e8e8` | Text on dark overlays         |
| Warning    | `#fdcb6e` | Low confidence, manual skip    |
| Error      | `#e17055` | Errors, blocked actions        |

### 1.3 Overlay Behavior
- **Default:** Small unobtrusive HUD (e.g. corner badge or thin bar) when extension is active.
- **On segment detected:** Expand to show icon + label (e.g. “Sponsor detected”) + “Press Enter to skip”.
- **After action:** Auto-hide after 400–700 ms with smooth fade-out.
- **Animations:** 200–700 ms, `ease-in-out`; no jank (use `transform`/`opacity` only).

### 1.4 Layout
- Overlays positioned **top-center** of video (or bottom bar for HUD).
- Max width ~320px for expanded state; single-line for compact.
- Consistent padding (12–16px), border-radius 10–12px.

---

## 2. Custom Emoji / Icon System

### 2.1 Style
- **Vector (SVG)** only.
- **Stroke:** Rounded, ~2.5px; consistent geometry and spacing.
- **Fill:** Soft gradients (very subtle) or flat with primary/accent.
- **Scales:** 32px, 64px, 128px (same asset, scaled via CSS/size attr).

### 2.2 Required Icons
| Name              | Purpose                    | Suggested symbol        |
|-------------------|----------------------------|-------------------------|
| Skip Sponsor      | Sponsor segment            | Fast-forward + “$”      |
| Skip Intro        | Intro segment              | Play + “1” or clock     |
| Skip Outro        | Outro segment              | Play + “END”            |
| Auto-Skip ON/OFF  | Toggle auto-skip           | Toggle + check/cross    |
| AI Detected       | AI-classified segment      | Sparkle / brain         |
| Press Enter       | Hint for user              | Enter key outline       |
| Success / Confirm | Action applied             | Checkmark               |
| Settings          | Open settings              | Gear                    |
| Warning / Low Conf | Needs user confirmation   | Exclamation in triangle |

### 2.3 Variants
- **Full color** — primary/accent for light/dark.
- **Monochrome** — single color (e.g. white on dark overlay).
- **Optional** — Lottie-style micro-animations (e.g. “Skip” pulse) for key actions.

Icons are provided as inline SVG or `<img src="icons/...">` in `icons/` with naming: `skip-sponsor.svg`, `skip-intro.svg`, etc.

---

## 3. Overlay UI Examples

### 3.1 Sponsor detected (medium confidence)
```
[Skip Sponsor icon]  Sponsor detected
                     Press Enter to skip
                     [=========>    ] 4s
```
- Background: glassmorphism (dark, blur).
- If confidence ≥ 0.85: show “Skipping in 2s…” and auto-skip; else wait for Enter.

### 3.2 Intro / Outro
```
[Skip Intro icon]  Intro
                   Press Enter to skip
```
- Same layout; “Skip Outro” for outro.

### 3.3 Success
```
[Success icon]  Skipped 12s
```
- Short display (400–600 ms), then hide.

### 3.4 Low confidence (warning)
```
[Warning icon]  Possible sponsor (low confidence)
               Press Enter to skip
```
- Use warning color; never auto-skip below 0.85.

---

## 4. AI Auto-Skip System (Core Feature)

### 4.1 Logic
1. **Crowd-sourced first** — Use SponsorBlock (or similar) API when available for the video.
2. **If no data:**  
   - Analyze video: audio + transcript (e.g. YouTube captions).  
   - Detect: sponsors, promotions, intros/outros, affiliate plugs.  
   - Use **LLM-based classification** (e.g. Cerebras API) for segment labels.
3. **Output format:**
```json
{
  "label": "sponsor | intro | outro | normal",
  "start": 123.4,
  "end": 156.7,
  "confidence": 0.92
}
```
4. **Auto-skip:** Only when `confidence ≥ 0.85`; otherwise show overlay and wait for Enter.
5. **UX:** Never interrupt unnecessarily; minimize false positives; always allow undo / manual override; **AI features opt-in** (privacy).

### 4.2 Technical Approach
- **Content script** maintains current time and segment list.
- **Background** or optional **offscreen** page: calls Cerebras (or chosen LLM) with transcript chunks; returns segments.
- **Storage:** Cache segment data per `videoId` (local); optional submit to community DB (opt-in).
- **Threshold:** Configurable in settings (default 0.85).

---

## 5. Feature Roadmap

### v1.1.1 (Current)
- **;** — Decrease video quality (YouTube: next lower level; no-op at lowest).
- **'** — Increase video quality (YouTube: next higher level; no-op at highest).
- Shift+**;** — Increase video quality (YouTube).
- Shift+**'** — Decrease video quality (YouTube).
- **-** / **=** — Decrease / increase **custom brightness** (video element only, CSS filter).
- **Shift+R** — Reset all (speed, volume, brightness); **Z** undoes reset.
- **Shift + ← / →** — Jump to **previous / next chapter** (YouTube chapters).
- **F1** — **Help center**: show all extension shortcuts and uses.
- **/** — **Frame-by-frame** playback (one frame at a time).
- Extension shortcuts **override** site shortcuts when conflicting (capture phase + preventDefault for our keys).

### v2.0 (Next)
- SponsorBlock integration (crowd-sourced segments).
- Overlay redesign: glassmorphism, new icon set, expand/collapse.
- Auto-skip with confidence threshold.

### v2.1+
- AI-powered detection (Cerebras + transcript).
- Per-channel skip rules.
- User-adjustable skip aggressiveness.
- Local-only AI mode (optional).
- Local analytics dashboard.
- Submit segments to community DB (opt-in).
- Theme & emoji pack selection.

---

## 6. User Experience Rules

- **Never interrupt content unnecessarily** — only show overlay when a skippable segment is active or action is needed.
- **False positives must be rare** — use confidence threshold and manual override.
- **Always allow undo** — Z undoes last action (including reset).
- **Respect privacy** — AI and community submit features opt-in.

---

## 7. Shortcut Override Behavior

When a key (or combo) is bound to HotPlay and the **site** also uses it (e.g. YouTube `/` for search):
- HotPlay registers listeners with **capture: true** and, for its keys, calls `preventDefault()` and `stopPropagation()` so the **extension’s shortcut wins** and the website’s does not run.
- Keys considered “ours”: all configured shortcuts plus B, Z, X, 0–9, Space, **F1**, **/**, **R**, **-** , **=**, **;**, **'**, **Shift+R**, **Shift+;**, **Shift+'**, **Shift+ArrowLeft**, **Shift+ArrowRight**.

---

## 8. Extension Icon

- **Source:** `icons/svg/icon-hotplay.svg` — play triangle in rounded square, primary `#6C5CE7`, background `#25252a`. Export to 16×16, 32×32, 48×48, 128×128 PNG and replace `icons/icon16.png` … `icon128.png` for a consistent modern look.

## 9. File & Asset Map

- `scripts/overlay.css` — Glassmorphism overlay styles, animation classes, dynamic glow.
- `scripts/content.js` — All shortcuts, overlay logic, YouTube quality (Auto baseline), brightness (glow), fullscreen, PiP, session stats, help.
- `icons/` — PNG toolbar icons; `icons/svg/` — SVG set + icon-hotplay.svg.
- `popup/` — Redesigned popup: session stats, shortcut list, remap, import/export, onboarding, Buy Me a Coffee.
- `DESIGN.md` — This document.
