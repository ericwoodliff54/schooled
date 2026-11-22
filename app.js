'use strict';

// ---------------------------------------------------------------
// Schooled app. Plain JavaScript, no build step.
// Change WORKER_URL only if you rename or move the Cloudflare Worker.
// ---------------------------------------------------------------
const WORKER_URL = 'https://schooled-worker.ericwoodliff.workers.dev';
const STORE_KEY = 'schooled.v1';
const MAX_PHOTO_SIDE = 1280; // preview and zoom-set whole picture
const SINGLE_SIDE = 2048; // the one sharp picture sent first
const MAX_VERIFY = 6; // most kinds double-checked with close-ups in one scan
const MONTAGE_CROP_MIN = 200; // close-ups are shown to the AI at least this big (pixels)
const MONTAGE_CROP_MAX = 480;
const MONTAGE_MAX_W = 1400;
const KIND_LIST = ['fish', 'shrimp', 'snail', 'plant', 'coral', 'invert', 'other'];

// ---------- Small helpers ----------
const $ = (id) => document.getElementById(id);

// Builds elements with textContent only, so text from the AI can never inject markup.
function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props || {})) {
    if (key === 'class') node.className = val;
    else if (key === 'text') node.textContent = val;
    else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2), val);
    else if (val !== false && val != null) node.setAttribute(key, val === true ? '' : String(val));
  }
  for (const kid of kids.flat()) {
    if (kid != null) node.append(kid);
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const KIND_ICONS = {
  fish: ['M3 12c3-4.5 8-5.5 12-2.5l5-2.5v10l-5-2.5c-4 3-9 2-12-2.5z'],
  plant: ['M12 21V9', 'M12 13c-4 0-6-2.5-6-6 4 0 6 2 6 6z', 'M12 16c4 0 6-2.5 6-6-4 0-6 2-6 6z'],
  shrimp: ['M5 8c0-2.5 3-4 6-3 4 1.2 7 4.5 7 9 0 2-1 4-3 5', 'M5 8c0 2 1.5 3 3.5 3', 'M15 19l-3 1.5'],
  snail: ['M5 19h14', 'M16 19c2.5 0 3-2.5 3-4a7 7 0 1 0-7 4', 'M12 15a2.5 2.5 0 1 1 2.5-2.5', 'M5 19c0-2 .5-4 2-5'],
  coral: ['M12 21v-8', 'M12 13c-3 0-5-2-5-5', 'M12 13c3 0 5-2 5-5', 'M7 8c0-2 1-3 1-5', 'M17 8c0-2-1-3-1-5', 'M12 13V4'],
  invert: ['M12 3l2.6 5.6 6.1.8-4.5 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.3 9.4l6.1-.8z']
};
function kindIcon(kind) {
  const paths = KIND_ICONS[kind] || KIND_ICONS.fish;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  paths.forEach((d) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  });
  return svg;
}
function kindAvatar(kind) {
  const safe = ['fish', 'plant', 'shrimp', 'snail', 'coral', 'invert'].includes(kind) ? kind : 'other';
  return el('span', { class: 'avatar ' + safe }, kindIcon(safe));
}

// ---------- Species database (names, look-alike groups, autocomplete) ----------
const DB = { ready: false, list: [], byKey: new Map(), groups: {} };

function normKey(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function loadSpecies() {
  try {
    const res = await fetch('species.json');
    const data = await res.json();
    if (!data || !Array.isArray(data.species)) return;
    DB.list = data.species;
    DB.groups = data.groups || {};
    DB.byKey = new Map();
    DB.list.forEach((e) => {
      [e.n, e.s].concat(e.a || []).forEach((key) => {
        const k = normKey(key);
        if (k && !DB.byKey.has(k)) DB.byKey.set(k, e);
      });
    });
    DB.ready = true;
  } catch (err) { /* the app works without the list, with plainer names */ }
}

function lookupSpecies(name) {
  return DB.byKey.get(normKey(name)) || null;
}

// Same species whatever the spelling: "cardinals", "Cardinal Tetra" and its scientific name all match.
function canonKey(name) {
  const hit = lookupSpecies(name);
  return normKey(hit ? hit.n : name);
}

function usableScientific(entry) {
  return entry && /\s/.test(entry.s) && !/\bsp\.$/.test(entry.s) ? entry.s : '';
}

// ---------- Search box for species (names, aliases and scientific names) ----------
function speciesMatches(query, type) {
  const q = normKey(query);
  if (!q || !DB.ready) return [];
  const codes = type === 'Saltwater' ? ['s'] : type === 'Brackish' ? ['b', 'f'] : ['f'];
  const scored = [];
  DB.list.forEach((e) => {
    if (!codes.some((c) => e.w.includes(c))) return;
    let best = 99;
    [e.n, e.s].concat(e.a || []).forEach((raw) => {
      const n = normKey(raw);
      if (!n) return;
      if (n === q) best = Math.min(best, 0);
      else if (n.startsWith(q)) best = Math.min(best, 1);
      else if (n.split(' ').some((w) => w.startsWith(q))) best = Math.min(best, 2);
      else if (n.includes(q)) best = Math.min(best, 3);
    });
    if (best < 99) scored.push([best, e]);
  });
  scored.sort((a, b) => a[0] - b[0] || a[1].n.localeCompare(b[1].n));
  return scored.slice(0, 8).map((x) => x[1]);
}

// A search-as-you-type box. onPick(name, entry) gets called with the database entry, or null for text typed in by hand.
function createSearch(opts) {
  const input = el('input', {
    type: 'text', class: 'search-input', placeholder: opts.placeholder, 'aria-label': opts.label,
    maxlength: 60, autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: 'search', value: opts.value || ''
  });
  const results = el('div', { class: 'search-results', role: 'listbox' });
  results.hidden = true;
  const root = el('div', { class: 'search' }, input, results);
  function render() {
    const q = input.value.trim();
    results.replaceChildren();
    if (!q) { results.hidden = true; return; }
    const found = speciesMatches(q, opts.type ? opts.type() : 'Freshwater');
    found.forEach((e) => results.append(
      el('button', { type: 'button', class: 'search-row', role: 'option', onclick: () => opts.onPick(e.n, e) },
        kindAvatar(e.k),
        el('span', { class: 'grow' },
          el('span', { class: 'name', text: e.n }),
          usableScientific(e) ? el('span', { class: 'sub sci', text: e.s }) : null))
    ));
    if (!found.some((e) => normKey(e.n) === normKey(q))) {
      results.append(
        el('button', { type: 'button', class: 'search-row custom', role: 'option', onclick: () => opts.onPick(q.slice(0, 60), null) },
          el('span', { class: 'avatar other', text: '+' }),
          el('span', { class: 'grow' },
            el('span', { class: 'name', text: 'Add \u201c' + q + '\u201d' }),
            el('span', { class: 'sub', text: found.length ? 'Not what you meant? Add it as typed' : 'Not in the list, add it as typed' })))
      );
    }
    results.hidden = false;
    if (typeof results.scrollIntoView === 'function') results.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  input.addEventListener('input', render);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); const first = results.querySelector('.search-row'); if (first) first.click(); }
    else if (ev.key === 'Escape') results.hidden = true;
  });
  return {
    root, input,
    close() { results.hidden = true; },
    clear() { input.value = ''; results.replaceChildren(); results.hidden = true; }
  };
}

// ---------- Saved data (stays on the phone) ----------
const TYPES = ['Freshwater', 'Saltwater', 'Brackish'];
const STYLES = {
  Freshwater: ['Community', 'Planted', 'Cichlid', 'Nano / shrimp', 'Predator', 'Species only', 'Breeding', 'Biotope', 'Other'],
  Saltwater: ['Reef', 'Fish only (FOWLR)', 'Nano reef', 'Predator', 'Seahorse', 'Other'],
  Brackish: ['Community', 'Puffer', 'Other']
};
const WATER_SOURCES = ['city', 'well', 'ro'];
const WATER_NAMES = { city: 'City water', well: 'Well water', ro: 'RO / filtered' };
const WATER_SHORT = { city: 'City', well: 'Well', ro: 'RO / filtered' };
const SIZE_PRESETS = {
  gallons: [5, 10, 15, 20, 29, 40, 55, 75, 90, 125, 150, 180, 220, 300],
  liters: [20, 40, 60, 100, 150, 200, 300, 400, 500, 700, 1000]
};
const TANK_PHOTO_SIDE = 800;
const SPECIES_PHOTO_SIDE = 640;
const MAX_TANKS = 12;

function uid() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function newTank(partial) {
  return Object.assign({
    id: uid(), name: '', size: '', unit: 'gallons', type: 'Freshwater', style: '',
    water: 'city', zip: '', photo: '', started: '', notes: '', fish: []
  }, partial || {});
}

function cleanFish(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && typeof f.name === 'string' && f.name.trim())
    .map((f) => {
      const item = { name: f.name.trim().slice(0, 60), count: Math.min(999, Math.max(1, Math.round(Number(f.count)) || 1)) };
      if (KIND_LIST.includes(f.kind)) item.kind = f.kind;
      return item;
    });
}

// Accepts anything from storage and returns a safe tank (or null).
function cleanTank(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = newTank();
  if (typeof raw.id === 'string' && raw.id) t.id = raw.id.slice(0, 40);
  t.name = typeof raw.name === 'string' ? raw.name.slice(0, 40) : '';
  const size = Number(raw.size);
  t.size = isFinite(size) && size > 0 && size <= 5000 ? String(size) : '';
  t.unit = raw.unit === 'liters' ? 'liters' : 'gallons';
  t.type = TYPES.includes(raw.type) ? raw.type : 'Freshwater';
  t.style = typeof raw.style === 'string' && STYLES[t.type].includes(raw.style) ? raw.style : '';
  t.water = WATER_SOURCES.includes(raw.water) ? raw.water : 'city';
  t.zip = typeof raw.zip === 'string' && /^\d{5}$/.test(raw.zip) ? raw.zip : '';
  t.photo = typeof raw.photo === 'string' && raw.photo.startsWith('data:image/') ? raw.photo : '';
  t.started = typeof raw.started === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.started) ? raw.started : '';
  t.notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 400) : '';
  t.fish = cleanFish(raw.fish);
  return t;
}

function defaultState() {
  return { version: 2, setupDone: false, activeId: '', tanks: [] };
}

let migrated = false;
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return defaultState();
    const next = defaultState();
    next.setupDone = !!saved.setupDone;
    if (Array.isArray(saved.tanks)) {
      saved.tanks.slice(0, MAX_TANKS).forEach((r) => {
        const t = cleanTank(r);
        if (t && !next.tanks.some((x) => x.id === t.id)) next.tanks.push(t);
      });
    } else if (saved.tank || Array.isArray(saved.fish)) {
      // Older version kept a single tank. Carry it over as the first tank.
      const old = saved.tank && typeof saved.tank === 'object' ? saved.tank : {};
      const fish = cleanFish(saved.fish);
      if (saved.setupDone || fish.length || old.name || old.size) {
        const t = cleanTank(Object.assign({}, old, { fish }));
        if (t) next.tanks.push(t);
      }
      migrated = true;
    }
    next.activeId = next.tanks.some((t) => t.id === saved.activeId) ? saved.activeId : (next.tanks[0] ? next.tanks[0].id : '');
    return next;
  } catch (err) {
    return defaultState();
  }
}

// Returns true when the save worked. Photos can fill a phone's browser storage.
function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    return false; // private mode or full storage; the app still works for this visit
  }
}

let state = loadState();
if (migrated) saveState();
let pending = null; // current scan: { photoUrl, species: [], tips, loading, error, tankId }

let toastTimer = null;
function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4500);
}

// ---------- Navigation ----------
const VIEWS = ['setup', 'home', 'scan', 'results', 'water', 'tanks', 'tank', 'species', 'dream', 'fishcheck'];
let currentView = 'home';
const NAV_FOR = { home: 'home', scan: 'scan', results: 'scan', water: 'water', tanks: 'tanks', tank: 'tanks', species: 'tanks', dream: 'home', fishcheck: 'home' };
let openTankId = '';
let editingSize = false;

function showView(name) {
  VIEWS.forEach((v) => { $('view-' + v).hidden = v !== name; });
  document.body.dataset.view = name;
  currentView = name;
  $('nav').hidden = name === 'setup';
  document.querySelectorAll('#nav button').forEach((b) => {
    if (b.dataset.view === NAV_FOR[name]) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'setup') fillSetupForm();
  if (name === 'home') renderHome();
  if (name === 'water') renderWater();
  if (name === 'tanks') renderTanks();
  if (name === 'tank') renderTank();
  if (name === 'species') renderSpecies();
  if (name === 'dream') renderDream();
  if (name === 'fishcheck') renderFishCheck();
  window.scrollTo(0, 0);
}

function showTank(id) {
  openTankId = id;
  editingSize = false;
  resetDelete();
  showView('tank');
}

document.querySelectorAll('#nav button').forEach((b) => {
  b.addEventListener('click', () => showView(b.dataset.view));
});

// ---------- Tank helpers ----------
function getTank(id) {
  return state.tanks.find((t) => t.id === id) || null;
}

function activeTank() {
  return getTank(state.activeId) || state.tanks[0] || null;
}

function tankLabel(t) {
  if (t.name.trim()) return t.name.trim();
  return state.tanks.length > 1 ? 'Tank ' + (state.tanks.indexOf(t) + 1) : 'My tank';
}

function sizeShort(t) {
  return t.size ? t.size + (t.unit === 'liters' ? ' L' : ' gal') : '';
}

function tankSummary(t) {
  return [sizeShort(t), t.type, t.style].filter(Boolean).join(' · ');
}

function ensureTank() {
  let t = activeTank();
  if (!t) {
    t = newTank();
    state.tanks.push(t);
    state.activeId = t.id;
    state.setupDone = true;
  }
  return t;
}

function addToTank(tank, name, count, mode, kind) {
  let clean = name.trim().slice(0, 60);
  if (!clean) return;
  const hit = lookupSpecies(clean);
  if (hit) { clean = hit.n; kind = kind || hit.k; }
  const key = canonKey(clean);
  const existing = tank.fish.find((f) => canonKey(f.name) === key);
  if (existing) {
    if (kind && !existing.kind) existing.kind = kind;
    if (mode === 'add') existing.count = Math.min(999, existing.count + count);
    else if (mode === 'scan') existing.count = Math.max(existing.count, count); // a scan can only add or confirm, never lower
    else existing.count = count;
  }
  else tank.fish.push(kind && KIND_LIST.includes(kind) ? { name: clean, count, kind } : { name: clean, count });
}

function totalFish(tank) {
  return tank.fish.reduce((sum, f) => sum + f.count, 0);
}

// Reads a photo from almost any file type and shrinks it to fit in saved storage.
async function photoFromFile(file, side) {
  const image = await loadImage(file);
  try {
    return drawToJpeg(image.source, 0, 0, image.width, image.height, side || TANK_PHOTO_SIDE, 0.8);
  } finally {
    image.done();
  }
}

function wireTankPhotoInput(buttonId, inputId, onPhoto) {
  $(buttonId).addEventListener('click', () => $(inputId).click());
  $(inputId).addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      onPhoto(await photoFromFile(file));
    } catch (err) {
      toast("This device couldn't open that photo. Try another one.");
    }
  });
}

