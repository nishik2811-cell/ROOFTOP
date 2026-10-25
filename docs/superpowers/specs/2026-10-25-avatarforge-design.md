# AvatarForge: design spec

Date: 2026-10-25
Status: draft, waiting for team review
Context: NVIDIA hackathon, 5 days, 6 people. Source idea: `AvatarForge_Abstract_1.docx`.

## 1. What we are building

A demo of an AI avatar copilot that game studios can integrate. The pitch is
**"One player, many games"**: a player describes their character once (by text,
voice or webcam), and AvatarForge builds a version that fits each game's own
art style and rules, shown side by side, each walkable in a small scene.

Success for the demo:

1. One sentence ("spiky red hair, sharp jaw, muscular") updates three game
   previews at once, each in its own style, in a few seconds.
2. Sliders still work by hand after the copilot has changed things.
3. The webcam sets starting face and body proportions without the photo ever
   leaving the browser or being used as a texture.
4. "Make me Naruto" (or a real celebrity) is refused with a clear notice, while
   "anime style" is allowed.
5. Any of the three avatars can be exported and walked around in a demo scene.
6. NVIDIA tech is visible and essential: Nemotron via NIM for the copilot,
   NeMo Guardrails for the IP and likeness rails, optionally Riva for voice.

Not in scope for the hackathon: integration into real commercial games, a
plug-in for Unity/Unreal, user accounts, clothing generation, Omniverse export
(pitch slide only).

## 2. Demo game profiles

Three concept profiles. Real studios would supply their own profile files.

| id | Name on screen | Base model | Style | Controls |
|---|---|---|---|---|
| `among-us-style` | Among Us-style (concept, not affiliated with Innersloth) | `bean.glb`, made by us | flat shading, fixed palette | colour, hat, visor, pet, small height range; no face |
| `anime-rpg` | Anime RPG | human base mesh | toon shader + outlines, bigger eyes profile | all face, body and hair sliders |
| `retro-shooter` | Retro shooter | human base mesh | low-poly look, pixelate + limited palette post-effect | body and hair sliders, chunky proportion profile, few face sliders |

We do not use Innersloth's art, logos or files; the bean model is our own.

## 3. Core data: the player's avatar description

One canonical JSON object that every game profile reads. All sliders are
numbers from 0 to 1 with 0.5 as the neutral default, so the adapter and the AI
never deal with units.

```jsonc
{
  "face": {
    "faceLength": 0.5, "foreheadHeight": 0.5, "foreheadWidth": 0.5,
    "cheekbones": 0.5, "jawSharpness": 0.5, "chinLength": 0.5,
    "eyeSpacing": 0.5, "eyeSize": 0.5, "noseBridge": 0.5,
    "noseWidth": 0.5, "lipFullness": 0.5, "browHeight": 0.5
  },
  "body": {
    "height": 0.5, "shoulderWidth": 0.5, "torsoLength": 0.5,
    "armLength": 0.5, "legLength": 0.5, "muscle": 0.5, "bodyFat": 0.5,
    "hipWidth": 0.5
  },
  "physique": "custom",            // slim | athletic | muscular | stocky | curvy | custom
  "hair": {
    "style": "short",              // buzz | short | spiky | slick-back | curly | long
    "length": 0.5, "spikiness": 0.5, "volume": 0.5,
    "color": "#3b2a1e"
  },
  "colors": { "skin": "#c68e6a", "eyes": "#4a3020", "primary": "#c0392b", "secondary": "#1c1c1c" },
  "vibe": []                       // free tags such as "cyberpunk", "cute", used by mappings
}
```

Physique presets are named sets of `body` values; picking one sets the sliders,
touching any body slider switches `physique` to `custom`.

This schema lives in one file (`shared/avatar.schema.json`) and is the contract
between all six people. It is locked at the end of day 1.

## 4. Game profile file

Each game is one JSON file in `profiles/`:

```jsonc
{
  "id": "among-us-style",
  "name": "Among Us-style (concept)",
  "baseModel": "bean.glb",
  "skeleton": "simple",                 // humanoid | simple
  "theme": {
    "shader": "flat",                   // flat | toon | pixel | pbr
    "outline": false,
    "palette": ["#c51111", "#132ed1", "#117f2d", "#ed54ba", "#ef7d0d", "#f5f557", "#3f474e", "#d6e0f0"],
    "postFx": [],                       // e.g. ["pixelate:4"]
    "proportions": {}                   // multipliers on body values, e.g. { "eyeSize": 1.3 }
  },
  "controls": {
    "body.height": { "min": 0.45, "max": 0.55 },
    "colors.primary": { "from": "palette" },
    "face": "hidden"
  },
  "options": {
    "hat": ["none", "cap", "crown", "spiky-hat", "flower"],
    "visor": ["classic", "cyan", "gold"],
    "pet": ["none", "mini-bean", "robot"]
  },
  "mappings": [
    { "when": { "hair.style": "spiky" }, "set": { "hat": "spiky-hat" }, "note": "This game has no hair, so you got the spiky hat." },
    { "when": { "physique": "muscular" }, "set": { "body.height": 0.55 } }
  ],
  "export": "glb"
}
```

## 5. Architecture

```
browser (Vite + Three.js)                       server (Python, FastAPI)
┌──────────────────────────────────┐            ┌───────────────────────────┐
│ Editor UI: sliders, chat, mic    │  /copilot  │ NeMo Guardrails input rail│
│ Avatar store (canonical JSON)    │──────────▶ │   → Nemotron on NIM       │
│ Adapter (profile × avatar)       │ ◀──────────│ returns validated patch   │
│ 3 previews (one per profile)     │            │ /speech (Riva, optional)  │
│ MediaPipe face + pose (in-page)  │            └───────────────────────────┘
│ Export GLB → demo scene          │
└──────────────────────────────────┘
```

