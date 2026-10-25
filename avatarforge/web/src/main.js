import { adapt } from './adapter/adapt.js';
import { createStore } from './avatar/store.js';
import { measureFromWebcam } from './capture/webcam.js';
import { askCopilot, health } from './copilot/client.js';
import { exportGlb, openPlay } from './play/play.js';
import { createPreview } from './render/preview.js';
import { createControls } from './ui/controls.js';

const $ = (id) => document.getElementById(id);

// Profiles are plain JSON files; a studio adds a game by dropping one into /profiles.
const ORDER = ['among-us-style', 'anime-rpg', 'retro-shooter'];
const profiles = Object.values(import.meta.glob('../../profiles/*.json', { eager: true, import: 'default' })).sort(
  (a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99),
);

const store = createStore();
const choices = Object.fromEntries(profiles.map((p) => [p.id, {}]));
let current = null; // { profile, preview, adapted }

const controls = createControls($('controls'), store, (name, value) => {
  choices[current.profile.id][name] = value;
  refresh();
});

// ---------------------------------------------------------------------------
// Game tabs: one game on screen at a time

const tabs = profiles.map((profile) => {
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'tab';
  tab.setAttribute('role', 'tab');
  tab.innerHTML = '<i></i><strong></strong><span></span>';
  tab.querySelector('i').style.background = profile.theme.palette?.[0] ?? profile.theme.background;
  tab.querySelector('strong').textContent = profile.name;
  tab.querySelector('span').textContent = profile.tagline ?? '';
  tab.addEventListener('click', () => selectGame(profile.id));
  $('tabs').append(tab);
  return { profile, tab };
});
$('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = profiles.indexOf(current.profile);
  const next = profiles[(i + (e.key === 'ArrowRight' ? 1 : profiles.length - 1)) % profiles.length];
  selectGame(next.id);
  tabs.find((t) => t.profile === next).tab.focus();
});

function selectGame(id) {
  const profile = profiles.find((p) => p.id === id) ?? profiles[0];
  if (current?.profile === profile) return;
  for (const t of tabs) {
    t.tab.setAttribute('aria-selected', String(t.profile === profile));
    t.tab.tabIndex = t.profile === profile ? 0 : -1;
  }
  current?.preview.dispose();
  // A fresh canvas per game: each game has its own renderer settings (pixel size, shading).
  const canvas = document.createElement('canvas');
  $('canvas-wrap').replaceChildren(canvas);
  current = { profile, preview: createPreview(canvas, profile), adapted: null };
  $('game-name').textContent = profile.name;
  $('game-tagline').textContent = profile.tagline ?? '';
  $('zoom').textContent = 'Face close-up';
  current.preview.resize();
  controls.setProfile(profile, adapt(store.get(), profile, choices[profile.id]));
  refresh();
  try {
    localStorage.setItem('avatarforge.game', profile.id);
  } catch {}
}

let pending = false;
function refresh() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const { profile, preview } = current;
    current.adapted = adapt(store.get(), profile, choices[profile.id]);
    preview.update(current.adapted);
    controls.setAdapted(current.adapted);
    $('notes').replaceChildren(...current.adapted.notes.map((n) => Object.assign(document.createElement('li'), { textContent: n })));
  });
}
store.subscribe(refresh);

let saved = null;
try {
  saved = localStorage.getItem('avatarforge.game');
} catch {}
selectGame(saved ?? profiles[0].id);

new ResizeObserver(() => current.preview.resize()).observe($('canvas-wrap'));
(function loop(t) {
  current.preview.frame(t / 1000);
  requestAnimationFrame(loop);
})(0);

$('zoom').addEventListener('click', () => ($('zoom').textContent = current.preview.toggleCloseUp() ? 'Full body' : 'Face close-up'));
$('play-btn').addEventListener('click', startPlay);
$('export-btn').addEventListener('click', () => exportGlb(current.profile, current.adapted));
$('undo').addEventListener('click', () => store.undo());
$('reset').addEventListener('click', () => {
  for (const id in choices) choices[id] = {};
  store.reset();
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !/input/i.test(document.activeElement?.tagName)) {
    e.preventDefault();
    store.undo();
  }
});

// ---------------------------------------------------------------------------
// Copilot chat

