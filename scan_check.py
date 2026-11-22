#!/usr/bin/env python3
"""Schooled tank-scan check.

Builds test "tanks" by tiling single-species Wikimedia Commons photos into one picture (2x2 grid), sends each to
the Worker's tank scan (first pass, the same call the app makes), and checks that the species you put in come back out.
It is not a real tank photo (no reflections, no overlap), so it tests naming and counting across several species at once.
"""
import argparse, base64, collections, datetime, io, json, os, random, sys, time
import requests
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from accuracy_check import SpeciesDB, commons_candidates, download, norm_key, pct, ORIGIN, UA

TILE = 640


def call_scan(worker, key, jpg, tank_type):
    headers = {'Origin': ORIGIN, 'Content-Type': 'application/json'}
    if key:
        headers['X-Test-Key'] = key
    body = {'mode': 'single', 'mime': 'image/jpeg', 'images': [base64.b64encode(jpg).decode()], 'tank_type': tank_type}
    data = {'ok': False, 'error': 'no response'}
    for attempt in range(4):
        try:
            r = requests.post(worker.rstrip('/') + '/scan', json=body, headers=headers, timeout=90)
        except requests.RequestException as err:
            return {'ok': False, 'error': 'network: ' + str(err)[:80]}
        if r.status_code == 429:
            time.sleep(65)
            continue
        try:
            data = r.json()
        except ValueError:
            return {'ok': False, 'error': 'http %d' % r.status_code}
        if data.get('ok') or r.status_code < 500:
            return data
        time.sleep(5)
    return data


