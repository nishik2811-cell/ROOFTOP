# AvatarForge

**One player, many games.** An AI copilot for character creation that game studios can plug in.
The player describes their character once ("sharper jaw, spiky red hair, muscular"), by text or
from their own face on the webcam, and AvatarForge builds that character in the style and rules of
each game.

Built for the NVIDIA hackathon:

- **Copilot:** Nemotron on **NVIDIA NIM** turns plain language into avatar changes.
- **Safety:** **NeMo Guardrails** (plus a built-in first check) blocks copyrighted characters
  ("make me Naruto") and real people's likeness, while allowing styles ("anime theme").
- **Webcam:** **MediaPipe** measures face and shoulder proportions *in the browser*. No image is
  saved, uploaded or used as a texture; only slider values come out.

## Run it

You need Node 20+ and Python 3.11+.

```bash
export NVIDIA_API_KEY=nvapi-...   # optional; from build.nvidia.com. Without it the copilot runs offline.
./start.sh                        # then open http://localhost:8000
```

For development, run the two halves separately:

```bash
cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --port 8000 --reload

cd web && npm install && npm run dev      # http://localhost:5173 (talks to the server through /api)
```

Optional NeMo Guardrails layer: `server/.venv/bin/pip install -r server/requirements-nemo.txt`
(it is used when `NVIDIA_API_KEY` is set; `GUARDRAILS=builtin` turns it off).

Settings (environment variables): `NIM_MODEL` (default `nvidia/llama-3.3-nemotron-super-49b-v1.5`;
check build.nvidia.com for current model ids), `NIM_BASE_URL`, `GUARDRAILS`.

## How it works

```
player text / webcam ──▶ avatar description (shared/avatar-spec.json) ──▶ adapter ──▶ game version
                          one set of values for every game                  plain code, per game profile
```

1. **The avatar description** is the same for every game: 12 face sliders, 8 body sliders, physique,
   hair (style, length, spikiness, volume, colour), colours and vibe tags. Sliders run 0–1.
2. **A game profile** (`profiles/*.json`) is what a studio writes. It sets the game's art style
   (shader, outlines, pixel size, palette, proportions), which controls the game shows and their
   ranges, the game's own items (hats, outfits, armour), and mappings such as
   "spiky hair → spiky hat" for a game without hair.
3. **The adapter** (`web/src/adapter/adapt.js`) turns the avatar into each game's version. It is plain
   code, not AI, so it's predictable and testable, and it's the part a studio integrates.
4. **The copilot** only turns language into changes to the avatar description. The server validates
   every change (unknown keys dropped, numbers clamped) before the editor applies it.

The three demo profiles:

| Profile | Shows |
|---|---|
| Among Us-style (concept, not affiliated with Innersloth; our own model) | A game with very few controls: suit colour from a fixed palette, hat, visor, pet. Hair turns into hats. |
| Anime RPG | Every slider, cel shading, outlines, anime proportions |
| Retro Shooter | Low-poly, pixelated, 16-colour palette, chunky proportions, armour |

To add a game, drop a new JSON file into `profiles/`; it appears as a tab.

## Using the editor

- Pick a game with the tabs; the left panel shows only what that game uses.
- Type to the copilot or use a suggestion. "Make me Naruto" shows the safety rail.
- **Face close-up** / **Full body** on the preview; drag to turn the character.
- **Play in this game** drops the character into a small scene: WASD or arrow keys, or hold the
  mouse/finger on the screen. **Export .glb** downloads it.
- Ctrl/Cmd+Z undoes.

## Tests

```bash
cd web && npm test                      # adapter, store, profiles, webcam measurement
cd server && .venv/bin/python -m pytest # validation, safety rail, offline parser, NIM reply handling
```

## Project layout

```
shared/     avatar-spec.json, physiques.json   (the contract everything builds on)
profiles/   one JSON file per game
web/        Vite + Three.js editor
  src/avatar/   spec helpers and the store (undo, presets)
  src/adapter/  avatar × profile → game version
  src/render/   procedural figures, materials, previews
  src/capture/  MediaPipe webcam → slider values
  src/copilot/  client for the server
  src/play/     walkable demo scene and GLB export
  src/ui/       the controls panel
server/     FastAPI: /api/copilot (guardrails → Nemotron on NIM → validation), offline fallback
docs/       design notes
```

## What's next

- Swap the procedural figure for a MakeHuman (MPFB) base mesh with morph targets; the same
  parameters drive it.
- Voice input with NVIDIA Riva; the avatar speaking the copilot's reply with Audio2Face-3D.
- VRM export, and a Unity/Unreal loader for game profiles.