// ---------- Add a tank (also the first-run setup) ----------
let setupPhoto = '';

function fillStyleSelect(type, selected) {
  const sel = $('tank-style');
  sel.replaceChildren(el('option', { value: '', text: 'Not set' }), ...STYLES[type].map((s) => el('option', { value: s, text: s })));
  sel.value = STYLES[type].includes(selected) ? selected : '';
}

function renderSetupPhoto() {
  const box = $('setup-photo');
  box.replaceChildren(setupPhoto
    ? el('img', { src: setupPhoto, alt: 'Your tank photo' })
    : el('div', { class: 'photo-empty' }, kindIcon('fish'), el('span', { text: 'Add a photo of your tank' })));
  $('setup-photo-remove').hidden = !setupPhoto;
}

function fillSetupForm() {
  const first = !state.setupDone;
  $('setup-title').textContent = first ? "Let's set up your tank" : 'Add a tank';
  $('setup-sub').textContent = first
    ? 'This helps size treatments and look up your tap water. It stays on your phone.'
    : 'Give it a name, a photo and a few details. You can change any of it later.';
  $('setup-submit').textContent = first ? 'Continue' : 'Add tank';
  $('setup-skip').textContent = first ? 'Skip for now' : 'Cancel';
  $('tank-name').value = '';
  $('tank-size').value = '';
  $('tank-zip').value = '';
  document.querySelector('input[name="unit"][value="gallons"]').checked = true;
  document.querySelector('input[name="type"][value="Freshwater"]').checked = true;
  document.querySelector('input[name="water"][value="city"]').checked = true;
  fillStyleSelect('Freshwater', '');
  setupPhoto = '';
  renderSetupPhoto();
  $('setup-error').hidden = true;
  syncZipField();
}

function syncZipField() {
  const water = document.querySelector('input[name="water"]:checked').value;
  $('zip-field').hidden = water !== 'city';
}

document.querySelectorAll('input[name="water"]').forEach((r) => r.addEventListener('change', syncZipField));
document.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', () => {
  fillStyleSelect(document.querySelector('input[name="type"]:checked').value, '');
}));

wireTankPhotoInput('setup-photo-camera', 'setup-photo-camera-input', (url) => { setupPhoto = url; renderSetupPhoto(); });
wireTankPhotoInput('setup-photo-gallery', 'setup-photo-gallery-input', (url) => { setupPhoto = url; renderSetupPhoto(); });
$('setup-photo-remove').addEventListener('click', () => { setupPhoto = ''; renderSetupPhoto(); });

function startAddTank() {
  if (state.tanks.length >= MAX_TANKS) {
    toast('That is the most tanks the app can hold on this phone (' + MAX_TANKS + ').');
    return;
  }
  showView('setup');
}

$('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const first = !state.setupDone;
  const name = $('tank-name').value.trim();
  const sizeRaw = $('tank-size').value.trim();
  const unit = document.querySelector('input[name="unit"]:checked').value;
  const type = document.querySelector('input[name="type"]:checked').value;
  const water = document.querySelector('input[name="water"]:checked').value;
  const style = $('tank-style').value;
  const zip = $('tank-zip').value.trim();
  const err = $('setup-error');

  const size = Number(sizeRaw);
  if (sizeRaw && (!isFinite(size) || size <= 0 || size > 5000)) {
    err.textContent = 'Enter your tank size as a number, like 29, or leave it blank.';
    err.hidden = false;
    $('tank-size').focus();
    return;
  }
  if (water === 'city' && zip && !/^\d{5}$/.test(zip)) {
    err.textContent = 'ZIP code should be 5 digits, or leave it blank.';
    err.hidden = false;
    $('tank-zip').focus();
    return;
  }
  if (state.tanks.length >= MAX_TANKS) {
    err.textContent = 'That is the most tanks the app can hold on this phone (' + MAX_TANKS + ').';
    err.hidden = false;
    return;
  }

  const tank = newTank({
    name, size: sizeRaw ? String(size) : '', unit, type,
    style: STYLES[type].includes(style) ? style : '',
    water, zip: water === 'city' ? zip : '', photo: setupPhoto
  });
  state.tanks.push(tank);
  if (!state.activeId || first) state.activeId = tank.id;
  state.setupDone = true;
  if (!saveState() && tank.photo) {
    tank.photo = '';
    saveState();
    toast('This phone is out of saved space, so the photo was left off.');
  }
  if (first) showView('home');
  else showTank(tank.id);
});

$('setup-skip').addEventListener('click', () => {
  if (state.setupDone) { showView('tanks'); return; }
  state.setupDone = true;
  saveState();
  showView('home');
});

// ---------- Home ----------
// Your own photo first, then the Wikipedia picture for known species, then the plain icon.
let thumbQueue = Promise.resolve();
function rowAvatar(f) {
  if (f.photo) return el('img', { class: 'avatar photo', src: f.photo, alt: '' });
  const icon = kindAvatar(rosterKind(f));
  const entry = lookupSpecies(f.name);
  if (!entry) return icon;
  const make = (found) => {
    const img = el('img', { class: 'avatar photo', src: found.src, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => { if (img.parentNode) img.replaceWith(kindAvatar(rosterKind(f))); });
    return img;
  };
  const cached = stockCached(entry, entry.n);
  if (cached) return make(cached);
  if (cached === 0) return icon;
  thumbQueue = thumbQueue.then(() => fetchStock(entry, entry.n)).then((found) => {
    if (found && icon.parentNode) icon.replaceWith(make(found));
  }, () => {});
  return icon;
}
function rosterKind(f) {
  const hit = lookupSpecies(f.name);
  const k = f.kind || (hit && hit.k) || 'fish';
  return KIND_LIST.includes(k) ? k : 'fish';
}
function kindTotals(t) {
  const sums = { fish: 0, plant: 0, other: 0 };
  t.fish.forEach((f) => {
    const k = rosterKind(f);
    sums[k === 'fish' ? 'fish' : k === 'plant' ? 'plant' : 'other'] += f.count;
  });
  return sums;
}



const FEATURES = [
  { icon: 'fish', color: 'teal', title: 'My Tanks', text: 'Fish, plants, stocking and tank mate checks', go: () => showView('tanks') },
  { icon: 'search', color: 'blue', title: 'Species guide', text: 'Look up care, size and good tank mates', go: () => openLookup() },
  { icon: 'drop', color: 'aqua', title: 'Water and tap info', text: 'Tap water and what it means for your tank', go: () => showView('water') },
  { icon: 'star', color: 'purple', title: 'Dream Tank', text: 'Picture the tank you want, fish and plants included', go: () => showView('dream') },
  { icon: 'strip', color: 'orange', title: 'Test strip reader', text: 'Photograph a strip and read your water', soon: true },
  { icon: 'chart', color: 'green', title: 'Water log', text: 'Track readings and spot trends', soon: true },
  { icon: 'bell', color: 'pink', title: 'Reminders', text: 'Water changes, feedings and filter care', soon: true },
  { icon: 'chat', color: 'blue', title: 'Ask the tank', text: 'Ask questions about your own tank', soon: true }
];
const FEATURE_ICONS = {
  fish: KIND_ICONS.fish,
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
  drop: ['M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z'],
  star: ['M12 3l2.6 5.6 6.1.8-4.5 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.3 9.4l6.1-.8z'],
  strip: ['M8 3h8v18H8z', 'M8 8h8', 'M8 12h8', 'M8 16h8'],
  chart: ['M4 20V4', 'M4 20h16', 'M8 15l4-4 3 3 5-6'],
  bell: ['M6 16V11a6 6 0 1 1 12 0v5l2 2H4z', 'M10 21h4'],
  chat: ['M4 5h16v11H9l-5 4z']
};
function featureIcon(name) {
  const svg = kindIcon('fish');
  svg.replaceChildren();
  (FEATURE_ICONS[name] || FEATURE_ICONS.fish).forEach((d) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  });
  return svg;
}

let lookupBox = null;
function openLookup() {
  const input = document.querySelector('#home-lookup .search-input');
  if (lookupBox) { lookupBox.scrollIntoView && lookupBox.scrollIntoView({ block: 'center' }); }
  if (input) input.focus();
}

function renderHome() {
  const tanks = $('home-tanks');
  tanks.replaceChildren();
  if (!state.tanks.length) {
    tanks.append(el('div', { class: 'card' },
      el('h2', { text: 'Add your first tank' }),
      el('p', { class: 'muted', text: 'Give it a name and a photo, and keep its fish, plants and corals in one place.' }),
      el('button', { type: 'button', class: 'btn primary small', text: 'Add a tank', onclick: startAddTank })));
  } else {
    const active = activeTank();
    state.tanks.forEach((t) => {
      const sums = kindTotals(t);
      const count = sums.fish + sums.plant + sums.other;
      tanks.append(el('button', { type: 'button', class: 'home-tank', 'aria-label': 'Open ' + tankLabel(t), onclick: () => { state.activeId = t.id; saveState(); showTank(t.id); } },
        t.photo ? el('img', { class: 'home-tank-pic', src: t.photo, alt: '' }) : el('span', { class: 'home-tank-pic empty' }, kindIcon('fish')),
        el('span', { class: 'home-tank-text' },
          el('strong', { text: tankLabel(t) }),
          el('span', { text: [tankSummary(t), count ? count + (count === 1 ? ' animal or plant' : ' animals and plants') : 'Empty so far'].filter(Boolean).join(' \u00b7 ') })),
        active && t.id === active.id && state.tanks.length > 1 ? el('span', { class: 'pill ok', text: 'Active' }) : null,
        chevron()));
    });
  }

  const box = $('home-features');
  box.replaceChildren(...FEATURES.map((f) => el('button', { type: 'button', class: 'feature ' + f.color + (f.soon ? ' soon' : ''), onclick: () => (f.soon ? toast(f.title + ' is coming soon.') : f.go()) },
    el('span', { class: 'feature-icon' }, featureIcon(f.icon)),
    el('span', { class: 'feature-text' }, el('strong', { text: f.title }), el('span', { text: f.text })),
    f.soon ? el('span', { class: 'soon-badge', text: 'Soon' }) : chevron())));

  if (!lookupBox) {
    const lookup = createSearch({
      placeholder: 'Look up any fish, plant or coral', label: 'Look up a species',
      type: () => { const t = activeTank(); return t ? t.type : 'Freshwater'; },
      onPick: (name) => { lookup.clear(); const t = activeTank(); showSpecies(name, t ? t.id : ''); }
    });
    lookupBox = el('div', { id: 'home-lookup', class: 'home-lookup' }, lookup.root);
  }
  if (lookupBox.parentNode !== box.parentNode) $('home-tanks').after(lookupBox);
}

$('home-scan').addEventListener('click', () => showView('scan'));

// ---------- Water ----------
function renderWater() {
  const text = $('water-tap-text');
  const t = activeTank();
  if (!t) {
    text.textContent = 'Add a tank in My Tanks to get tap water info.';
  } else if (t.water === 'well') {
    text.textContent = 'You use well water, so the best starting point is a test strip on your tap water. Tap water lookup is for city water.';
  } else if (t.water === 'ro') {
    text.textContent = 'You use RO or filtered water, so a test strip after you add minerals back is the best starting point. Tap water lookup is for city water.';
  } else if (t.zip) {
    text.textContent = 'ZIP ' + t.zip + ': hardness lookup and conditioner advice are coming in a later update.';
  } else {
    text.textContent = 'Add your ZIP code on your tank page to get tap water info in a later update.';
  }
}

// ---------- My Tanks (list) ----------
function renderTanks() {
  const box = $('tanks-list');
  box.replaceChildren();
  $('tanks-add').hidden = state.tanks.length >= MAX_TANKS;
  if (!state.tanks.length) {
    box.append(el('div', { class: 'card' },
      el('h2', { text: 'No tanks yet' }),
      el('p', { class: 'muted', text: 'Add a tank to keep its fish, plants, water and photos in one place.' }),
      el('button', { type: 'button', class: 'btn primary', text: 'Add your first tank', onclick: startAddTank })));
    return;
  }
  const active = activeTank();
  state.tanks.forEach((t) => {
    const photo = t.photo
      ? el('img', { class: 'tank-card-img', src: t.photo, alt: '', loading: 'lazy' })
      : el('span', { class: 'tank-card-img empty' }, kindIcon('fish'));
    const kinds = t.fish.length;
    box.append(el('button', { type: 'button', class: 'tank-card', onclick: () => showTank(t.id) },
      photo,
      el('span', { class: 'tank-card-body' },
        el('span', { class: 'tank-card-top' },
          el('strong', { class: 'name', text: tankLabel(t) }),
          t === active ? el('span', { class: 'badge', text: 'Active' }) : null),
        el('span', { class: 'tank-tags' }, ...[sizeShort(t), t.type, t.style].filter(Boolean).map((x) => el('span', { class: 'tag', text: x }))),
        el('span', { class: 'sub', text: kinds ? kinds + (kinds === 1 ? ' kind · ' : ' kinds · ') + totalFish(t) + ' in total' : 'No fish added yet' })
      )));
  });
}

$('tanks-add').addEventListener('click', startAddTank);

// ---------- One tank ----------
function chevron() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'chev');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  svg.append(path);
  return svg;
}

// A pill you tap to open a dropdown. The real <select> sits invisibly on top, so phones show their own picker.
function pillSelect(label, display, groups, current, onChange) {
  const select = el('select', { 'aria-label': label });
  groups.forEach((g) => {
    const parent = g.label ? el('optgroup', { label: g.label }) : select;
    g.options.forEach((o) => parent.append(el('option', { value: o.value, text: o.text })));
    if (g.label) select.append(parent);
  });
  select.value = current;
  select.addEventListener('change', () => onChange(select.value));
  return el('label', { class: 'pill-edit' },
    el('span', { class: 'k', text: label }),
    el('span', { class: 'v', text: display }),
    chevron(),
    select);
}

