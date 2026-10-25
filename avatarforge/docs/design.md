# AvatarForge: design notes

Source idea: `AvatarForge_Abstract_1.docx`. Context: NVIDIA hackathon, 5 days, 6 people.

## Pitch

One player, many games. A studio integrates AvatarForge with a small game profile file. The player
describes their character once, and the copilot builds a version that fits each game's style and rules.

## Decisions

- **Web first** (Three.js + Vite) with a small Python (FastAPI) server. Fast to change, easy for six
  people to work on at once, and judges can open it from a link.
- **One canonical avatar description** (`shared/avatar-spec.json`) shared by every game. All sliders
  are 0–1 with 0.5 neutral, so neither the adapter nor the AI deals with units.
- **Game profiles are data**, not code: theme, controls (hidden / range / palette), items, mappings.
- **The adapter is plain code.** The AI only translates language into a patch of the avatar
  description; it never invents items a game doesn't have.
- **The server validates every patch**: unknown keys dropped, sliders clamped, enums and colours checked.
- **Offline fallback**: if NIM can't be reached, a keyword parser handles common requests, so the
  demo cannot die on stage.
- **Webcam = numbers only.** MediaPipe runs in the browser; only ratios turned into slider values
  (kept to 0.2–0.8) leave the camera code. The photo is never stored, uploaded or used as a texture,
  so the result cannot be a likeness copy.
- **Safety in two layers**: a built-in name/pattern check, then a NeMo Guardrails self-check input
  rail on NIM. Styles and genres are always allowed.
- **Among Us-style profile**: named as an inspiration and labelled "concept, not affiliated with
  Innersloth". The model is our own; no Innersloth art or files are used.
- **Procedural figures for now**, so the editor works from day one. A MakeHuman/MPFB base mesh with
  morph targets can replace them later with the same parameters.

## Editor UX

- One game on screen at a time, picked with tabs. Switching tabs shows the same player in that game.
- The controls panel shows only what the selected game uses, plus that game's items. Palette-only
  colours are shown as swatches.
- Notes on the preview explain what the adapter did ("this game has no hair, so…").
