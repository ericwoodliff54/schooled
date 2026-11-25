#!/usr/bin/env python3
"""Builds the species database from the plain-text source files.
Writes site/species.json (full list for the app) and refreshes the compact copy inside schooled-worker.js."""
import json, re, sys, os, unicodedata
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
KINDS = {'fish', 'shrimp', 'snail', 'plant', 'coral', 'invert', 'other'}

def norm(s):
    s = unicodedata.normalize('NFD', s.lower())
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = s.replace("'", '').replace('’', '')
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()

def read_lines(name):
    with open(os.path.join(HERE, name), encoding='utf-8') as f:
        return [l.rstrip('\n') for l in f if l.strip() and not l.startswith('#')]

groups = {}
for l in read_lines('groups.txt'):
    gid, name, tip, hard = l.rsplit('|', 3) if False else (lambda p: (p[0], p[1], '|'.join(p[2:-1]), p[-1]))(l.split('|'))
    groups[gid] = {'n': name, 'tip': tip}
    if hard.strip() == '1': groups[gid]['h'] = 1

species, errors = [], []
for fn in ['species_fresh_fish.txt', 'species_fresh_other.txt', 'species_salt.txt', 'species_more_fresh.txt', 'species_more_salt.txt', 'species_batch3.txt', 'species_batch4.txt', 'species_batch5.txt', 'species_batch6.txt', 'species_batch7.txt', 'species_batch8.txt', 'species_batch9.txt', 'species_batch10.txt', 'species_batch11.txt', 'species_batch12.txt', 'species_batch13.txt', 'species_batch14.txt', 'species_batch15.txt']:
    for i, l in enumerate(read_lines(fn), 1):
        parts = l.split('|')
        if len(parts) != 6:
            errors.append(f'{fn}:{i}: expected 6 fields, got {len(parts)}: {l[:60]}'); continue
        kind, water, name, sci, aliases, gid = [p.strip() for p in parts]
        if kind not in KINDS: errors.append(f'{fn}:{i}: bad kind {kind}')
        if not water or set(water) - set('fsb'): errors.append(f'{fn}:{i}: bad water {water}')
        if gid and gid not in groups: errors.append(f'{fn}:{i}: unknown group {gid}')
        entry = {'n': name, 's': sci, 'k': kind, 'w': water}
        al = [a.strip() for a in aliases.split(';') if a.strip()]
        if al: entry['a'] = al
        if gid: entry['g'] = gid
        species.append(entry)

# fixes.txt: small corrections to older entries, so the older files never need editing.
# One per line: Name|add|alias   Name|remove|alias   Name|sci|Scientific name
try:
    fix_lines = read_lines('fixes.txt')
except FileNotFoundError:
    fix_lines = []
_by = {e['n']: e for e in species}
for i, l in enumerate(fix_lines, 1):
    p = [x.strip() for x in l.split('|')]
    if len(p) != 3 or p[0] not in _by or p[1] not in ('add', 'remove', 'sci'):
        errors.append(f'fixes.txt:{i}: bad fix: {l[:60]}'); continue
    e = _by[p[0]]
    if p[1] == 'add':
        e.setdefault('a', [])
        if p[2] not in e['a']: e['a'].append(p[2])
    elif p[1] == 'remove':
        if p[2] not in e.get('a', []): errors.append(f'fixes.txt:{i}: "{p[0]}" has no alias "{p[2]}"'); continue
        e['a'].remove(p[2])
        if not e['a']: del e['a']
    else:
        e['s'] = p[2]

# care data: one row per species, keyed by common name
by_name = {e['n']: e for e in species}
care_seen = set()
for fn in ['care_fresh_fish.txt', 'care_fresh_other.txt', 'care_salt.txt', 'care_more_fresh.txt', 'care_more_salt.txt', 'care_batch3.txt', 'care_batch4.txt', 'care_batch5.txt', 'care_batch6.txt', 'care_batch7.txt', 'care_batch8.txt', 'care_batch9.txt', 'care_batch10.txt', 'care_batch11.txt', 'care_batch12.txt', 'care_batch13.txt', 'care_batch14.txt', 'care_batch15.txt']:
    for i, l in enumerate(read_lines(fn), 1):
        p = l.split('|')
        if len(p) != 12:
            errors.append(f'{fn}:{i}: expected 12 fields, got {len(p)}: {l[:50]}'); continue
        name, size, gal, temp, ph, temper, diet, zone, school, lvl, tags, note = [x.strip() for x in p]
        e = by_name.get(name)
        if not e: errors.append(f'{fn}:{i}: no species named "{name}"'); continue
        if name in care_seen: errors.append(f'{fn}:{i}: duplicate care row "{name}"'); continue
        care_seen.add(name)
        try:
            tl, th = [float(x) for x in temp.split('-')]
            pl, ph_ = [float(x) for x in ph.split('-')]
            c = {'z': float(size), 'g': int(float(gal)), 't': [tl, th], 'p': [pl, ph_], 'm': temper, 'd': diet, 'y': zone,
                 's': int(school), 'l': lvl, 'n': note}
        except ValueError:
            errors.append(f'{fn}:{i}: bad number in row "{name}"'); continue
        if temper not in ('p', 's', 'a', '-'): errors.append(f'{fn}:{i}: bad temperament {temper}')
        if lvl not in ('e', 'm', 'h'): errors.append(f'{fn}:{i}: bad level {lvl}')
        if tl > th or pl > ph_: errors.append(f'{fn}:{i}: range backwards for "{name}"')
        tg = [t.strip() for t in tags.split(',') if t.strip()]
        if tg: c['x'] = tg
        e['c'] = c