function todayString() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function datePill(t) {
  const input = el('input', { type: 'date', value: t.started, max: todayString(), 'aria-label': 'Running since' });
  input.addEventListener('click', () => { try { if (input.showPicker) input.showPicker(); } catch (err) { /* older browsers open it themselves */ } });
  input.addEventListener('change', () => {
    t.started = /^\d{4}-\d{2}-\d{2}$/.test(input.value) ? input.value : '';
    saveState();
    renderTank();
  });
  let shown = 'Not set';
  if (t.started) {
    const d = new Date(t.started + 'T00:00:00');
    if (!isNaN(d)) shown = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  return el('label', { class: 'pill-edit' },
    el('span', { class: 'k', text: 'Running since' }),
    el('span', { class: 'v', text: shown }),
    chevron(),
    input);
}

function sizePill(t) {
  if (editingSize) {
    const num = el('input', { type: 'number', class: 'pill-input', inputmode: 'decimal', min: 1, max: 5000, value: t.size, placeholder: '55', 'aria-label': 'Tank size' });
    const unit = el('select', { class: 'pill-unit', 'aria-label': 'Units' },
      el('option', { value: 'gallons', text: 'gal' }), el('option', { value: 'liters', text: 'L' }));
    unit.value = t.unit;
    const done = () => {
      const n = Number(num.value);
      if (!isFinite(n) || n <= 0 || n > 5000) { toast('Enter a size between 1 and 5000.'); return; }
      t.size = String(n);
      t.unit = unit.value;
      editingSize = false;
      saveState();
      renderTank();
    };
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } });
    return el('span', { class: 'pill-edit editing' },
      el('span', { class: 'k', text: 'Size' }), num, unit,
      el('button', { type: 'button', class: 'pill-ok', text: 'Set', onclick: done }),
      el('button', { type: 'button', class: 'pill-cancel', 'aria-label': 'Cancel', text: '×', onclick: () => { editingSize = false; renderTank(); } }));
  }
  const cur = t.size ? (t.unit === 'liters' ? 'l:' : 'g:') + t.size : '';
  const gal = SIZE_PRESETS.gallons.map((n) => ({ value: 'g:' + n, text: n + ' gal' }));
  const lit = SIZE_PRESETS.liters.map((n) => ({ value: 'l:' + n, text: n + ' L' }));
  const extra = cur && ![...gal, ...lit].some((o) => o.value === cur) ? [{ value: cur, text: sizeShort(t) }] : [];
  const groups = [
    { options: [{ value: '', text: 'Not set' }, ...extra] },
    { label: 'Gallons', options: gal },
    { label: 'Liters', options: lit },
    { options: [{ value: 'custom', text: 'Custom size…' }] }
  ];
  return pillSelect('Size', sizeShort(t) || 'Not set', groups, cur, (v) => {
    if (v === 'custom') { editingSize = true; renderTank(); return; }
    if (!v) t.size = '';
    else { t.unit = v.startsWith('l:') ? 'liters' : 'gallons'; t.size = v.slice(2); }
    saveState();
    renderTank();
  });
}

function renderTank() {
  const t = getTank(openTankId);
  if (!t) { showView('tanks'); return; }

  $('tank-hero').replaceChildren(t.photo
    ? el('img', { src: t.photo, alt: 'Photo of ' + tankLabel(t) })
    : el('div', { class: 'tank-hero-empty' }, kindIcon('fish'), el('span', { text: 'No photo yet' })));
  $('tank-photo-remove').hidden = !t.photo;
  $('tank-photo-camera').textContent = t.photo ? 'Retake' : 'Take photo';
  $('tank-photo-gallery').textContent = t.photo ? 'Change' : 'Choose photo';

  const nameInput = $('tank-title-input');
  if (document.activeElement !== nameInput) nameInput.value = t.name;

  const typeGroups = [{ options: TYPES.map((x) => ({ value: x, text: x })) }];
  const styleGroups = [{ options: [{ value: '', text: 'Not set' }, ...STYLES[t.type].map((x) => ({ value: x, text: x }))] }];
  const waterGroups = [{ options: WATER_SOURCES.map((x) => ({ value: x, text: WATER_NAMES[x] })) }];
  $('tank-pills').replaceChildren(
    sizePill(t),
    pillSelect('Type', t.type, typeGroups, t.type, (v) => {
      t.type = v;
      if (!STYLES[v].includes(t.style)) t.style = '';
      saveState();
      renderTank();
    }),
    pillSelect('Style', t.style || 'Not set', styleGroups, t.style, (v) => { t.style = v; saveState(); renderTank(); }),
    pillSelect('Water', WATER_SHORT[t.water], waterGroups, t.water, (v) => { t.water = v; saveState(); renderTank(); }),
    datePill(t)
  );

  $('tank-zip-row').hidden = t.water !== 'city';
  const zipInput = $('tank-zip-edit');
  if (document.activeElement !== zipInput) zipInput.value = t.zip;
  $('tank-zip-error').hidden = true;

  const notes = $('tank-notes');
  if (document.activeElement !== notes) notes.value = t.notes;

  const act = $('tank-active');
  act.replaceChildren();
  if (activeTank() === t) {
    act.append(el('div', { class: 'badge-row' }, el('span', { class: 'badge', text: 'Active' }), el('span', { class: 'sub', text: 'Shown on Home and used first for scans' })));
  } else {
    act.append(el('button', { type: 'button', class: 'btn small', text: 'Make this my active tank', onclick: () => { state.activeId = t.id; saveState(); renderTank(); } }));
  }

  const list = $('tank-list');
  list.replaceChildren();
  t.fish.forEach((f) => {
    const sci = usableScientific(lookupSpecies(f.name));
    list.append(
      el('div', { class: 'item' },
        rowAvatar(f),
        el('button', { type: 'button', class: 'row-main', 'aria-label': 'Details for ' + f.name, onclick: () => showSpecies(f.name, t.id) },
          el('span', { class: 'name', text: f.name }),
          sci ? el('span', { class: 'sub sci', text: sci }) : null),
        el('button', { type: 'button', class: 'round', 'aria-label': 'One fewer ' + f.name, text: '\u2212', onclick: () => changeCount(t, f, -1) }),
        el('span', { class: 'count', text: String(f.count) }),
        el('button', { type: 'button', class: 'round', 'aria-label': 'One more ' + f.name, text: '+', onclick: () => changeCount(t, f, 1) })
      )
    );
  });
  const ins = $('tank-insights');
  ins.replaceChildren(stockCard(t), mateCheckCard(t));
}

function changeCount(tank, fish, delta) {
  fish.count += delta;
  if (fish.count < 1) tank.fish = tank.fish.filter((f) => f !== fish);
  if (fish.count > 999) fish.count = 999;
  saveState();
  if (currentView === 'species') renderSpecies(); else renderTank();
}

$('tank-back').addEventListener('click', () => showView('tanks'));

$('tank-title-input').addEventListener('change', () => {
  const t = getTank(openTankId);
  if (!t) return;
  t.name = $('tank-title-input').value.trim().slice(0, 40);
  saveState();
});

$('tank-notes').addEventListener('change', () => {
  const t = getTank(openTankId);
  if (!t) return;
  t.notes = $('tank-notes').value.slice(0, 400);
  saveState();
});

$('tank-zip-edit').addEventListener('change', () => {
  const t = getTank(openTankId);
  if (!t) return;
  const v = $('tank-zip-edit').value.trim();
  if (v && !/^\d{5}$/.test(v)) { $('tank-zip-error').hidden = false; return; }
  $('tank-zip-error').hidden = true;
  t.zip = v;
  saveState();
});

function setTankPhoto(url) {
  const t = getTank(openTankId);
  if (!t) return;
  const old = t.photo;
  t.photo = url;
  if (!saveState()) {
    t.photo = old;
    toast('This phone is out of saved space for photos. Remove a photo from another tank and try again.');
  }
  renderTank();
}
wireTankPhotoInput('tank-photo-camera', 'tank-photo-camera-input', setTankPhoto);
wireTankPhotoInput('tank-photo-gallery', 'tank-photo-gallery-input', setTankPhoto);
$('tank-photo-remove').addEventListener('click', () => {
  const t = getTank(openTankId);
  if (!t) return;
  t.photo = '';
  saveState();
  renderTank();
});

const addSearch = createSearch({
  placeholder: 'Search to add a fish, plant or coral', label: 'Add a fish, plant or coral',
  type: () => { const t = getTank(openTankId); return t ? t.type : 'Freshwater'; },
  onPick: (name, entry) => {
    const t = getTank(openTankId);
    if (!t) return;
    addToTank(t, name, 1, 'add', entry ? entry.k : undefined);
    addSearch.clear();
    saveState();
    renderTank();
  }
});
$('add-slot').append(addSearch.root);

let deleteArmed = false;
let deleteTimer = null;
function resetDelete() {
  deleteArmed = false;
  clearTimeout(deleteTimer);
  $('tank-delete').textContent = 'Delete this tank';
}
$('tank-delete').addEventListener('click', () => {
  const t = getTank(openTankId);
  if (!t) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $('tank-delete').textContent = 'Tap again to delete this tank and its fish list';
    deleteTimer = setTimeout(resetDelete, 4000);
    return;
  }
  resetDelete();
  state.tanks = state.tanks.filter((x) => x !== t);
  if (state.activeId === t.id) state.activeId = state.tanks[0] ? state.tanks[0].id : '';
  saveState();
  showView('tanks');
});

// ---------- Scan ----------
function wirePhotoInput(buttonId, inputId) {
  $(buttonId).addEventListener('click', () => $(inputId).click());
  $(inputId).addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = ''; // lets the same photo be picked again
    if (file) startScan(file);
  });
}
wirePhotoInput('camera-btn', 'camera-input');
wirePhotoInput('gallery-btn', 'gallery-input');

$('rescan').addEventListener('click', () => showView('scan'));
$('add-photo').addEventListener('click', () => $('more-photo-input').click());
$('more-photo-input').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) startScan(file, true);
});
$('results-back').addEventListener('click', () => showView('scan'));

// Opens a photo from almost any format. Tries the browser first, then a converter for iPhone HEIC photos.
async function decodeWithBrowser(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => { if (bitmap.close) bitmap.close(); } };
    } catch (err) { /* fall through to the older method */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad_image')); };
    img.src = url;
  });
}

let heicLoader = null;
function loadHeicConverter() {
  if (window.HeicTo) return Promise.resolve(window.HeicTo);
  if (!heicLoader) {
    heicLoader = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'heic-to.js';
      tag.onload = () => (window.HeicTo ? resolve(window.HeicTo) : reject(new Error('bad_image')));
      tag.onerror = () => { heicLoader = null; reject(new Error('bad_image')); };
      document.head.appendChild(tag);
    });
  }
  return heicLoader;
}

async function loadImage(file) {
  try {
    return await decodeWithBrowser(file);
  } catch (firstError) {
    // The browser could not open it. Try converting (HEIC/HEIF from iPhones and some Android phones).
    try {
      const HeicTo = await loadHeicConverter();
      const jpeg = await HeicTo({ blob: file, type: 'image/jpeg', quality: 0.9 });
      return await decodeWithBrowser(jpeg);
    } catch (secondError) {
      throw new Error('bad_image');
    }
  }
}

function drawToJpeg(source, sx, sy, sw, sh, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs/GIFs become white instead of black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

// The first, cheap request: one sharp picture of the whole tank.
function makeSingle(image) {
  const sharp = drawToJpeg(image.source, 0, 0, image.width, image.height, SINGLE_SIDE, 0.8);
  const preview = drawToJpeg(image.source, 0, 0, image.width, image.height, MAX_PHOTO_SIDE, 0.82);
  return { images: [sharp.split(',')[1]], previewUrl: preview };
}

// ---------- Photo quality check (free, runs on the phone) ----------
// Only catches clearly dark or clearly blurry photos, so it never nags about a decent shot.
function photoQualityTip(image) {
  try {
    const w = 512;
    const h = Math.max(8, Math.round(w * image.height / image.width));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image.source, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    let total = 0;
    for (let i = 0; i < w * h; i++) {
      gray[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
      total += gray[i];
    }
    const brightness = total / (w * h);
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += lap;
        sumSq += lap * lap;
        n++;
      }
    }
    const mean = sum / (n || 1);
    const edges = sumSq / (n || 1) - mean * mean;
    if (brightness < 28) return 'This photo is very dark, so fish may be missed. Turn the tank light on and try again.';
    if (edges < 25) return 'This photo looks blurry, so fish may be missed. Hold steady, tap the tank on screen to focus, and try again.';
  } catch (err) { /* no canvas available: skip the check */ }
  return '';
}

function friendlyError(code, status) {
  switch (code) {
    case 'rate_limited': return 'Lots of scans right now. Wait a minute and try again.';
    case 'ai_busy': return 'The photo reader is busy. Try again in a moment.';
    case 'bad_image': return "That photo couldn't be read. Try a different one.";
    case 'too_large': return 'That photo is too large. Try a smaller one.';
    case 'server_not_configured': return 'The server is not set up yet. Check the Worker secret.';
    default: return status ? 'Something went wrong (' + status + '). Try again.' : 'Something went wrong. Try again.';
  }
}

async function askWorker(images, mode, timeoutMs, ctx) {
  ctx = ctx || {};
  const body = { images, mime: 'image/jpeg', mode, known: ctx.known || [] };
  if (ctx.tank_type) body.tank_type = ctx.tank_type;
  if (ctx.items) body.items = ctx.items;
  if (ctx.deep) body.deep = true;
  const res = await fetch(WORKER_URL + '/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error((data.error === 'ai_error' || data.error === 'ai_busy') && data.ai_detail !== undefined
      ? 'The photo reader had trouble (' + (data.ai_detail || 'error ' + data.ai_status) + '). Please try again in a moment.'
      : friendlyError(data.error, res.status));
  }
  return data;
}

function titleCase(text) {
  return text.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/'S\b/g, "'s");
}
function canonName(name) {
  const hit = lookupSpecies(name);
  return hit ? hit.n : String(name).trim().slice(0, 60);
}
function canonList(list) {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((n) => {
    const c = canonName(n || '');
    const k = canonKey(c);
    if (c && !seen.has(k)) { seen.add(k); out.push(c); }
  });
  return out;
}