const chat = $('chat');
function say(text, who, { meta, blocked } = {}) {
  const m = document.createElement('div');
  m.className = `msg ${who}${blocked ? ' blocked' : ''}`;
  m.textContent = text;
  if (meta) m.append(Object.assign(document.createElement('small'), { textContent: meta }));
  chat.append(m);
  chat.scrollTop = chat.scrollHeight;
  return m;
}
say("Hi! Describe your character and I'll build it. Switch games above to see how you look in each one.", 'bot');

const SUGGESTIONS = [
  'Sharper jaw, spiky red hair, muscular',
  'Cute vibe, bigger eyes, long pink hair',
  'Cyberpunk, slim, black outfit, a bit taller',
  'Royal vibe, gold outfit',
  'Make me Naruto',
];
for (const s of SUGGESTIONS) {
  const b = Object.assign(document.createElement('button'), { type: 'button', textContent: s });
  b.addEventListener('click', () => send(s));
  $('suggestions').append(b);
}

async function send(text) {
  const message = text.trim();
  if (!message) return;
  say(message, 'user');
  $('message').value = '';
  const button = $('ask').querySelector('button');
  button.disabled = true;
  const thinking = say('Thinking…', 'bot thinking');
  try {
    const res = await askCopilot(message, store.get());
    thinking.remove();
    if (res.blocked) {
      say(res.reason, 'bot', { blocked: true, meta: 'Blocked by the safety rail' });
      return;
    }
    const applied = store.apply(res.patch);
    const n = Object.keys(applied).length;
    say(res.reply || 'Done.', 'bot', { meta: `${n} change${n === 1 ? '' : 's'} · ${res.mode}` });
    if (n) {
      $('game').classList.remove('flash');
      void $('game').offsetWidth;
      $('game').classList.add('flash');
    }
  } catch (e) {
    thinking.remove();
    say(`Couldn't reach the copilot server: ${e.message} Is it running on port 8000?`, 'bot', { blocked: true });
  } finally {
    button.disabled = false;
    $('message').focus();
  }
}
$('ask').addEventListener('submit', (e) => {
  e.preventDefault();
  send($('message').value);
});

health()
  .then((h) => {
    const live = h.nimKey;
    $('status').textContent = live ? `● ${h.model.split('/').at(-1)} on NVIDIA NIM` : '● Offline copilot (no NVIDIA_API_KEY)';
    $('status').title = `Safety: ${h.guardrails}`;
    $('status').className = `badge ${live ? 'live' : 'offline'}`;
  })
  .catch(() => {
    $('status').textContent = '● Copilot server not running';
    $('status').className = 'badge offline';
  });

// ---------------------------------------------------------------------------
// Webcam: consent first, then measure in the browser

const dialog = $('consent');
$('webcam').addEventListener('click', () => {
  $('capture-status').textContent = '';
  $('video').classList.remove('on');
  dialog.showModal();
});
$('consent-cancel').addEventListener('click', () => dialog.close());
$('consent-go').addEventListener('click', async () => {
  const go = $('consent-go');
  go.disabled = true;
  $('video').classList.add('on');
  try {
    const { patch, faceFound, bodyFound } = await measureFromWebcam($('video'), (s) => ($('capture-status').textContent = s));
    if (!faceFound) {
      $('capture-status').textContent = 'No face found. Try more light, and look straight at the camera.';
      return;
    }
    store.apply(patch);
    dialog.close();
    say(
      `Measured ${Object.keys(patch).length} proportions from your face${bodyFound ? ' and shoulders' : ''}. ` +
        'Nothing was saved or uploaded. Fine-tune anything with the sliders or ask me.',
      'bot',
      { meta: 'MediaPipe, in your browser' },
    );
  } catch (e) {
    $('capture-status').textContent = `Camera problem: ${e.message}`;
  } finally {
    go.disabled = false;
    $('video').classList.remove('on');
  }
});

// ---------------------------------------------------------------------------
// Play mode

let session = null;
function startPlay() {
  session?.close();
  const canvas = document.createElement('canvas');
  $('play-stage').replaceChildren(canvas);
  session = openPlay({ overlay: $('play'), canvas, title: $('play-title'), profile: current.profile, adapted: current.adapted });
}
$('play-close').addEventListener('click', () => {
  session?.close();
  session = null;
});
