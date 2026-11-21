'use strict';

// ---------------------------------------------------------------
// Schooled app. Plain JavaScript, no build step.
// Change WORKER_URL only if you rename or move the Cloudflare Worker.
// ---------------------------------------------------------------
const WORKER_URL = 'https://schooled-worker.ericwoodliff.workers.dev';
const STORE_KEY = 'schooled.v1';
const MAX_PHOTO_SIDE = 1024;

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

// ---------- Saved data (stays on the phone) ----------
function defaultState() {
  return {
    setupDone: false,
    tank: { name: '', size: '', unit: 'gallons', water: 'city', zip: '' },
    fish: []
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const saved = JSON.parse(raw);
    const base = defaultState();
    return {
      setupDone: !!saved.setupDone,
      tank: Object.assign(base.tank, saved.tank || {}),
      fish: Array.isArray(saved.fish) ? saved.fish.filter((f) => f && typeof f.name === 'string') : []
    };
  } catch (err) {
    return defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (err) {
    // Storage can be blocked (private mode); the app still works for this visit.
  }
}

let state = loadState();
let pending = null; // current scan: { photoUrl, species: [], tips, loading, error }

// ---------- Navigation ----------
const VIEWS = ['setup', 'home', 'scan', 'results', 'water', 'tank'];
const NAV_FOR = { home: 'home', scan: 'scan', results: 'scan', water: 'water', tank: 'tank' };

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
  if (name === 'tank') renderTank();
  window.scrollTo(0, 0);
}

document.querySelectorAll('#nav button').forEach((b) => {
  b.addEventListener('click', () => showView(b.dataset.view));
});

// ---------- Tank helpers ----------
function tankName() {
  return state.tank.name.trim() || 'My tank';
}

function sizeText() {
  return state.tank.size ? state.tank.size + ' ' + state.tank.unit : '';
}

function addToTank(name, count, mode) {
  const clean = name.trim().slice(0, 60);
  if (!clean) return;
  const key = clean.toLowerCase();
  const existing = state.fish.find((f) => f.name.toLowerCase() === key);
  if (existing) existing.count = mode === 'add' ? existing.count + count : count;
  else state.fish.push({ name: clean, count });
}

function totalFish() {
  return state.fish.reduce((sum, f) => sum + f.count, 0);
}

// ---------- Setup ----------
function fillSetupForm() {
  $('tank-name').value = state.tank.name;
  $('tank-size').value = state.tank.size;
  $('tank-zip').value = state.tank.zip;
  document.querySelector('input[name="unit"][value="' + state.tank.unit + '"]').checked = true;
  document.querySelector('input[name="water"][value="' + state.tank.water + '"]').checked = true;
  $('setup-error').hidden = true;
  syncZipField();
  $('setup-skip').textContent = state.setupDone ? 'Cancel' : 'Skip for now';
}

function syncZipField() {
  const water = document.querySelector('input[name="water"]:checked').value;
  $('zip-field').hidden = water !== 'city';
}

document.querySelectorAll('input[name="water"]').forEach((r) => r.addEventListener('change', syncZipField));

$('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('tank-name').value.trim();
  const sizeRaw = $('tank-size').value.trim();
  const unit = document.querySelector('input[name="unit"]:checked').value;
  const water = document.querySelector('input[name="water"]:checked').value;
  const zip = $('tank-zip').value.trim();
  const err = $('setup-error');

  const size = Number(sizeRaw);
  if (!sizeRaw || !isFinite(size) || size <= 0 || size > 5000) {
    err.textContent = 'Enter your tank size as a number, like 29.';
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

  state.tank = { name, size: String(size), unit, water, zip: water === 'city' ? zip : '' };
  state.setupDone = true;
  saveState();
  showView('home');
});

$('setup-skip').addEventListener('click', () => {
  state.setupDone = true;
  saveState();
  showView('home');
});

// ---------- Home ----------
function renderHome() {
  $('home-title').textContent = tankName();
  const size = sizeText();
  $('home-sub').textContent = size ? size + (state.tank.water === 'well' ? ' · well water' : '') : 'Set your tank size in the Tank tab.';

  const box = $('home-fish');
  box.replaceChildren();
  if (!state.fish.length) {
    box.append(
      el('h2', { text: 'No fish yet' }),
      el('p', { class: 'muted', text: 'Scan your tank and Schooled will name what it sees.' })
    );
  } else {
    box.append(
      el('h2', { text: state.fish.length + (state.fish.length === 1 ? ' kind' : ' kinds') + ' in your tank' }),
      el('p', { class: 'muted', text: totalFish() + ' fish and plants in total' }),
      el('button', { type: 'button', class: 'btn small', text: 'See My Tank', onclick: () => showView('tank') })
    );
  }
}

$('home-scan').addEventListener('click', () => showView('scan'));

// ---------- Water ----------
function renderWater() {
  const text = $('water-tap-text');
  if (state.tank.water === 'well') {
    text.textContent = 'You use well water, so the best starting point is a test strip on your tap water. Tap water lookup is for city water.';
  } else if (state.tank.zip) {
    text.textContent = 'ZIP ' + state.tank.zip + ': hardness lookup and conditioner advice are coming in a later update.';
  } else {
    text.textContent = 'Add your ZIP code in the Tank tab to get tap water info in a later update.';
  }
}