// Fish that look alike get a tell-apart tip, and a photo alone can't be "Sure" about the hard groups.
// A look-alike already in the tank goes first in "Could also be".
function lookalikeGuard(sp) {
  if (!DB.ready || sp.kind === 'plant' || !sp.group || !DB.groups[sp.group]) return;
  const group = DB.groups[sp.group];
  const tank = getTank(pending && pending.tankId);
  const key = canonKey(sp.name);
  const members = DB.list.filter((e) => e.g === sp.group && normKey(e.n) !== key);
  const inTank = members.filter((e) => tank && tank.fish.some((f) => canonKey(f.name) === normKey(e.n)));
  const seen = new Set([key]);
  const alts = [];
  inTank.map((e) => e.n).concat(sp.alternatives || [], members.map((e) => e.n)).forEach((n) => {
    const k = canonKey(n);
    if (n && !seen.has(k)) { seen.add(k); alts.push(n); }
  });
  sp.alternatives = alts.slice(0, 3);
  sp.tankMatches = inTank.map((e) => e.n);
  if (group.h && !sp.verified) sp.confidence = Math.min(sp.confidence, inTank.length ? 0.7 : 0.8);
}

function mergeDuplicates() {
  const out = [];
  pending.species.forEach((sp) => {
    const same = out.find((o) => canonKey(o.name) === canonKey(sp.name) && o.kind === sp.kind);
    if (!same) { out.push(sp); return; }
    same.count = Math.min(999, same.count + sp.count);
    same.confidence = Math.max(same.confidence, sp.confidence);
    same.verified = same.verified || sp.verified;
    same.boxes = (same.boxes || []).concat(sp.boxes || []).slice(0, 3);
  });
  pending.species = out;
}

function applyResult(data, mode) {
  if (data.is_aquarium === false) {
    pending.error = "That doesn't look like an aquarium. Try a photo of your tank.";
  } else if (!data.species || !data.species.length) {
    pending.error = "Couldn't spot any fish, plants or corals. Try getting closer, with less glare.";
  }
  pending.species = (data.species || []).map((s) => {
    const hit = lookupSpecies(s.common_name);
    const kind = hit && KIND_LIST.includes(hit.k) ? hit.k : (s.kind || 'fish');
    return {
      name: hit ? hit.n : s.common_name,
      scientific: usableScientific(hit) || s.scientific_name || '',
      kind,
      group: hit && hit.g ? hit.g : '',
      count: s.count,
      confidence: s.confidence,
      alternatives: canonList(s.alternatives).filter((n) => canonKey(n) !== canonKey(hit ? hit.n : s.common_name)),
      boxes: Array.isArray(s.boxes) ? s.boxes : [],
      verified: false,
      editing: false
    };
  });
  mergeDuplicates();
  pending.species.forEach(lookalikeGuard);
  pending.tips = data.photo_tips || '';
  if (data.too_far && !pending.tips) pending.tips = 'Some fish look small here, so names may be off. Try again from closer, or photograph one end of the tank at a time.';
  pending.debug = data.model ? 'Read by ' + data.model + ' (' + (mode || data.mode) + ' scan' + (data.usage ? ', ' + data.usage.input + ' in, ' + data.usage.output + ' out tokens' : '') + ')' : '';
}

// ---------- Find, then zoom in ----------
const VERIFY_MAX = 6;
function needsVerify(sp) {
  const group = sp.group && DB.groups[sp.group];
  if (!(sp.kind === 'fish' || sp.kind === 'coral' || sp.kind === 'invert' || group)) return false;
  if (!sp.boxes || !sp.boxes.length) return false;
  return sp.confidence < 0.9 || !!(group && group.h) || !lookupSpecies(sp.name);
}

// Boxes are [ymin, xmin, ymax, xmax] from 0 to 1000. Pad them so the fish isn't cut off.
function cropRect(box, W, H) {
  let x1 = box[1] / 1000 * W, x2 = box[3] / 1000 * W, y1 = box[0] / 1000 * H, y2 = box[2] / 1000 * H;
  const padX = (x2 - x1) * 0.3, padY = (y2 - y1) * 0.3;
  x1 = Math.max(0, x1 - padX); x2 = Math.min(W, x2 + padX);
  y1 = Math.max(0, y1 - padY); y2 = Math.min(H, y2 + padY);
  return { x: x1, y: y1, w: Math.max(16, x2 - x1), h: Math.max(16, y2 - y1) };
}

// Up to three close-ups of the same kind of animal, side by side in one picture.
function makeMontage(image, boxes) {
  const tiles = boxes.slice().sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1])).slice(0, 3).map((box) => {
    const r = cropRect(box, image.width, image.height);
    const scale = Math.min(2.5, 480 / Math.max(r.w, r.h));
    return { r, w: Math.max(8, Math.round(r.w * scale)), h: Math.max(8, Math.round(r.h * scale)) };
  });
  const gap = 6;
  let width = tiles.reduce((sum, t) => sum + t.w, 0) + gap * (tiles.length - 1);
  const shrink = width > 1400 ? 1400 / width : 1;
  width = Math.round(width * shrink);
  const height = Math.round(Math.max(...tiles.map((t) => t.h)) * shrink);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, width, height);
  let x = 0;
  tiles.forEach((t) => {
    const dw = Math.round(t.w * shrink), dh = Math.round(t.h * shrink);
    ctx.drawImage(image.source, t.r.x, t.r.y, t.r.w, t.r.h, x, 0, dw, dh);
    x += dw + Math.round(gap * shrink);
  });
  return canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
}

function applyVerified(targets, data) {
  (data.items || []).forEach((it) => {
    const sp = targets[it.index];
    if (!sp) return;
    if (it.confidence >= 0.45 && !/^unidentified/i.test(it.common_name)) {
      const hit = lookupSpecies(it.common_name);
      sp.name = hit ? hit.n : it.common_name;
      sp.scientific = usableScientific(hit) || it.scientific_name || '';
      if (hit && KIND_LIST.includes(hit.k)) sp.kind = hit.k;
      sp.group = hit && hit.g ? hit.g : '';
      sp.confidence = it.confidence;
      sp.alternatives = canonList(it.alternatives).filter((n) => canonKey(n) !== canonKey(sp.name));
      sp.verified = true;
    } else {
      sp.confidence = Math.min(sp.confidence, 0.5); // the close-ups didn't back up the first guess
    }
  });
  mergeDuplicates();
  pending.species.forEach(lookalikeGuard);
}

function showScanError(err) {
  if (err && err.name === 'TimeoutError') pending.error = 'That took too long. Try again, or try a smaller or clearer photo.';
  else if (err instanceof TypeError) pending.error = "Couldn't reach the server. Check your connection and try again.";
  else if (err.message === 'bad_image') pending.error = "This device couldn't open that photo. Try the Take a photo button, or pick a different picture.";
  else pending.error = err.message || friendlyError();
}

// Several photos of one tank add up to one list: the same species keeps its highest count.
function mergeSessions(prior, fresh) {
  const out = prior.slice();
  fresh.forEach((sp) => {
    const same = out.find((o) => canonKey(o.name) === canonKey(sp.name) && o.kind === sp.kind);
    if (!same) { out.push(sp); return; }
    same.count = Math.max(same.count, sp.count);
    if (sp.verified && !same.verified) { same.confidence = sp.confidence; same.verified = true; same.scientific = sp.scientific || same.scientific; }
    else same.confidence = Math.max(same.confidence, sp.confidence);
  });
  return out;
}

async function startScan(file, append) {
  const target = activeTank();
  const more = !!(append && pending && pending.species && pending.species.length);
  const priorSpecies = more ? pending.species : [];
  const priorPhotos = more ? (pending.photos || 1) : 0;
  const tankId = more && getTank(pending.tankId) ? pending.tankId : (target ? target.id : '');
  const scanTank = getTank(tankId) || target;
  pending = { photoUrl: more ? pending.photoUrl : '', species: [], tips: '', loading: true, error: '', note: '', tankId, photos: priorPhotos };
  // Tell the AI what this tank already has, plus anything found in earlier photos of this session.
  const known = [];
  (scanTank ? scanTank.fish.map((f) => f.name) : []).concat(priorSpecies.filter((sp) => sp.kind !== 'plant').map((sp) => sp.name)).forEach((n) => {
    if (n && known.indexOf(n) === -1 && known.length < 40) known.push(n);
  });
  showView('results');
  renderResults();

  let image = null;
  let qualityTip = '';
  try {
    image = await loadImage(file);
    qualityTip = photoQualityTip(image);
    const single = makeSingle(image);
    pending.photoUrl = single.previewUrl;
    renderResults();

    const ctx = { known, tank_type: scanTank && TYPES.includes(scanTank.type) ? scanTank.type : '' };
    const data = await askWorker(single.images, 'single', 60000, ctx);
    applyResult(data, 'single');

    const targets = pending.species.filter(needsVerify).sort((a, b) => a.confidence - b.confidence).slice(0, VERIFY_MAX);
    if (targets.length) {
      pending.loadingNote = 'Zooming in on the fish that are hard to tell apart\u2026';
      renderResults();
      try {
        const montages = targets.map((sp) => makeMontage(image, sp.boxes));
        const items = targets.map((sp) => ({ name: sp.name, kind: sp.kind, count: sp.count, alternatives: sp.alternatives }));
        const checked = await askWorker(montages, 'verify', 75000, Object.assign({ items }, ctx));
        applyVerified(targets, checked);
        if (checked.usage) pending.debug += '; zoom-in check on ' + targets.length + ': ' + checked.usage.input + ' in, ' + checked.usage.output + ' out';
      } catch (verifyError) {
        // Keep the first look if the closer look fails.
      }
    }
    if (qualityTip) pending.tips = pending.tips ? pending.tips + ' ' + qualityTip : qualityTip;
  } catch (err) {
    showScanError(err);
  } finally {
    if (image) image.done();
  }
  if (more) {
    if (pending.error) {
      // The new photo failed or showed nothing: keep what the earlier photos found.
      pending.tips = 'The last photo could not be added. ' + pending.error;
      pending.error = '';
      pending.species = priorSpecies;
      pending.photos = priorPhotos;
    } else {
      pending.species = mergeSessions(priorSpecies, pending.species);
      pending.photos = priorPhotos + 1;
    }
  } else {
    pending.photos = pending.error ? 0 : 1;
  }
  pending.loading = false;
  renderResults();
}

function confidenceLabel(c) {
  if (c >= 0.85) return ['Confident', 'ok'];
  if (c >= 0.6) return ['Likely', 'warn'];
  return ['Unsure', 'bad'];
}

const LOADING_STEPS = [
  'Reading your photo…',
  'Identifying each species…',
  'Counting what\'s in the tank…',
  'Almost there…'
];
let loadingTimer = null;

function renderResults() {
  if (!pending) return;
  const photo = $('results-photo');
  photo.hidden = !pending.photoUrl;
  if (pending.photoUrl) photo.src = pending.photoUrl;

  const status = $('results-status');
  status.replaceChildren();
  const list = $('results-list');
  list.replaceChildren();
  $('results-note').hidden = true;
  $('results-actions').hidden = true;
  $('add-photo').hidden = true;
  $('results-target').hidden = true;

  if (pending.loading) {
    $('results-title').textContent = 'Looking at your tank…';
    const msg = el('span', { text: pending.loadingNote || LOADING_STEPS[0] });
    status.append(el('div', { class: 'status-card' }, el('div', { class: 'spinner' }), msg));
    for (let i = 0; i < 3; i++) {
      list.append(el('div', { class: 'skeleton' },
        el('div', { class: 'dot' }),
        el('div', { class: 'lines' }, el('div', { class: 'bar' }), el('div', { class: 'bar short' }))));
    }
    clearInterval(loadingTimer);
    let step = 0;
    loadingTimer = setInterval(() => {
      if (!msg.isConnected || !pending || !pending.loading) { clearInterval(loadingTimer); return; }
      if (pending.loadingNote) { msg.textContent = pending.loadingNote; return; }
      step = Math.min(step + 1, LOADING_STEPS.length - 1);
      msg.textContent = LOADING_STEPS[step];
    }, 2800);
    return;
  }

  if (pending.error) {
    $('results-title').textContent = 'No results';
    status.append(el('div', { class: 'status-card bad' }, el('span', { text: pending.error })));
    $('results-actions').hidden = false;
    $('save-scan').hidden = true;
    return;
  }

  const n = pending.species.length;
  $('results-title').textContent = (n === 1 ? 'Found 1 kind' : 'Found ' + n + ' kinds') + (pending.photos > 1 ? ' in ' + pending.photos + ' photos' : '');
  $('add-photo').hidden = false;
  if (pending.debug) status.append(el('p', { class: 'debug', text: pending.debug }));
  if (pending.tips) status.append(el('div', { class: 'status-card tip' }, el('span', { text: 'Tip: ' + pending.tips })));

  if (!getTank(pending.tankId)) pending.tankId = activeTank() ? activeTank().id : '';
  pending.species.forEach((sp, index) => list.append(sp.editing ? editRow(sp, index) : resultRow(sp)));
  $('results-note').hidden = false;
  $('results-actions').hidden = false;
  $('save-scan').hidden = n === 0;

  // With more than one tank, let the person choose where this scan goes.
  if (state.tanks.length > 1) {
    const sel = $('results-tank');
    sel.replaceChildren(...state.tanks.map((x) => el('option', { value: x.id, text: tankLabel(x) })));
    sel.value = pending.tankId;
    $('results-target').hidden = false;
  }
}

$('results-tank').addEventListener('change', () => {
  if (!pending) return;
  pending.tankId = $('results-tank').value;
  renderResults();
});

function inTankHint(sp) {
  const target = getTank(pending && pending.tankId);
  const have = target && target.fish.find((f) => canonKey(f.name) === canonKey(sp.name));
  if (!have) return el('span', { class: 'hint-new', text: 'New to your tank' });
  return el('span', { class: 'hint-have', text: have.count >= sp.count ? 'Already in your tank (' + have.count + ')' : 'Raises your count from ' + have.count });
}

function resultRow(sp) {
  const [label, tone] = confidenceLabel(sp.confidence);
  const alts = (sp.alternatives || []).filter((n) => n && n.toLowerCase() !== sp.name.toLowerCase());
  const altRow = alts.length && sp.confidence < 0.9
    ? el('div', { class: 'alts' },
        el('span', { class: 'sub', text: 'Could also be:' }),
        ...alts.map((n) => el('button', {
          type: 'button', class: 'alt-chip', text: n + ((sp.tankMatches || []).includes(n) ? ' · in your tank' : ''),
          onclick: () => { const hit = lookupSpecies(n); sp.name = n; sp.scientific = usableScientific(hit); if (hit && KIND_LIST.includes(hit.k)) sp.kind = hit.k; sp.group = hit && hit.g ? hit.g : ''; sp.alternatives = []; sp.confidence = 1; sp.verified = true; renderResults(); }
        })))
    : null;
  const grp = sp.group && DB.groups[sp.group];
  const tellRow = grp && grp.tip && sp.confidence < 0.95
    ? el('details', { class: 'tell' }, el('summary', { text: 'How to tell them apart' }), el('p', { text: grp.tip }))
    : null;
  return el('div', { class: 'item' },
    kindAvatar(sp.kind),
    el('div', { class: 'grow' },
      el('span', { class: 'name', text: sp.name + (sp.count > 1 ? '\u00a0×\u00a0' + sp.count : '') }),
      inTankHint(sp),
      el('div', { class: 'meta' },
        el('span', { class: 'pill ' + tone, text: label }),
        sp.scientific ? el('span', { class: 'sub sci', text: sp.scientific }) : (sp.kind ? el('span', { class: 'sub', text: sp.kind }) : null)
      ),
      altRow,
      tellRow
    ),
    el('button', { type: 'button', class: 'btn small', text: 'Edit', onclick: () => { sp.editing = true; renderResults(); } })
  );
}