Units, each with one job:

| Unit | Path | Does | Depends on |
|---|---|---|---|
| Schema | `shared/avatar.schema.json`, `shared/profile.schema.json` | the contracts | nothing |
| Avatar store | `web/src/avatar/` | holds the canonical avatar, applies patches, undo, presets | schema |
| Adapter | `web/src/adapter/` | pure function `adapt(avatar, profile) → { params, notes }`: ranges, nearest palette colour, mappings, proportions | schema |
| Renderer | `web/src/render/` | loads a base model, applies params to morph targets / bone scales, applies the theme shader and post-effects | adapter output |
| Copilot client | `web/src/copilot/` | sends the message + current avatar to the server, applies the returned patch | server API |
| Webcam | `web/src/capture/` | MediaPipe Face Landmarker + Pose Landmarker in the browser, turns landmark ratios into slider values; frames stay in the page | schema |
| Demo scene | `web/src/play/` | loads an exported avatar into a small walkable scene (WASD + idle/walk animation) | renderer |
| Copilot server | `server/` | `/copilot`: guardrails, then Nemotron with the schema in the prompt; validates the reply with pydantic; never trusts the model's JSON blindly | NIM, NeMo Guardrails |

The adapter is plain code, not AI: predictable, testable, and the part a studio
actually integrates. The AI only turns language into a patch of the canonical
avatar.

## 6. Copilot flow

1. The player types or says: "make my jaw sharper and give me spiky red hair".
2. Browser sends `{ message, avatar }` to `POST /copilot`.
3. NeMo Guardrails input rail checks for named copyrighted characters or real
   people. If blocked → `{ blocked: true, reason }`, shown as a notice.
4. Otherwise the server asks Nemotron (via NIM's OpenAI-compatible endpoint,
   model id in config) for a JSON patch, e.g.
   `{ "face.jawSharpness": 0.8, "hair.style": "spiky", "hair.color": "#c0392b" }`,
   plus a one-line reply. The current avatar is included so relative requests
   ("a bit sharper") work.
5. The server validates the patch against the schema (unknown keys dropped,
   numbers clamped to 0..1), returns `{ patch, reply }`.
6. The browser applies the patch; all three previews update through the
   adapter; adapter notes ("this game has no hair…") show under each preview.

Fallback: if NIM is unreachable, the server uses a small keyword parser so the
demo still runs (clearly labelled "offline mode").

## 7. Webcam capture

- Consent screen first: what is measured, that frames never leave the browser,
  and that only your own face may be used.
- MediaPipe Face Landmarker (478 points) and Pose Landmarker (33 points), JS
  build, in the page.
- Ratios (for example jaw width / face width, eye distance / face width,
  shoulder width / hip width) are mapped to slider values with fixed calibrated
  ranges, then clamped to 0.2..0.8 so results never look extreme.
- Output is a normal patch; the player edits it afterwards like any other.

## 8. Safety

- NeMo Guardrails input rail on every copilot message: blocks requests for
  named copyrighted characters and real people; allows styles and genres.
- No uploads to the server. The photo is only used as numbers (section 7), so
  the result cannot be a likeness copy.
- Only our own or openly licensed assets (MakeHuman/MPFB is CC0 for exports).
- A refusal always shows a notice explaining why.

## 9. Assets

- Human base mesh: MakeHuman via the MPFB Blender add-on, exported as GLB with
  morph targets for the face and body sliders and a humanoid skeleton.
- Fallback if the mesh work slips: a procedural Three.js figure where sliders
  scale bones and parts, so the editor and adapter can be built and demoed
  from day 1 regardless.
- Hair: 6 modular hair meshes, with `length`, `spikiness`, `volume` as morph
  targets.
- Bean model, hats, visors, pets: our own simple models.
- Walk and idle animations: from openly licensed sources, retargeted once to
  our one humanoid skeleton.

## 10. Stretch goals (only after everything above works)

1. Voice input with Riva speech-to-text.
2. The avatar speaks the copilot's reply with Audio2Face-3D driving its face.
3. VRM export (GLB first).

## 11. Testing

- Adapter: unit tests (Vitest) per profile: ranges clamp, palette snapping,
  mappings fire, notes appear, hidden controls are ignored.
- Schema: every profile file and every preset validates.
- Server: pytest with NIM mocked: valid patch passes, bad JSON is rejected,
  out-of-range values are clamped, unknown keys are dropped, guardrail cases
  (a list of must-block and must-allow prompts) behave.
- Webcam: ratio → slider mapping unit-tested on saved landmark samples.
- One Playwright smoke test: open editor, type a prompt with the server mocked,
  see three previews change.

## 12. Team split and timeline

| Person | Owns |
|---|---|
| 1 | Human base mesh, morph targets, hair assets |
| 2 | Editor UI, avatar store, renderer |
| 3 | Themes (shaders, post-effects), bean model and items, profiles |
| 4 | Copilot server: NIM, Nemotron prompt, validation, NeMo Guardrails |
| 5 | MediaPipe webcam capture; Riva voice if time allows |
| 6 | Adapter, demo scene, export, pitch and demo script |

- Day 1: lock both schemas, profiles drafted, procedural fallback avatar on screen.
- Days 2–3: units built in parallel against the schemas.
- Day 4: integration, real mesh swapped in.
- Day 5: polish, stretch goals, rehearsal, backup demo video.

## 13. Where the code lives

Recommended: a new repository `avatarforge`. Until that exists, the code goes in
an `avatarforge/` folder on this branch so nothing in Rooftop changes.