for e in species:
    if e['n'] not in care_seen: errors.append('no care row for "' + e['n'] + '"')

# specific diet text (optional per species, shown instead of the generic Diet label)
for i, l in enumerate(read_lines('diet.txt') + read_lines('diet_more.txt') + read_lines('diet_batch7.txt') + read_lines('diet_batch8.txt') + read_lines('diet_batch9.txt') + read_lines('diet_batch12.txt') + read_lines('diet_batch13.txt') + read_lines('diet_batch14.txt') + read_lines('diet_batch15.txt'), 1):
    name, _, text = l.partition('|')
    e = by_name.get(name.strip())
    if not e or 'c' not in e: errors.append(f'diet.txt:{i}: no species with care named "{name}"'); continue
    if not text.strip() or len(text.strip()) > 60: errors.append(f'diet.txt:{i}: bad text for "{name}"'); continue
    e['c']['f'] = text.strip()
for e in species:
    c = e.get('c')
    if c and c.get('d') in ('o', 'c', 'h', 'p') and 'f' not in c: errors.append('no diet text for "' + e['n'] + '"')

# uniqueness: every name/alias must point to exactly one entry
seen = {}
for e in species:
    for key in [e['n']] + e.get('a', []):
        k = norm(key)
        if k in seen and seen[k] is not e:
            errors.append(f'duplicate name/alias "{key}" used by "{seen[k]["n"]}" and "{e["n"]}"')
        seen[k] = e
unused = [g for g in groups if not any(e.get('g') == g for e in species)]
if unused: errors.append('groups with no species: ' + ', '.join(unused))
if errors:
    print('\n'.join(errors)); sys.exit(1)

species.sort(key=lambda e: e['n'].lower())
with open(os.path.join(ROOT, 'site', 'species.json'), 'w', encoding='utf-8') as f:
    json.dump({'v': 1, 'groups': groups, 'species': species}, f, ensure_ascii=False, separators=(',', ':'))

# compact copy for the Worker: only what it needs to attach tell-apart tips
members = {g: [e['n'] for e in species if e.get('g') == g] for g in groups}
lookup = {}
for e in species:
    if e.get('g'):
        for key in [e['n'], e['s']] + e.get('a', []):
            lookup[norm(key)] = e['g']
names = {'f': [], 's': [], 'b': []}
for e in species:
    for c in e['w']:
        if c in names and e['n'] not in ('Aquarium Plant',): names[c].append(e['n'])
worker_db = {'g': {g: dict({'n': groups[g]['n'], 'tip': groups[g]['tip'], 'm': members[g]}, **({'h': 1} if groups[g].get('h') else {})) for g in groups}, 'k': lookup, 'nm': names}
blob = json.dumps(worker_db, ensure_ascii=False, separators=(',', ':'))
wp = os.path.join(ROOT, 'schooled-worker.js')
w = open(wp, encoding='utf-8').read()
new = '/* DB:BEGIN (generated by db/build_db.py, do not edit by hand) */\nconst DB = ' + blob + ';\n/* DB:END */'
if '/* DB:BEGIN' in w:
    w = re.sub(r'/\* DB:BEGIN.*?/\* DB:END \*/', lambda m: new, w, flags=re.S)
    open(wp, 'w', encoding='utf-8').write(w)
    print('worker db refreshed')
else:
    print('worker has no DB markers yet (skipped)')
kinds = {}
for e in species: kinds[e['k']] = kinds.get(e['k'], 0) + 1
print(len(species), 'species,', len(groups), 'groups', kinds, 'json bytes', os.path.getsize(os.path.join(ROOT, 'site', 'species.json')), 'worker blob bytes', len(blob))