function editRow(sp, index) {
  const searchBox = createSearch({
    placeholder: 'Search by name', label: 'Name', value: sp.name,
    type: () => { const t = getTank(pending && pending.tankId); return t ? t.type : 'Freshwater'; },
    onPick: (name) => { searchBox.input.value = name; searchBox.close(); }
  });
  const nameInput = searchBox.input;
  const countInput = el('input', { type: 'number', value: sp.count, min: 1, max: 999, 'aria-label': 'How many', style: 'max-width: 90px' });
  return el('div', { class: 'item edit-row' },
    searchBox.root,
    countInput,
    el('button', {
      type: 'button', class: 'btn small primary', text: 'Done',
      onclick: () => {
        const name = nameInput.value.trim();
        const count = Math.round(Number(countInput.value));
        if (name) { const hit = lookupSpecies(name); sp.name = hit ? hit.n : name.slice(0, 60); sp.group = hit && hit.g ? hit.g : ''; if (hit && KIND_LIST.includes(hit.k)) sp.kind = hit.k; }
        if (count >= 1 && count <= 999) sp.count = count;
        sp.confidence = 1; // the user checked it
        sp.editing = false;
        renderResults();
      }
    }),
    el('button', {
      type: 'button', class: 'btn small', text: 'Remove',
      onclick: () => { pending.species.splice(index, 1); renderResults(); }
    })
  );
}

$('save-scan').addEventListener('click', () => {
  if (!pending) return;
  const target = getTank(pending.tankId) || ensureTank();
  pending.species.forEach((sp) => addToTank(target, sp.name, sp.count, 'scan', sp.kind));
  saveState();
  pending = null;
  showTank(target.id);
});

// ---------- Care data, tank mate check and stocking ----------
const TEMPER = { p: 'Peaceful', s: 'Semi-aggressive', a: 'Aggressive' };
const DIET = { o: 'Eats most things', c: 'Meat eater', h: 'Plant and algae eater', p: 'Filter feeder' };
const ZONE_FISH = { t: 'Top of the tank', m: 'Middle of the tank', b: 'Bottom of the tank', a: 'All levels' };
const ZONE_PLANT = { f: 'Foreground', m: 'Midground', k: 'Background', x: 'Floating', a: 'Tied to wood or rock' };
const LEVEL = { e: 'Beginner friendly', m: 'Some experience', h: 'Experienced keepers' };

function hasTag(e, tag) { return !!(e && e.c && e.c.x && e.c.x.indexOf(tag) !== -1); }
function careOf(name) { const e = lookupSpecies(name); return e && e.c ? e : null; }
function isMobile(e) { return e.k === 'fish' || e.k === 'shrimp' || e.k === 'snail' || (e.k === 'invert' && !hasTag(e, 'sting')); }
function sharesWater(a, b) { return [...a.w].some((c) => b.w.indexOf(c) !== -1); }
function rangeGap(r1, r2) { return Math.max(0, Math.max(r1[0], r2[0]) - Math.min(r1[1], r2[1])); }
function tankGallons(t) {
  const n = parseFloat(t && t.size);
  if (!(n > 0)) return 0;
  return t.unit === 'liters' ? n / 3.785 : n;
}

// One animal's effect on another (only the direction given).
function directional(x, y) {
  const out = [];
  const xs = x.c.z, ys = y.c.z;
  if (hasTag(x, 'pred') && y.k === 'fish' && ys <= xs / 2) out.push({ level: 'bad', text: x.n + ' will likely eat ' + y.n });
  else if (hasTag(x, 'opp') && y.k === 'fish' && ys <= xs / 3.2) out.push({ level: 'warn', text: x.n + ' may eat ' + y.n + ' once it is grown' });
  if (hasTag(x, 'shrimp') && y.k === 'shrimp') out.push({ level: 'bad', text: x.n + ' hunts shrimp, so ' + y.n + ' will not last' });
  if (hasTag(x, 'snail') && y.k === 'snail') out.push({ level: 'warn', text: x.n + ' eats snails such as ' + y.n });
  if (hasTag(x, 'nip') && y.k === 'fish' && hasTag(y, 'longfin')) out.push({ level: 'warn', text: x.n + ' may nip the fins of ' + y.n });
  if (x.k === 'fish' && y.k === 'fish' && x.c.m === 'a' && y.c.m === 'p' && ys <= xs * 1.5 && !hasTag(x, 'pred')) out.push({ level: 'warn', text: x.n + ' is aggressive and may bully ' + y.n });
  const prey = y.k === 'coral' || y.k === 'invert' || y.k === 'shrimp' || y.k === 'snail';
  if (hasTag(x, 'reefunsafe') && prey) out.push({ level: 'bad', text: x.n + ' eats or damages ' + y.n });
  else if (hasTag(x, 'reefrisk') && prey) out.push({ level: 'warn', text: x.n + ' may nibble on ' + y.n });
  if (hasTag(x, 'sting') && y.k === 'coral') out.push({ level: 'warn', text: x.n + ' can sting ' + y.n + ' if they touch, so leave space between them' });
  if (hasTag(x, 'eatsplants') && y.k === 'plant' && y.c.y !== 'a') out.push({ level: 'warn', text: x.n + ' may eat ' + y.n });
  return out;
}

function pairIssues(a, b) {
  if (!a || !b || a === b || !a.c || !b.c) return [];
  if (a.k === 'plant' && b.k === 'plant') return [];
  const out = [];
  if (!sharesWater(a, b)) {
    out.push({ level: 'bad', text: a.n + ' and ' + b.n + ' need different water (freshwater vs saltwater)' });
    return out;
  }
  if (a.k !== 'plant' && b.k !== 'plant') {
    const tg = rangeGap(a.c.t, b.c.t);
    const range = (e) => Math.round(e.c.t[0]) + '-' + Math.round(e.c.t[1]) + '°F';
    if (tg > 6) out.push({ level: 'bad', text: a.n + ' (' + range(a) + ') and ' + b.n + ' (' + range(b) + ') want very different temperatures' });
    else if (tg >= 3) out.push({ level: 'warn', text: a.n + ' (' + range(a) + ') and ' + b.n + ' (' + range(b) + ') like different temperatures' });
    const pg = rangeGap(a.c.p, b.c.p);
    if (pg > 1.0) out.push({ level: 'bad', text: a.n + ' and ' + b.n + ' want very different water (pH ' + a.c.p[0] + '-' + a.c.p[1] + ' vs ' + b.c.p[0] + '-' + b.c.p[1] + ')' });
    else if (pg > 0.5) out.push({ level: 'warn', text: a.n + ' and ' + b.n + ' prefer different pH (' + a.c.p[0] + '-' + a.c.p[1] + ' vs ' + b.c.p[0] + '-' + b.c.p[1] + ')' });
  }
  out.push(...directional(a, b), ...directional(b, a));
  if (a.g && a.g === b.g && hasTag(a, 'terr') && hasTag(b, 'terr') && a.g !== 'cichmal' && a.g !== 'tanganyika') {
    out.push({ level: 'warn', text: a.n + ' and ' + b.n + ' are territorial relatives and may fight' });
  }
  return out;
}

// Things about one species in this tank: tank size and group size.
function singleIssues(e, count, gal) {
  const out = [];
  if (e.k === 'plant' || !e.c) return out;
  if (gal && e.c.g > gal) out.push({ level: 'bad', text: e.n + ' needs a tank of at least ' + e.c.g + ' gallons' });
  if (e.c.s >= 3 && count < e.c.s && (e.k === 'fish' || e.k === 'shrimp')) out.push({ level: 'warn', text: e.n + ' do best in groups of ' + e.c.s + ' or more (you have ' + count + ')' });
  if (count > 1 && e.k === 'fish' && hasTag(e, 'terr') && e.c.s <= 1 && e.g !== 'cfish' && gal && gal < e.c.g * count * 2) {
    out.push({ level: 'warn', text: 'Several ' + e.n + ' may fight in a tank this size' });
  }
  return out;
}

function tankCheck(t) {
  const gal = tankGallons(t);
  const items = t.fish.map((f) => ({ f, e: careOf(f.name) })).filter((x) => x.e);
  const issues = [];
  const seen = new Set();
  const push = (names, list) => list.forEach((i) => {
    if (seen.has(i.text)) return;
    seen.add(i.text);
    issues.push({ level: i.level, text: i.text, names });
  });
  items.forEach((it) => push([it.e.n], singleIssues(it.e, it.f.count, gal)));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) push([items[i].e.n, items[j].e.n], pairIssues(items[i].e, items[j].e));
  }
  issues.sort((p, q) => (p.level === q.level ? 0 : p.level === 'bad' ? -1 : 1));
  return { issues, checked: items.length, unknown: t.fish.length - items.length };
}

function stocking(t) {
  const gal = tankGallons(t);
  let load = 0, skipped = 0, known = 0, need = 0, needName = '', needOwn = 0;
  t.fish.forEach((f) => {
    const e = careOf(f.name);
    if (!e) { skipped++; return; }
    known++;
    let mine = 0;
    if (e.k === 'fish') mine = f.count * e.c.z * (hasTag(e, 'heavy') ? 2 : 1);
    else if (isMobile(e)) mine = f.count * e.c.z * 0.25;
    load += mine;
    if (e.k !== 'plant' && e.c.g > 0 && e.c.g / (gal || 1) > need / (gal || 1)) { need = e.c.g; needName = e.n; needOwn = mine; }
  });
  const factor = t.type === 'Saltwater' ? 0.4 : t.type === 'Brackish' ? 0.7 : 1;
  const cap = gal * factor;
  // The fish that needs the biggest tank takes at least its minimum tank's share; everything else adds on top.
  const byInches = cap ? load / cap : 0;
  // Once a tank meets a fish's minimum it is workable, not full, so the minimum counts for three quarters of its share.
  const needShare = gal && need ? (need > gal ? need / gal : (need / gal) * 0.75) : 0;
  const pct = cap ? (load - needOwn) / cap + Math.max(needOwn / cap, needShare) : 0;
  const tooSmall = gal && need > gal ? { name: needName, gal: need, big: true } : (need / gal >= 0.6 ? { name: needName, gal: need, big: false } : null);
  return { gal, load, cap, pct: Math.max(pct, byInches), skipped, known, tooSmall };
}
function stockLevel(pct) {
  if (pct <= 0.55) return { label: 'Room to grow', tone: 'low', hint: 'Plenty of room to add more.' };
  if (pct <= 0.85) return { label: 'Comfortable', tone: 'ok', hint: 'A comfortable load for this size tank.' };
  if (pct <= 1.0) return { label: 'Getting full', tone: 'full', hint: 'Getting full. Add new fish slowly.' };
  if (pct <= 1.25) return { label: 'Fully stocked', tone: 'high', hint: 'Fully stocked. Good filtration and regular water changes matter.' };
  return { label: 'Overstocked', tone: 'over', hint: 'Too many fish for this tank over time.' };
}

// A slim bar with a mark where the tank is full.
function stockBar(t) {
  const s = stocking(t);
  const box = el('div', { class: 'stock' });
  if (!s.gal) { box.append(el('p', { class: 'muted small', text: 'Add your tank size on the tank page to see how full it is.' })); return box; }
  if (!s.known) { box.append(el('p', { class: 'muted small', text: 'Add fish to see how full this tank is.' })); return box; }
  const lvl = stockLevel(s.pct);
  const fill = Math.max(2, Math.min(s.pct, 1) * 100);
  const over = s.pct > 1 ? Math.round((s.pct - 1) * 100) : 0;
  box.append(
    el('div', { class: 'stock-top' },
      el('strong', { text: lvl.label }),
      el('span', { class: 'stock-pct', text: over ? over + '% over capacity' : Math.round(s.pct * 100) + '% of capacity' })),
    el('div', { class: 'stock-track', role: 'img', 'aria-label': lvl.label + ', ' + Math.round(s.pct * 100) + ' percent of capacity' },
      el('div', { class: 'stock-fill ' + lvl.tone, style: 'width:' + fill.toFixed(1) + '%' }),
      el('div', { class: 'stock-mark' })),
    el('div', { class: 'stock-scale' }, el('span', { text: 'Empty' }), el('span', { class: 'stock-full', text: 'Full' })),
    el('p', { class: 'muted small', text: (s.tooSmall ? s.tooSmall.name + ' needs at least ' + s.tooSmall.gal + ' gallons' + (s.tooSmall.big ? ', which is more than this tank holds.' : ', so it takes up much of this tank.') : lvl.hint) + ' An estimate from adult sizes.' + (s.skipped ? ' ' + s.skipped + ' not counted (no size data).' : '') })
  );
  return box;
}

let mateShowAll = false;
function mateCheckCard(t) {
  const r = tankCheck(t);
  const bad = r.issues.some((i) => i.level === 'bad');
  const chip = !r.issues.length
    ? el('span', { class: 'pill ok', text: 'All clear' })
    : el('span', { class: 'pill ' + (bad ? 'bad' : 'warn'), text: r.issues.length + (r.issues.length === 1 ? ' thing to look at' : ' things to look at') });
  const shown = mateShowAll ? r.issues : r.issues.slice(0, 5);
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'Tank mate check' }), chip));
  if (!t.fish.length) card.append(el('p', { class: 'muted small', text: 'Add fish and I will check how they get along.' }));
  else if (!r.issues.length) card.append(el('p', { class: 'muted small', text: r.checked ? 'No problems found between the ' + r.checked + ' kinds I could check.' : 'None of these names are in the species list yet, so nothing could be checked.' }));
  shown.forEach((i) => card.append(
    el('button', { type: 'button', class: 'issue ' + i.level, onclick: () => showSpecies(i.names[0], t.id) },
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', { class: 'issue-text', text: i.text }))
  ));
  if (r.issues.length > 5) card.append(el('button', { type: 'button', class: 'btn small', text: mateShowAll ? 'Show fewer' : 'Show all ' + r.issues.length, onclick: () => { mateShowAll = !mateShowAll; renderTank(); } }));
  if (r.issues.length || r.unknown) {
    card.append(el('p', { class: 'muted small', text: 'General guidance, and every fish is different.' + (r.unknown ? ' ' + r.unknown + ' not in the species list, so not checked.' : '') }));
  }
  return card;
}