def tile_image(blobs, n):
    cols = 2 if n <= 4 else 3
    rows = (n + cols - 1) // cols
    sheet = Image.new('RGB', (cols * TILE, rows * TILE), (20, 20, 20))
    for i, b in enumerate(blobs):
        im = Image.open(io.BytesIO(b)).convert('RGB')
        w, h = im.size
        k = max(TILE / w, TILE / h)
        im = im.resize((max(1, round(w * k)), max(1, round(h * k))))
        left, top = (im.width - TILE) // 2, (im.height - TILE) // 2
        sheet.paste(im.crop((left, top, left + TILE, top + TILE)), ((i % cols) * TILE, (i // cols) * TILE))
    out = io.BytesIO()
    sheet.save(out, 'JPEG', quality=82)
    return out.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--species-json', default='species.json')
    ap.add_argument('--names-file', default='test_species.txt')
    ap.add_argument('--tanks', type=int, default=10, help='how many test tanks to build')
    ap.add_argument('--per', type=int, default=4, help='species per tank (2 to 6)')
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--worker', default='https://schooled-worker.ericwoodliff.workers.dev')
    ap.add_argument('--commons', default='https://commons.wikimedia.org/w/api.php')
    ap.add_argument('--delay', type=float, default=-1)
    ap.add_argument('--out', default='scan-out')
    a = ap.parse_args()

    key = os.environ.get('TEST_KEY', '').strip()
    delay = a.delay if a.delay >= 0 else (1.0 if key else 60.0)
    db = SpeciesDB(a.species_json)
    rng = random.Random(a.seed)
    per = max(2, min(a.per, 6))
    pool = {'Freshwater': [], 'Saltwater': []}
    for l in open(a.names_file, encoding='utf-8'):
        l = l.strip()
        if not l or l.startswith('#'):
            continue
        e = db.find(l)
        if e and e['k'] in ('fish', 'coral', 'shrimp', 'invert', 'snail'):
            pool['Saltwater' if e['w'] == 's' else 'Freshwater'].append(e)
    print('Species pool: %d freshwater, %d saltwater' % (len(pool['Freshwater']), len(pool['Saltwater'])))

    photo_cache, results, sent = {}, [], 0
    for ti in range(a.tanks):
        ttype = 'Saltwater' if ti % 3 == 2 and len(pool['Saltwater']) >= per else 'Freshwater'
        if len(pool[ttype]) < per:
            continue
        picks = rng.sample(pool[ttype], per)
        blobs, truth = [], []
        for e in picks:
            if e['n'] not in photo_cache:
                try:
                    cands = commons_candidates(a.commons, e['s'], rng, 1)
                except Exception:
                    cands = []
                blob = None
                for c in cands:
                    blob = download(c['url'])
                    if blob:
                        break
                photo_cache[e['n']] = blob
                time.sleep(1)
            if photo_cache[e['n']]:
                blobs.append(photo_cache[e['n']])
                truth.append(e)
        if len(truth) < 2:
            continue
        jpg = tile_image(blobs, len(truth))
        data = call_scan(a.worker, key, jpg, ttype)
        sent += 1
        row = {'tank': ti + 1, 'type': ttype, 'truth': [e['n'] for e in truth]}
        if not data.get('ok'):
            row['error'] = str(data.get('error'))[:80]
            results.append(row)
            time.sleep(delay)
            continue
        found = []
        for sp in data.get('species') or []:
            hit, how = db.resolve(sp.get('common_name'), sp.get('scientific_name'))
            found.append({'said': sp.get('common_name', ''), 'matched': hit['n'] if hit else '', 'count': sp.get('count', 0), 'conf': sp.get('confidence', 0), 'kind': sp.get('kind', '')})
        row['found'] = found
        row['too_far'] = bool(data.get('too_far'))
        got = {f['matched'] for f in found if f['matched']}
        row['hits'] = [e['n'] for e in truth if e['n'] in got or any(f['matched'] and db.find(f['matched']) and norm_key(db.find(f['matched']).get('s', '')) == norm_key(e.get('s', '')) for f in found)]
        row['missed'] = [e['n'] for e in truth if e['n'] not in row['hits']]
        names = {e['n'] for e in truth}
        row['extra'] = [f for f in found if f['matched'] not in names]
        row['counts'] = {f['matched']: f['count'] for f in found if f['matched'] in names}
        results.append(row)
        print('Tank %d: %d of %d found' % (ti + 1, len(row['hits']), len(truth)))
        time.sleep(delay)

    write_report(a, results, sent)


def write_report(a, results, sent):
    ok = [r for r in results if 'found' in r]
    total = sum(len(r['truth']) for r in ok)
    hits = sum(len(r['hits']) for r in ok)
    extras = sum(len(r['extra']) for r in ok)
    reported = sum(len(r['found']) for r in ok)
    exact1 = sum(1 for r in ok for n, c in r['counts'].items() if c == 1)
    counted = sum(len(r['counts']) for r in ok)
    lines = ['# Schooled tank scan check', '',
             'Run: %s UTC. Worker: %s' % (datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M'), a.worker), '',
             'Each test tank is a grid of single-species Wikimedia Commons photos, so the right answer is known. This tests naming and counting across several species at once, not reflections or overlapping fish.', '',
             '**%d test tanks, %d species placed.**' % (len(ok), total), '',
             '| Measure | Result |', '|---|---|',
             '| Species found (recall) | %d of %d (%s) |' % (hits, total, pct(hits, total)),
             '| Answers that were really in the tank (precision) | %d of %d (%s) |' % (reported - extras, reported, pct(reported - extras, reported)),
             '| Count right (one of each) | %d of %d (%s) |' % (exact1, counted, pct(exact1, counted)), '']
    errs = [r for r in results if 'error' in r]
    if errs:
        lines += ['%d tanks had Worker errors and were not scored.' % len(errs), '']
    miss = collections.Counter(n for r in ok for n in r['missed'])
    if miss:
        lines += ['## Species the scan missed most', '', '| Species | Times missed |', '|---|---|'] + ['| %s | %d |' % kv for kv in miss.most_common(12)] + ['']
    ex = collections.Counter(f['said'] or '(none)' for r in ok for f in r['extra'])
    if ex:
        lines += ['## Extra names it reported that were not in the tank', '', ', '.join('%s (%d)' % kv for kv in ex.most_common(15)), '']
    lines += ['## Every test tank', '', '| Tank | Water | In the picture | Found | Missed | Extras |', '|---|---|---|---|---|---|']
    for r in ok:
        lines.append('| %d | %s | %s | %d | %s | %s |' % (r['tank'], r['type'], ', '.join(r['truth']), len(r['hits']), ', '.join(r['missed']) or '-', ', '.join(f['said'] for f in r['extra']) or '-'))
    lines += ['', '## Cost', '', '%d scans. A first-pass scan costs about 0.55 cents, so this run cost roughly %.1f cents.' % (sent, sent * 0.55)]
    os.makedirs(a.out, exist_ok=True)
    text = '\n'.join(lines) + '\n'
    open(os.path.join(a.out, 'scan-report.md'), 'w', encoding='utf-8').write(text)
    json.dump(results, open(os.path.join(a.out, 'scan-results.json'), 'w', encoding='utf-8'), indent=1)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        open(summary, 'a', encoding='utf-8').write(text)
    print(text[:1500])


if __name__ == '__main__':
    main()