// ---------- My Tank ----------
function renderTank() {
  $('tank-title').textContent = tankName();
  const chips = $('tank-chips');
  chips.replaceChildren(
    chip('Size', sizeText() || 'Not set'),
    chip('Type', 'Freshwater'),
    chip('Water', state.tank.water === 'well' ? 'Well' : 'City')
  );

  const list = $('tank-list');
  list.replaceChildren();
  state.fish.forEach((f) => {
    list.append(
      el('div', { class: 'item' },
        el('div', { class: 'grow' }, el('span', { class: 'name', text: f.name })),
        el('button', { type: 'button', class: 'round', 'aria-label': 'One fewer ' + f.name, text: '−', onclick: () => changeCount(f, -1) }),
        el('span', { class: 'count', text: String(f.count) }),
        el('button', { type: 'button', class: 'round', 'aria-label': 'One more ' + f.name, text: '+', onclick: () => changeCount(f, 1) })
      )
    );
  });
}

function chip(label, value) {
  return el('div', { class: 'chip' }, el('span', { text: label }), el('strong', { text: value }));
}

function changeCount(fish, delta) {
  fish.count += delta;
  if (fish.count < 1) state.fish = state.fish.filter((f) => f !== fish);
  if (fish.count > 999) fish.count = 999;
  saveState();
  renderTank();
}

$('edit-tank').addEventListener('click', () => showView('setup'));

$('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('add-name');
  if (!input.value.trim()) return;
  addToTank(input.value, 1, 'add');
  input.value = '';
  saveState();
  renderTank();
});

// ---------- Scan ----------
$('photo-btn').addEventListener('click', () => $('photo-input').click());

$('photo-input').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = ''; // lets the same photo be picked again
  if (file) startScan(file);
});

$('rescan').addEventListener('click', () => showView('scan'));
$('results-back').addEventListener('click', () => showView('scan'));

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('bad_image'));
    };
    img.src = url;
  });
}

// Shrinks the photo so uploads are fast and cheap, and returns it as base64 JPEG.
async function prepareImage(file) {
  const { img, url } = await loadImage(file);
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  URL.revokeObjectURL(url);
  return { base64: dataUrl.split(',')[1], previewUrl: dataUrl };
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

async function startScan(file) {
  pending = { photoUrl: '', species: [], tips: '', loading: true, error: '' };
  showView('results');
  renderResults();

  try {
    const prepared = await prepareImage(file);
    pending.photoUrl = prepared.previewUrl;
    renderResults();

    const res = await fetch(WORKER_URL + '/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: prepared.base64, mime: 'image/jpeg' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error === 'ai_error' ? 'Photo reader error ' + data.ai_status + ': ' + (data.ai_detail || 'no details') : friendlyError(data.error, res.status));

    if (data.is_aquarium === false) {
      pending.error = "That doesn't look like an aquarium. Try a photo of your tank.";
    } else if (!data.species || !data.species.length) {
      pending.error = "Couldn't spot any fish or plants. Try getting closer, with less glare.";
    }
    pending.species = (data.species || []).map((s) => ({
      name: s.common_name,
      scientific: s.scientific_name || '',
      kind: s.kind || 'fish',
      count: s.count,
      confidence: s.confidence,
      editing: false
    }));
    pending.tips = data.photo_tips || '';
  } catch (err) {
    if (err instanceof TypeError) pending.error = "Couldn't reach the server. Check your connection and try again.";
    else if (err.message === 'bad_image') pending.error = "This device couldn't open that photo. If it's an iPhone HEIC file, use the camera button or a JPG instead.";
    else pending.error = err.message || friendlyError();
  }
  pending.loading = false;
  renderResults();
}

function confidenceLabel(c) {
  if (c >= 0.85) return ['Sure', 'ok'];
  if (c >= 0.6) return ['Likely', 'warn'];
  return ['Unsure', 'bad'];
}

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

  if (pending.loading) {
    $('results-title').textContent = 'Looking at your tank…';
    status.append(el('div', { class: 'status-card' }, el('div', { class: 'spinner' }), el('span', { text: 'Reading your photo. This takes a few seconds.' })));
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
  if (pending.tips) status.append(el('div', { class: 'status-card' }, el('span', { text: 'Tip: ' + pending.tips })));

  pending.species.forEach((sp, index) => list.append(sp.editing ? editRow(sp, index) : resultRow(sp)));
  $('results-note').hidden = false;
  $('results-actions').hidden = false;
  $('save-scan').hidden = n === 0;
}

function resultRow(sp) {
  const [label, tone] = confidenceLabel(sp.confidence);
  const sub = [sp.scientific, sp.kind].filter(Boolean).join(' · ');
  return el('div', { class: 'item' },
    el('div', { class: 'grow' },
      el('span', { class: 'name', text: sp.name + (sp.count > 1 ? ' × ' + sp.count : '') }),
      sub ? el('span', { class: 'sub', text: sub }) : null
    ),
    el('span', { class: 'pill ' + tone, text: label }),
    el('button', { type: 'button', class: 'btn small', text: 'Edit', onclick: () => { sp.editing = true; renderResults(); } })
  );
}

function editRow(sp, index) {
  const nameInput = el('input', { type: 'text', value: sp.name, maxlength: 60, 'aria-label': 'Name' });
  const countInput = el('input', { type: 'number', value: sp.count, min: 1, max: 999, 'aria-label': 'How many', style: 'max-width: 90px' });
  return el('div', { class: 'item edit-row' },
    nameInput,
    countInput,
    el('button', {
      type: 'button', class: 'btn small primary', text: 'Done',
      onclick: () => {
        const name = nameInput.value.trim();
        const count = Math.round(Number(countInput.value));
        if (name) sp.name = name.slice(0, 60);
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
  pending.species.forEach((sp) => addToTank(sp.name, sp.count, 'set'));
  saveState();
  pending = null;
  showView('tank');
});

// ---------- Start ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

showView(state.setupDone ? 'home' : 'setup');