// ---------- Species page ----------
let speciesView = null;      // { name, tankId }
let speciesStack = [];
let speciesOrigin = 'tank';
let speciesOriginTank = '';

function showSpecies(name, tankId, fromChip) {
  if (fromChip && speciesView) speciesStack.push(speciesView);
  else { speciesStack = []; speciesOrigin = currentView === 'home' ? 'home' : currentView === 'dream' ? 'dream' : currentView === 'fishcheck' ? 'fishcheck' : 'tank'; speciesOriginTank = tankId || openTankId || ''; }
  speciesView = { name, tankId: tankId || '' };
  showView('species');
}
$('species-back').addEventListener('click', () => {
  if (speciesStack.length) { speciesView = speciesStack.pop(); showView('species'); return; }
  if (speciesOrigin === 'home') showView('home');
  else if (speciesOrigin === 'dream') showView('dream');
  else if (speciesOrigin === 'fishcheck') showView('fishcheck');
  else if (getTank(speciesOriginTank)) showTank(speciesOriginTank);
  else showView('tanks');
});

// Stock photos come from Wikipedia by name, with a link back to the page for credit.
let stockSaved = {};
try { stockSaved = JSON.parse(localStorage.getItem('schooled.stock') || '{}') || {}; } catch (err) { stockSaved = {}; }
function saveStock(key, value) {
  if (Object.keys(stockSaved).length > 150) stockSaved = {};
  stockSaved[key] = value;
  try { localStorage.setItem('schooled.stock', JSON.stringify(stockSaved)); } catch (err) { /* cache is optional */ }
}
// Cached Wikipedia picture: the photo if we have one, 0 if every title is known to have none, undefined if unknown.
function stockCached(entry, name) {
  const titles = [usableScientific(entry), entry ? entry.n : name].filter(Boolean);
  let unknown = false;
  for (const title of titles) {
    const v = stockSaved[normKey(title)];
    if (v) return v;
    if (v === undefined) unknown = true;
  }
  return unknown ? undefined : 0;
}
async function fetchStock(entry, name) {
  const titles = [usableScientific(entry), entry ? entry.n : name].filter(Boolean);
  for (const title of titles) {
    const key = normKey(title);
    if (stockSaved[key] !== undefined) { if (stockSaved[key]) return stockSaved[key]; continue; }
    try {
      const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')), { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = await res.json();
        if (j && j.type === 'standard' && j.thumbnail && /^https:\/\//.test(j.thumbnail.source || '')) {
          const found = { src: j.thumbnail.source, page: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || '' };
          saveStock(key, found);
          return found;
        }
        saveStock(key, 0);
      } else if (res.status === 404) saveStock(key, 0);
    } catch (err) { /* offline: try again next time */ }
  }
  return null;
}

function rosterRow(t, name) {
  return t ? t.fish.find((f) => canonKey(f.name) === canonKey(name)) : null;
}

function factRow(label, value) {
  return el('div', { class: 'fact' }, el('span', { class: 'fact-label', text: label }), el('span', { class: 'fact-value', text: value }));
}
function speciesFacts(e) {
  const c = e.c;
  const temp = Math.round(c.t[0]) + '-' + Math.round(c.t[1]) + '°F';
  const ph = c.p[0] + '-' + c.p[1];
  if (e.k === 'plant') {
    const light = hasTag(e, 'highlight') ? 'Bright light' : hasTag(e, 'lowlight') ? 'Low light' : 'Medium light';
    return [['Height', 'Up to ' + c.z + ' in'], ['Placement', ZONE_PLANT[c.y] || 'Anywhere'], ['Light', light], ['CO2', hasTag(e, 'co2') ? 'Helps a lot' : 'Not needed'], ['Growth', hasTag(e, 'fast') ? 'Fast' : 'Slow to medium'], ['Temperature', temp], ['pH', ph], ['Care level', LEVEL[c.l]]];
  }
  if (e.k === 'coral') {
    return [['Size', 'Up to ' + c.z + ' in'], ['Smallest tank', c.g + ' gal'], ['Temperature', temp], ['pH', ph], ['Stings neighbors', hasTag(e, 'sting') ? 'Yes, leave space' : 'Not much'], ['Care level', LEVEL[c.l]]];
  }
  const rows = [['Adult size', c.z + ' in'], ['Smallest tank', c.g + ' gal'], ['Temperature', temp], ['pH', ph]];
  if (TEMPER[c.m]) rows.push(['Temperament', TEMPER[c.m]]);
  if (c.f) rows.push(['Eats', c.f]);
  else if (DIET[c.d]) rows.push(['Diet', DIET[c.d]]);
  if (ZONE_FISH[c.y]) rows.push(['Lives in', ZONE_FISH[c.y]]);
  if (e.k === 'fish' || e.k === 'shrimp') rows.push(['Group size', c.s > 1 ? c.s + ' or more' : 'Fine on its own']);
  rows.push(['Care level', LEVEL[c.l]]);
  return rows;
}

function issueList(list) {
  return el('div', { class: 'issues' }, ...list.map((i) => el('div', { class: 'issue static ' + i.level }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'issue-text', text: i.text }))));
}

function speciesPhotoBox(entry, name, f, t) {
  const box = el('div', { class: 'photo-box species-photo' });
  const credit = el('p', { class: 'muted small photo-credit' });
  const wrap = el('div', { class: 'species-photo-wrap' }, box, credit);
  const icon = () => el('div', { class: 'tank-hero-empty' }, kindIcon(entry && entry.k ? entry.k : 'fish'), el('span', { text: 'No photo yet' }));
  if (f && f.photo) {
    box.append(el('img', { src: f.photo, alt: 'Your ' + name }));
    credit.textContent = 'Your photo';
  } else {
    box.append(icon());
    const shownFor = speciesView && speciesView.name;
    fetchStock(entry, name).then((found) => {
      if (!found || !speciesView || speciesView.name !== shownFor || (f && f.photo)) return;
      box.replaceChildren(el('img', { src: found.src, alt: name, loading: 'lazy' }));
      credit.replaceChildren(document.createTextNode('Photo from Wikipedia. It may be a different color form. '),
        found.page ? el('a', { href: found.page, target: '_blank', rel: 'noopener noreferrer', text: 'Credits' }) : '');
    });
  }
  return wrap;
}

function renderSpecies() {
  const body = $('species-body');
  body.replaceChildren();
  if (!speciesView) { showView('home'); return; }
  const t = getTank(speciesView.tankId) || activeTank();
  const entry = lookupSpecies(speciesView.name);
  const name = entry ? entry.n : speciesView.name;
  const f = rosterRow(t, name);
  const gal = tankGallons(t);

  // Photo and photo buttons
  body.append(speciesPhotoBox(entry, name, f, t));
  if (f) {
    const wire = (input) => input.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        f.photo = await photoFromFile(file, SPECIES_PHOTO_SIDE);
        if (!saveState()) { f.photo = ''; return; }
        renderSpecies();
      } catch (err) { toast("This device couldn't open that photo. Try another one."); }
    });
    const cam = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    const gal2 = el('input', { type: 'file', accept: 'image/*,.heic,.heif,.avif,.webp,.bmp,.gif,.tif,.tiff', hidden: true });
    wire(cam); wire(gal2);
    body.append(el('div', { class: 'row photo-actions' },
      el('button', { type: 'button', class: 'btn small', text: f.photo ? 'Retake' : 'Take photo', onclick: () => cam.click() }),
      el('button', { type: 'button', class: 'btn small', text: f.photo ? 'Change' : 'Choose photo', onclick: () => gal2.click() }),
      f.photo ? el('button', { type: 'button', class: 'btn small', text: 'Use stock photo', onclick: () => { f.photo = ''; saveState(); renderSpecies(); } }) : null),
      cam, gal2);
  }

  // Name and tags
  body.append(
    el('h1', { class: 'species-title', text: name }),
    entry && usableScientific(entry) ? el('p', { class: 'muted sci', text: entry.s }) : null);
  if (entry && entry.c) {
    body.append(el('div', { class: 'chips' },
      el('span', { class: 'pill', text: entry.k === 'plant' ? 'Plant' : entry.k === 'coral' ? 'Coral' : entry.k === 'shrimp' ? 'Shrimp' : entry.k === 'snail' ? 'Snail' : entry.k === 'invert' ? 'Invertebrate' : 'Fish' }),
      el('span', { class: 'pill ' + (entry.c.l === 'e' ? 'ok' : entry.c.l === 'h' ? 'warn' : ''), text: LEVEL[entry.c.l] }),
      TEMPER[entry.c.m] ? el('span', { class: 'pill ' + (entry.c.m === 'p' ? 'ok' : entry.c.m === 'a' ? 'bad' : 'warn'), text: TEMPER[entry.c.m] }) : null));
  }

  // In your tank
  const inTank = el('div', { class: 'card' });
  if (t && f) {
    inTank.append(
      el('div', { class: 'card-head' }, el('h2', { text: 'In ' + tankLabel(t) }),
        el('div', { class: 'stepper' },
          el('button', { type: 'button', class: 'round', 'aria-label': 'One fewer ' + name, text: '−', onclick: () => changeCount(t, f, -1) }),
          el('span', { class: 'count', text: String(f.count) }),
          el('button', { type: 'button', class: 'round', 'aria-label': 'One more ' + name, text: '+', onclick: () => changeCount(t, f, 1) }))));
  } else if (t) {
    inTank.append(
      el('div', { class: 'card-head' }, el('h2', { text: 'Not in ' + tankLabel(t) }),
        el('button', { type: 'button', class: 'btn small primary', text: 'Add to tank', onclick: () => { addToTank(t, name, 1, 'add', entry ? entry.k : undefined); saveState(); renderSpecies(); } })));
  }
  if (inTank.childNodes.length) body.append(inTank);

  if (!entry || !entry.c) {
    body.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'This name is not in the species list yet, so there are no care details. You can still keep it in your tank and add your own photo.' })));
    return;
  }

  // Fit with this tank
  if (t) {
    let mine = [];
    if (f) {
      mine = tankCheck(t).issues.filter((i) => i.names.indexOf(entry.n) !== -1);
    } else {
      mine = singleIssues(entry, 1, gal);
      t.fish.forEach((o) => { const oe = careOf(o.name); if (oe) mine.push(...pairIssues(entry, oe)); });
      mine.sort((p, q) => (p.level === q.level ? 0 : p.level === 'bad' ? -1 : 1));
    }
    const fit = el('div', { class: 'card' }, el('h2', { text: f ? 'How it fits your tank' : 'If you add it to your tank' }));
    if (!mine.length) fit.append(el('p', { class: 'muted small', text: t.fish.length ? 'No problems found with what you keep now.' : 'Nothing to compare with yet.' }));
    else fit.append(issueList(mine));
    body.append(fit);
  }

  // Facts
  body.append(el('div', { class: 'card' }, el('h2', { text: 'Quick facts' }),
    el('div', { class: 'facts' }, ...speciesFacts(entry).map((r) => factRow(r[0], r[1])))));

  // About and look-alike tip
  const about = el('div', { class: 'card' }, el('h2', { text: 'Habitat and care' }), el('p', { text: entry.c.n }));
  const grp = entry.g && DB.groups[entry.g];
  if (grp && grp.tip && entry.k !== 'plant') about.append(el('details', { class: 'tell' }, el('summary', { text: 'How to tell it from lookalikes' }), el('p', { text: grp.tip })));
  body.append(about);

  // Mates
  if (entry.k !== 'plant') {
    const type = t && TYPES.includes(t.type) ? t.type : 'Freshwater';
    const codes = type === 'Saltwater' ? ['s'] : type === 'Brackish' ? ['b', 'f'] : ['f'];
    const wantKinds = entry.k === 'coral' ? ['fish', 'coral', 'invert', 'shrimp', 'snail'] : ['fish', 'shrimp', 'snail', 'invert'];
    const good = [], avoid = [];
    DB.list.forEach((c) => {
      if (c === entry || !c.c || wantKinds.indexOf(c.k) === -1 || !codes.some((x) => c.w.indexOf(x) !== -1)) return;
      const issues = pairIssues(entry, c);
      if (!issues.length) { if (!gal || c.c.g <= gal) good.push(c); }
      else if (issues.some((i) => i.level === 'bad')) avoid.push({ c, text: issues.find((i) => i.level === 'bad').text });
    });
    const score = (c) => (c.c.m === 'p' ? 0 : 6) + Math.abs(c.c.z - entry.c.z) * 0.6 + (c.c.y === entry.c.y ? 2 : 0) + (c.c.l === 'h' ? 3 : 0);
    good.sort((p, q) => score(p) - score(q));
    const goodCard = el('div', { class: 'card' }, el('h2', { text: 'Good tank mates' }));
    if (good.length) {
      goodCard.append(el('div', { class: 'alts mates' }, ...good.slice(0, 14).map((c) => el('button', { type: 'button', class: 'alt-chip', text: c.n + (rosterRow(t, c.n) ? ' · in your tank' : ''), onclick: () => showSpecies(c.n, t && t.id, true) }))));
      goodCard.append(el('p', { class: 'muted small', text: 'Showing the best matches for ' + type.toLowerCase() + ' tanks. Check size and temperament before buying.' }));
    } else goodCard.append(el('p', { class: 'muted small', text: 'No clear matches in the list for this tank type.' }));
    body.append(goodCard);
    if (avoid.length) {
      avoid.sort((p, q) => (p.c.c.l === q.c.c.l ? p.c.n.localeCompare(q.c.n) : p.c.c.l < q.c.c.l ? -1 : 1));
      const shrimpHits = avoid.filter((a) => a.c.k === 'shrimp');
      if (shrimpHits.length > 1) {
        const first = avoid.indexOf(shrimpHits[0]);
        avoid.splice(0, avoid.length, ...avoid.filter((a) => a.c.k !== 'shrimp'));
        avoid.splice(Math.min(first, avoid.length), 0, { c: shrimpHits[0].c, text: shrimpHits[0].text.replace(/so .* will not last/, 'so shrimp will not last') });
      }
      body.append(el('div', { class: 'card' }, el('h2', { text: 'Better to avoid' }),
        el('div', { class: 'issues' }, ...avoid.slice(0, 6).map((a) => el('button', { type: 'button', class: 'issue bad', onclick: () => showSpecies(a.c.n, t && t.id, true) }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'issue-text', text: a.text }))))));
    }
  }
}

