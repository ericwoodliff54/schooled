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

let speciesListType = null;
function fillSpeciesList(type) {
  if (!DB.ready || speciesListType === type) return;
  speciesListType = type;
  const codes = type === 'Saltwater' ? ['s'] : type === 'Brackish' ? ['b', 'f'] : ['f'];
  $('species-list').replaceChildren(...DB.list.filter((e) => codes.some((c) => e.w.includes(c))).map((e) => el('option', { value: e.n })));
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
const VIEWS = ['setup', 'home', 'scan', 'results', 'water', 'tanks', 'tank'];
const NAV_FOR = { home: 'home', scan: 'scan', results: 'scan', water: 'water', tanks: 'tanks', tank: 'tanks' };
let openTankId = '';
let editingSize = false;

function showView(name) {
  VIEWS.forEach((v) => { $('view-' + v).hidden = v !== name; });
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
async function photoFromFile(file) {
  const image = await loadImage(file);
  try {
    return drawToJpeg(image.source, 0, 0, image.width, image.height, TANK_PHOTO_SIDE, 0.8);
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
function renderHome() {
  const t = activeTank();
  const photo = $('home-photo');
  const switchRow = $('home-switch-row');
  const box = $('home-fish');
  box.replaceChildren();

  if (!t) {
    photo.hidden = true;
    switchRow.hidden = true;
    $('home-title').textContent = 'Welcome';
    $('home-sub').textContent = 'No tank added yet.';
    box.append(
      el('h2', { text: 'Add your first tank' }),
      el('p', { class: 'muted', text: 'Give it a name and a photo, and keep its fish and plants in one place.' }),
      el('button', { type: 'button', class: 'btn primary small', text: 'Add a tank', onclick: startAddTank })
    );
    return;
  }

  $('home-title').textContent = tankLabel(t);
  $('home-sub').textContent = tankSummary(t) || 'Open My Tanks to add details.';
  if (t.photo) { photo.src = t.photo; photo.alt = 'Photo of ' + tankLabel(t); photo.hidden = false; }
  else { photo.removeAttribute('src'); photo.hidden = true; }

  if (state.tanks.length > 1) {
    const sel = $('home-switch');
    sel.replaceChildren(...state.tanks.map((x) => el('option', { value: x.id, text: tankLabel(x) })));
    sel.value = t.id;
    switchRow.hidden = false;
  } else {
    switchRow.hidden = true;
  }

  if (!t.fish.length) {
    box.append(
      el('h2', { text: 'No fish yet' }),
      el('p', { class: 'muted', text: 'Scan your tank and Schooled will name what it sees.' })
    );
  } else {
    box.append(
      el('h2', { text: t.fish.length + (t.fish.length === 1 ? ' kind' : ' kinds') + ' in this tank' }),
      el('p', { class: 'muted', text: totalFish(t) + ' fish and plants in total' }),
      el('button', { type: 'button', class: 'btn small', text: 'See this tank', onclick: () => showTank(t.id) })
    );
  }
}

$('home-switch').addEventListener('change', () => {
  const id = $('home-switch').value;
  if (getTank(id)) { state.activeId = id; saveState(); renderHome(); }
});

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
  fillSpeciesList(TYPES.includes(t.type) ? t.type : 'Freshwater');

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
    list.append(
      el('div', { class: 'item' },
        el('div', { class: 'grow' }, el('span', { class: 'name', text: f.name })),
        el('button', { type: 'button', class: 'round', 'aria-label': 'One fewer ' + f.name, text: '−', onclick: () => changeCount(t, f, -1) }),
        el('span', { class: 'count', text: String(f.count) }),
        el('button', { type: 'button', class: 'round', 'aria-label': 'One more ' + f.name, text: '+', onclick: () => changeCount(t, f, 1) })
      )
    );
  });
}

function changeCount(tank, fish, delta) {
  fish.count += delta;
  if (fish.count < 1) tank.fish = tank.fish.filter((f) => f !== fish);
  if (fish.count > 999) fish.count = 999;
  saveState();
  renderTank();
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

$('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const t = getTank(openTankId);
  const input = $('add-name');
  if (!t || !input.value.trim()) return;
  addToTank(t, input.value, 1, 'add');
  input.value = '';
  saveState();
  renderTank();
});

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

async function startScan(file) {
  const target = activeTank();
  pending = { photoUrl: '', species: [], tips: '', loading: true, error: '', note: '', tankId: target ? target.id : '' };
  const known = target ? target.fish.map((f) => f.name) : []; // tells the AI what this tank already has
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

    const ctx = { known, tank_type: target && TYPES.includes(target.type) ? target.type : '' };
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
  pending.loading = false;
  renderResults();
}

function confidenceLabel(c) {
  if (c >= 0.85) return ['Sure', 'ok'];
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
  $('results-title').textContent = n === 1 ? 'Found 1 kind' : 'Found ' + n + ' kinds';
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
  const nameInput = el('input', { type: 'text', value: sp.name, maxlength: 60, 'aria-label': 'Name', list: 'species-list', autocomplete: 'off' });
  const countInput = el('input', { type: 'number', value: sp.count, min: 1, max: 999, 'aria-label': 'How many', style: 'max-width: 90px' });
  return el('div', { class: 'item edit-row' },
    nameInput,
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

// ---------- Start ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

loadSpecies().then(() => {
  const t = activeTank();
  fillSpeciesList(t && TYPES.includes(t.type) ? t.type : 'Freshwater');
});
showView(state.setupDone ? 'home' : 'setup');