function stockCard(t) {
  return el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: 'Stocking' })), stockBar(t));
}

// ---------- Fish Check ----------
const SCAN_PRICES = { 'gemini-3.5-flash-lite': [0.3, 2.5], 'gemini-3.8-flash': [0.75, 3.75] };
let fishCheckTankId = '';
let fishCheck = null; // { photoUrl, loading, error, result, name, count, usage, model }

function fishCheckCostLine(fc) {
  if (!fc || !fc.runs || !fc.runs.length) return null;
  const n = (x) => Number(x || 0).toLocaleString();
  return fc.runs.map((run) => {
    const p = SCAN_PRICES[run.model];
    const bits = [run.model + ', ' + n(run.usage.input) + ' tokens in, ' + n(run.usage.output) + ' out'];
    if (p) bits.push('about ' + centsText((run.usage.input * p[0] + run.usage.output * p[1]) / 1e6));
    return bits.join(' · ');
  }).join(' | ');
}

async function runFish(deep) {
  const t = getTank(fishCheckTankId) || activeTank();
  fishCheck.loading = true; fishCheck.error = '';
  renderFishCheck();
  try {
    const data = await askWorker(fishCheck.images, 'fish', 45000, { tank_type: t && TYPES.includes(t.type) ? t.type : '', deep: !!deep });
    const r = data.fish;
    fishCheck.runs.push({ model: data.model, usage: data.usage });
    if (!r || !r.is_aquarium || !r.common_name) {
      fishCheck.error = 'I could not find a fish, plant or coral in that photo. Move closer to one animal, hold still, and try again.';
    } else {
      fishCheck.result = r;
      fishCheck.deep = !!deep;
      const hit = lookupSpecies(r.common_name);
      fishCheck.name = hit ? hit.n : r.common_name;
      fishCheck.count = hit && hit.c && hit.c.s > 1 ? hit.c.s : (r.care_estimate && r.care_estimate.min_group > 1 ? r.care_estimate.min_group : 1);
    }
  } catch (err) {
    fishCheck.error = (err && err.message) || 'Something went wrong. Please try again.';
  }
  fishCheck.loading = false;
  renderFishCheck();
}

async function startFishCheck(file) {
  fishCheck = { photoUrl: '', loading: true, error: '', result: null, name: '', count: 1, runs: [], images: null, deep: false };
  renderFishCheck();
  try {
    const image = await loadImage(file);
    const single = makeSingle(image);
    fishCheck.photoUrl = single.previewUrl;
    fishCheck.images = single.images;
  } catch (err) {
    fishCheck.error = (err && err.message) || 'I could not read that photo. Please try another.';
    fishCheck.loading = false;
    renderFishCheck();
    return;
  }
  await runFish(false);
}

// For a species that is not in the app's list, the AI gives a rough care sheet. Shown clearly as an estimate.
function estimateFacts(ce) {
  const rows = [['Adult size', ce.adult_size_in + ' in'], ['Smallest tank', ce.min_tank_gal + ' gal']];
  if (ce.temp_low_f !== null && ce.temp_high_f !== null) rows.push(['Temperature', Math.round(ce.temp_low_f) + '-' + Math.round(ce.temp_high_f) + '°F']);
  if (ce.ph_low !== null && ce.ph_high !== null) rows.push(['pH', ce.ph_low + '-' + ce.ph_high]);
  if (ce.temperament) rows.push(['Temperament', ce.temperament === 'peaceful' ? 'Peaceful' : ce.temperament === 'aggressive' ? 'Aggressive' : 'Semi-aggressive']);
  if (ce.eats) rows.push(['Eats', ce.eats]);
  rows.push(['Group size', ce.min_group > 1 ? ce.min_group + ' or more' : 'Fine on its own']);
  return rows;
}
function estimateNotes(ce, t) {
  const notes = [];
  if (!t) return notes;
  const typeWater = t.type === 'Saltwater' ? 'salt' : t.type === 'Brackish' ? 'brackish' : 'fresh';
  if (ce.water && ce.water !== typeWater && !(t.type === 'Brackish')) notes.push({ level: 'bad', text: 'This looks like a ' + ce.water + ' water animal and your tank is ' + t.type.toLowerCase() + '.' });
  const gal = tankGallons(t);
  if (gal && ce.min_tank_gal > gal) notes.push({ level: 'bad', text: 'It likely needs about ' + ce.min_tank_gal + ' gallons or more. Your tank is ' + Math.round(gal) + '.' });
  if (ce.temperament === 'aggressive' && t.fish.length) notes.push({ level: 'warn', text: 'It may be aggressive toward your current fish.' });
  return notes;
}

function fishVerdict(t, name, count) {
  const before = tankCheck(t);
  const tmp = Object.assign({}, t, { fish: t.fish.map((f) => Object.assign({}, f)) });
  addToTank(tmp, name, count, 'add');
  const after = tankCheck(tmp);
  const had = new Set(before.issues.map((i) => i.text));
  const fresh = after.issues.filter((i) => !had.has(i.text));
  return { tmp, fresh };
}

const HEALTH_LOOK = {
  healthy: ['Looks healthy', 'ok'],
  some_concerns: ['Some concerns', 'warn'],
  unwell: ['Looks unwell', 'bad'],
  cannot_tell: ["Can't tell from this photo", 'warn']
};
function healthCard(h) {
  const hh = h && HEALTH_LOOK[h.status] ? h : { status: 'cannot_tell', score: null, signs: [] };
  const look = HEALTH_LOOK[hh.status];
  const box = el('div', { class: 'health-box ' + look[1] });
  box.append(el('div', { class: 'water-line' }, el('strong', { text: 'Health check' }), el('span', { class: 'pill ' + look[1], text: look[0] })));
  if (hh.score !== null && hh.score !== undefined) {
    box.append(el('div', { class: 'health-score' }, el('span', { class: 'health-num', text: hh.score + '/100' }),
      el('div', { class: 'health-bar', role: 'img', 'aria-label': 'Health score ' + hh.score + ' out of 100' }, el('span', { style: 'width:' + hh.score + '%' }))));
  }
  if (hh.signs && hh.signs.length) box.append(el('ul', { class: 'health-signs' }, ...hh.signs.map((x) => el('li', { text: x }))));
  const tip = hh.status === 'unwell'
    ? 'I would pass on this one. Fish from the same tank can carry the same problem.'
    : hh.status === 'cannot_tell'
      ? 'Try a sharper, closer photo from the side. Watch it swim before you buy.'
      : 'A photo cannot catch everything. Ask to see it eat, and keep new fish apart for a few weeks before adding them.';
  box.append(el('p', { class: 'muted small', text: tip }));
  return box;
}

function renderFishCheck() {
  const body = $('fishcheck-body');
  body.replaceChildren();
  const t = getTank(fishCheckTankId) || activeTank();
  body.append(el('h1', { text: 'Fish Check' }),
    el('p', { class: 'muted', text: 'Standing at the fish store? Photograph one fish, plant or coral. Get its name, what it needs, and whether it fits your tank. Including its name tag in the photo helps.' }));
  const fc = fishCheck;
  const actions = el('div', { class: 'row photo-actions' },
    el('button', { type: 'button', class: 'btn primary', text: fc ? 'Check another' : 'Take photo', onclick: () => $('fishcheck-camera').click() }),
    el('button', { type: 'button', class: 'btn', text: 'Choose photo', onclick: () => $('fishcheck-gallery').click() }));
  body.append(actions);
  if (!fc) return;
  if (fc.photoUrl) body.append(el('img', { class: 'dream-image', src: fc.photoUrl, alt: 'The fish you photographed' }));
  if (fc.loading) { body.append(el('p', { class: 'muted center', role: 'status', text: 'Looking…' })); return; }
  if (fc.error) { body.append(el('div', { class: 'notice', role: 'status', text: fc.error })); return; }
  const r = fc.result;
  if (!r) return;
  const entry = lookupSpecies(fc.name);
  const sure = r.confidence >= 0.75 ? ['Confident', 'ok'] : r.confidence >= 0.45 ? ['Likely', 'warn'] : ['Not sure', 'bad'];
  const card = el('div', { class: 'card dream-result' });
  card.append(el('div', { class: 'water-line' }, el('h2', { text: fc.name }), el('span', { class: 'pill ' + sure[1], text: sure[0] })));
  if (entry && entry.s) card.append(el('p', { class: 'muted small', text: entry.s }));
  card.append(healthCard(r.health));
  if (r.label_text) card.append(el('p', { class: 'muted small', text: 'Read from the tag: ' + r.label_text }));
  if (r.confidence < 0.6) card.append(el('p', { class: 'muted small', text: 'Try a closer photo of one fish, or include its name tag. Fish look different when they are stressed in store tanks.' }));
  const alts = r.alternatives.map((x) => lookupSpecies(x) ? lookupSpecies(x).n : x).filter((x) => canonKey(x) !== canonKey(fc.name));
  if (alts.length) {
    card.append(el('p', { class: 'label', text: 'Could also be' }),
      el('div', { class: 'chips ideas' }, ...alts.map((x) => el('button', { type: 'button', class: 'chip-btn', text: x, onclick: () => {
        fc.name = x; const h = lookupSpecies(x); fc.count = h && h.c && h.c.s > 1 ? h.c.s : 1; renderFishCheck();
      } }))));
  }
  const care = entry && entry.c ? entry : null;
  if (care) {
    card.append(el('div', { class: 'facts' }, ...speciesFacts(care).slice(0, 8).map((row) => factRow(row[0], row[1]))));
    if (care.c.n) card.append(el('p', { class: 'muted small', text: care.c.n }));
  } else if (r.care_estimate && canonKey(fc.name) === canonKey(r.common_name)) {
    const ce = r.care_estimate;
    card.append(el('p', { class: 'label', text: 'AI estimate' }),
      el('div', { class: 'facts' }, ...estimateFacts(ce).map((row) => factRow(row[0], row[1]))),
      el('p', { class: 'muted small', text: (ce.note ? ce.note + ' ' : '') + 'This is the AI\'s best guess, not from the app\'s care list. Double-check with the store.' }));
    const en = estimateNotes(ce, t);
    if (en.length) card.append(issueList(en));
    else if (t) card.append(el('p', { class: 'muted small', text: 'Nothing obvious against your tank, based on that estimate.' }));
  } else {
    card.append(el('p', { class: 'muted', text: 'I do not have care details for this one yet. Before you buy, ask the store for its adult size, the smallest tank it needs and whether it gets along with other fish.' }));
  }

  if (t && care) {
    const counter = el('div', { class: 'card-head' },
      el('span', { class: 'label', text: 'How many would you buy?' }),
      el('div', { class: 'stepper' },
        el('button', { type: 'button', class: 'round', 'aria-label': 'One fewer', text: '\u2212', onclick: () => { fc.count = Math.max(1, fc.count - 1); renderFishCheck(); } }),
        el('span', { class: 'count', text: String(fc.count) }),
        el('button', { type: 'button', class: 'round', 'aria-label': 'One more', text: '+', onclick: () => { fc.count = Math.min(60, fc.count + 1); renderFishCheck(); } })));
    const v = fishVerdict(t, fc.name, fc.count);
    const bad = v.fresh.some((i) => i.level === 'bad');
    const picker = state.tanks.length > 1 ? el('div', { class: 'chips ideas', role: 'group', 'aria-label': 'Which tank' },
      ...state.tanks.map((x) => el('button', { type: 'button', class: 'chip-btn' + (x.id === t.id ? ' on' : ''), 'aria-pressed': x.id === t.id ? 'true' : 'false', text: tankLabel(x),
        onclick: () => { fishCheckTankId = x.id; renderFishCheck(); } }))) : null;
    card.append(el('h2', { class: 'dream-list-h', text: 'Will it work in ' + tankLabel(t) + '?' }), ...(picker ? [el('p', { class: 'label', text: 'Which tank?' }), picker] : []), counter,
      el('div', { class: 'water-line' }, el('strong', { text: 'Verdict' }),
        !v.fresh.length ? el('span', { class: 'pill ok', text: 'Looks good' }) : el('span', { class: 'pill ' + (bad ? 'bad' : 'warn'), text: bad ? 'Not a good fit' : v.fresh.length + (v.fresh.length === 1 ? ' thing to know' : ' things to know') })),
      v.fresh.length ? issueList(v.fresh.slice(0, 5)) : el('p', { class: 'muted small', text: 'No new problems with what you keep now.' }),
      stockBar(v.tmp), el('p', { class: 'muted small', text: 'Stocking shown with ' + fc.count + ' added.' }));
    const have = t.fish.find((f) => canonKey(f.name) === canonKey(fc.name));
    if (have) card.append(el('p', { class: 'muted small', text: 'You already have ' + have.count + ' in this tank.' }));
  } else if (!t && care) {
    card.append(el('p', { class: 'muted small', text: 'Add a tank on the home screen to see whether this fish fits.' }));
  }

  const buttons = el('div', { class: 'row photo-actions' });
  if (t) buttons.append(el('button', { type: 'button', class: 'btn primary', text: 'Add to ' + tankLabel(t), onclick: () => {
    addToTank(t, fc.name, fc.count, 'add', r.kind);
    saveState();
    toast('Added ' + fc.count + ' ' + fc.name + ' to ' + tankLabel(t) + '.');
    renderFishCheck();
  } }));
  if (entry) buttons.append(el('button', { type: 'button', class: 'btn', text: 'Full details', onclick: () => showSpecies(fc.name, t ? t.id : '') }));
  if (!fc.deep && fc.images) buttons.append(el('button', { type: 'button', class: 'btn', text: 'Look closer', title: 'Runs the photo again with a stronger AI', onclick: () => runFish(true) }));
  card.append(buttons, el('p', { class: 'muted small', text: 'General guidance, and the AI can be wrong about which species it is. Confirm with the store before you buy.' }));
  const cl = fishCheckCostLine(fc);
  if (cl) card.append(el('p', { class: 'muted small cost-line', text: cl }));
  body.append(card);
}

['fishcheck-camera', 'fishcheck-gallery'].forEach((id) => $(id).addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) startFishCheck(file);
}));
$('fishcheck-back').addEventListener('click', () => showView('home'));
$('home-fishcheck').addEventListener('click', () => { fishCheck = null; fishCheckTankId = ''; showView('fishcheck'); });

// ---------- Dream Tank ----------
const DREAM_MONTHLY = 10;
const DREAM_KEY = 'schooled.dream';
const DEVICE_KEY = 'schooled.device';
const DREAM_IDEAS = ['A heavily planted, peaceful community tank with lots of color', 'A reef with soft corals, clownfish and a mandarin', 'A rocky Malawi cichlid tank full of blue and yellow', 'A quiet blackwater tank with small schooling fish and driftwood'];
const DREAM_ERRORS = {
  limit_reached: 'You have used this month’s dream pictures. They come back next month.',
  busy_today: 'Dream Tank has been very busy today. Please try again tomorrow.',
  rate_limited: 'That was a few too many tries in a row. Wait a few minutes and try again.',
  not_aquarium: 'That did not sound like an aquarium. Describe the fish, plants and style you want.',
  ai_busy: 'The AI is busy right now. Nothing was used. Try again in a minute.',
  too_large: 'That photo is too big. Try a different one.',
  bad_image: 'That photo could not be used. Try a different one.'
};

function dreamMonth() { return new Date().toISOString().slice(0, 7); }
function dreamLoad() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(DREAM_KEY) || 'null'); } catch (err) { s = null; }
  if (!s || typeof s !== 'object') s = {};
  if (s.month !== dreamMonth()) { s.month = dreamMonth(); s.used = 0; }
  s.used = Math.max(0, Math.min(99, Math.round(Number(s.used)) || 0));
  return s;
}
function dreamSave(s) {
  try { localStorage.setItem(DREAM_KEY, JSON.stringify(s)); return true; } catch (err) { return false; }
}
function dreamLeft() { return Math.max(0, DREAM_MONTHLY - dreamLoad().used); }
function deviceId() {
  let id = '';
  try { id = localStorage.getItem(DEVICE_KEY) || ''; } catch (err) { id = ''; }
  if (!/^[A-Za-z0-9_-]{12,60}$/.test(id)) {
    id = uid() + uid();
    id = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40).padEnd(12, 'x');
    try { localStorage.setItem(DEVICE_KEY, id); } catch (err) { /* the server then counts by address */ }
  }
  return id;
}

let dreamForm = null;
let dreamPhoto = '';
let dreamBusy = false;
let dreamMessage = '';

function shrinkDataUrl(src, side) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const k = Math.min(1, side / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.82));
        } catch (err) { resolve(src.length < 900000 ? src : ''); }
      };
      img.onerror = () => resolve(src.length < 900000 ? src : '');
      setTimeout(() => resolve(src.length < 900000 ? src : ''), 4000); // never leave the page waiting
      img.src = src;
    } catch (err) { resolve(''); }
  });
}

function dreamTank(r) {
  const fish = (r.species || []).map((s) => {
    const item = { name: canonName(s.common_name), count: Math.max(1, Math.round(s.count) || 1) };
    if (KIND_LIST.includes(s.kind)) item.kind = s.kind;
    return item;
  });
  return newTank({ name: r.title || 'Dream tank', size: String(r.gallons || 55), unit: 'gallons', type: r.type || 'Freshwater', fish, photo: r.image || '' });
}

async function runDream() {
  if (dreamBusy) return;
  const f = dreamForm;
  const text = f.text.trim();
  const gal = Number(f.size);
  if (text.length < 3) { toast('Describe the tank you want first.'); return; }
  if (!(gal >= 5 && gal <= 2000)) { toast('Enter a tank size between 5 and 2000 gallons.'); return; }
  if (!dreamLeft()) { dreamMessage = DREAM_ERRORS.limit_reached; renderDream(); return; }
  dreamBusy = true; dreamMessage = '';
  renderDream();
  try {
    const body = { prompt: text, tank_type: f.type, gallons: gal, device: deviceId() };
    if (dreamPhoto) { body.image = dreamPhoto.split(',')[1] || ''; body.mime = 'image/jpeg'; }
    const res = await fetch(WORKER_URL + '/dream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(130000) });
    let j = null;
    try { j = await res.json(); } catch (err) { j = null; }
    if (!j || !j.ok) {
      const code = j && j.error;
      if (code === 'limit_reached') { const s = dreamLoad(); s.used = DREAM_MONTHLY; dreamSave(s); }
      dreamMessage = (DREAM_ERRORS[code] || 'Something went wrong. Nothing was used. Try again in a minute.') + (j && j.ai_detail ? ' (' + String(j.ai_detail).slice(0, 300) + ')' : '');
    } else {
      let image = '';
      if (j.image && j.image.data && /^image\/(png|jpeg|webp)$/.test(j.image.mime)) {
        image = await shrinkDataUrl('data:' + j.image.mime + ';base64,' + j.image.data, 1024);
      }
      const s = dreamLoad();
      if (image) s.used += 1;
      const cost = dreamCost(j.usage);
      if (image) s.cost = Math.round(((Number(s.cost) || 0) + cost.dollars) * 10000) / 10000;
      s.last = { title: String(j.title || ''), summary: String(j.summary || ''), species: j.species, image, gallons: gal, type: f.type, at: Date.now(), usage: j.usage || null, imageModel: String(j.image_model || '') };
      if (!dreamSave(s)) { s.last.image = ''; dreamSave(s); }
      dreamMessage = image ? '' : 'The AI made your list but could not make the picture this time, and no picture was used. Try again.' + (j.image_error ? ' (' + String(j.image_error).slice(0, 300) + ')' : '');
    }
  } catch (err) {
    dreamMessage = 'Could not reach the server. Check your connection. Nothing was used.';
  }
  dreamBusy = false;
  renderDream();
  window.scrollTo(0, 0);
}

// Google's paid-tier prices per 1M tokens: [input, output]. Image output is priced much higher than text.
const DREAM_PRICES = { 'gemini-3.1-flash-image': [0.5, 60], 'gemini-2.5-flash-image': [0.3, 30], 'gemini-3-pro-image': [2, 120] };
function dreamCost(usage) {
  const im = usage && usage.image;
  const p = im && DREAM_PRICES[im.model];
  if (!p) return { dollars: 0, known: false };
  const out = (im.image_out || im.output || 0);
  const textOut = Math.max(0, (im.output || 0) - (im.image_out || 0)) + (im.thoughts || 0);
  const dollars = ((im.input || 0) * p[0] + (im.image_out ? im.image_out * p[1] + textOut * 3 : out * p[1]) ) / 1e6;
  return { dollars, known: true };
}
function centsText(d) { return (d * 100).toFixed(d * 100 < 10 ? 2 : 1) + '\u00a2'; }
function dreamCostLine(r) {
  const u = r.usage;
  if (!u || !u.image) return null;
  const c = dreamCost(u);
  const n = (x) => Number(x || 0).toLocaleString();
  const bits = [
    'Picture: ' + (u.image.model || 'unknown') + ', ' + n(u.image.input) + ' tokens in, ' + n(u.image.output) + ' out' + (u.image.image_out ? ' (' + n(u.image.image_out) + ' image)' : ''),
    c.known ? 'about ' + centsText(c.dollars) + ' for the picture' : 'price for this model not in the app',
    u.plan ? 'Plan: ' + (u.plan.model || 'unknown') + ', ' + n(u.plan.input) + ' in, ' + n(u.plan.output) + ' out (price not counted)' : ''
  ].filter(Boolean);
  const s = dreamLoad();
  if (s.cost) bits.push('Pictures this month on this phone: about ' + centsText(s.cost));
  return bits.join(' \u00b7 ');
}

function dreamPhotoButtons(rerender) {
  const cam = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const gal = el('input', { type: 'file', accept: 'image/*,.heic,.heif,.avif,.webp,.bmp,.gif,.tif,.tiff', hidden: true });
  const wire = (input) => input.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try { dreamPhoto = await photoFromFile(file, 1024); rerender(); } catch (err) { toast("This device couldn't open that photo. Try another one."); }
  });
  wire(cam); wire(gal);
  const t = activeTank();
  return el('div', { class: 'row photo-actions' },
    el('button', { type: 'button', class: 'btn small', text: 'Take photo', onclick: () => cam.click() }),
    el('button', { type: 'button', class: 'btn small', text: 'Choose photo', onclick: () => gal.click() }),
    t && t.photo && dreamPhoto !== t.photo ? el('button', { type: 'button', class: 'btn small', text: 'Use my tank', onclick: () => { dreamPhoto = t.photo; rerender(); } }) : null,
    dreamPhoto ? el('button', { type: 'button', class: 'btn small', text: 'Remove', onclick: () => { dreamPhoto = ''; rerender(); } }) : null,
    cam, gal);
}

function renderDream() {
  const body = $('dream-body');
  body.replaceChildren();
  const t = activeTank();
  if (!dreamForm) {
    dreamForm = { text: '', type: t ? t.type : 'Freshwater', size: t && tankGallons(t) ? String(Math.round(tankGallons(t))) : '55' };
  }
  const s = dreamLoad();
  const left = dreamLeft();

  body.append(el('h1', { text: 'Dream Tank' }),
    el('p', { class: 'muted', text: 'Describe the tank you want and the AI will picture it with fish and plants, then list what it would take. Add a photo of your tank to see the idea in your own space.' }));

  if (dreamMessage) body.append(el('div', { class: 'notice', role: 'status', text: dreamMessage }));

  // Photo
  const photoCard = el('div', { class: 'card' }, el('h2', { text: 'Your tank photo' }), el('p', { class: 'muted small', text: 'Optional. The AI keeps your tank and room and redoes what is inside.' }));
  const box = el('div', { class: 'photo-box dream-photo' });
  if (dreamPhoto) box.append(el('img', { src: dreamPhoto, alt: 'Your tank photo' }));
  else box.append(el('div', { class: 'tank-hero-empty' }, kindIcon('fish'), el('span', { text: 'No photo added' })));
  photoCard.append(box, dreamPhotoButtons(renderDream));
  body.append(photoCard);

  // Wish
  const area = el('textarea', { class: 'dream-text', rows: 4, maxlength: 400, placeholder: 'For example: a heavily planted tank with schooling fish, driftwood and a calm feel', 'aria-label': 'Describe your dream tank' });
  area.value = dreamForm.text;
  area.addEventListener('input', () => { dreamForm.text = area.value; });
  const typeSel = el('select', { class: 'select', 'aria-label': 'Water type' }, ...['Freshwater', 'Saltwater', 'Brackish'].map((x) => el('option', { value: x, text: x })));
  typeSel.value = dreamForm.type;
  typeSel.addEventListener('change', () => { dreamForm.type = typeSel.value; });
  const size = el('input', { type: 'number', inputmode: 'numeric', min: 5, max: 2000, class: 'dream-size', value: dreamForm.size, 'aria-label': 'Tank size in gallons' });
  size.addEventListener('input', () => { dreamForm.size = size.value; });
  const wishCard = el('div', { class: 'card' },
    el('h2', { text: 'What do you want?' }), area,
    el('div', { class: 'chips ideas' }, ...DREAM_IDEAS.map((i) => el('button', { type: 'button', class: 'chip-btn', text: i, onclick: () => { dreamForm.text = i; area.value = i; } }))),
    el('div', { class: 'dream-row' }, el('label', {}, el('span', { class: 'label', text: 'Water' }), typeSel), el('label', {}, el('span', { class: 'label', text: 'Gallons' }), size)));
  body.append(wishCard);

  const go = el('button', { type: 'button', class: 'btn primary big', text: dreamBusy ? 'Dreaming…' : (s.last ? 'Dream another one' : 'Dream it'), onclick: runDream });
  if (dreamBusy || !left) go.disabled = true;
  body.append(go,
    el('p', { class: 'muted small center', text: dreamBusy ? 'This can take up to a minute. Please keep the app open.' : left + ' of ' + DREAM_MONTHLY + ' dream pictures left this month. A picture only counts when it is made.' }));

  if (s.last && !dreamBusy) body.append(dreamResultCard(s.last));
}

function dreamResultCard(r) {
  const tmp = dreamTank(r);
  const card = el('div', { class: 'card dream-result' });
  if (r.image) {
    card.append(el('img', { class: 'dream-image', src: r.image, alt: 'AI picture of ' + r.title }),
      el('a', { class: 'btn small', href: r.image, download: 'dream-tank.jpg', text: 'Save picture' }),
      el('p', { class: 'muted small', text: 'On an iPhone, press and hold the picture to save it. This is an AI picture, so real fish and plants will look a little different.' }));
  }
  card.append(el('h2', { text: r.title }), r.summary ? el('p', { text: r.summary }) : null);

  const check = tankCheck(tmp);
  const bad = check.issues.some((i) => i.level === 'bad');
  card.append(el('div', { class: 'water-line' },
    el('strong', { text: 'Would it work?' }),
    !check.issues.length ? el('span', { class: 'pill ok', text: 'All clear' }) : el('span', { class: 'pill ' + (bad ? 'bad' : 'warn'), text: check.issues.length + (check.issues.length === 1 ? ' thing to look at' : ' things to look at') })),
    stockBar(tmp));
  if (check.issues.length) card.append(issueList(check.issues.slice(0, 4)));

  card.append(el('h2', { class: 'dream-list-h', text: 'What it takes' }),
    el('div', { class: 'roster dream-roster' }, ...tmp.fish.map((f, i) => {
      const note = r.species[i] && r.species[i].note;
      return el('div', { class: 'item' },
        rowAvatar(f),
        el('button', { type: 'button', class: 'row-main', 'aria-label': 'Details for ' + f.name, onclick: () => { const a = activeTank(); showSpecies(f.name, a ? a.id : ''); } },
          el('span', { class: 'name', text: f.name }),
          note ? el('span', { class: 'sub', text: note }) : null),
        el('span', { class: 'count-chip', text: '× ' + f.count }));
    })),
    el('button', { type: 'button', class: 'btn primary big', text: 'Start this as a new tank', onclick: () => {
      if (state.tanks.length >= MAX_TANKS) { toast('That is the most tanks the app can hold on this phone (' + MAX_TANKS + ').'); return; }
      state.tanks.push(tmp);
      state.activeId = tmp.id;
      if (!saveState()) { tmp.photo = ''; saveState(); }
      showTank(tmp.id);
      toast('Created ' + tankLabel(tmp) + '. Add what you actually own as you go.');
    } }),
    el('p', { class: 'muted small', text: 'Stocking advice is general guidance, and the AI can be wrong. Check each species before you buy.' }),
    dreamCostLine(r) ? el('p', { class: 'muted small cost-line', text: dreamCostLine(r) }) : null);
  return card;
}

$('dream-back').addEventListener('click', () => showView('home'));

// ---------- Splash ----------
(function () {
  const s = document.getElementById('splash');
  if (!s) return;
  setTimeout(() => {
    s.classList.add('leaving');
    setTimeout(() => s.remove(), 450);
  }, 2500);
})();

// ---------- Start ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

loadSpecies().then(() => {
  // Names and kinds come from the list, so redraw once it has loaded.
  if (!$('view-home').hidden) renderHome();
  else if (!$('view-tank').hidden) renderTank();
});
showView(state.setupDone ? 'home' : 'setup');
