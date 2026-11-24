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
from accuracy_check import SpeciesDB, commons_candidates, download, norm_key, pct, genus_of, ORIGIN, UA

TILE = 640


def montage(img, boxes):
    """Same close-up picture the app builds: up to three padded crops of one kind of animal, side by side."""
    W, H = img.size
    tiles = []
    for b in sorted(boxes, key=lambda b: -(b[2] - b[0]) * (b[3] - b[1]))[:3]:
        x1, x2, y1, y2 = b[1] / 1000 * W, b[3] / 1000 * W, b[0] / 1000 * H, b[2] / 1000 * H
        px, py = (x2 - x1) * 0.3, (y2 - y1) * 0.3
        x1, x2, y1, y2 = max(0, x1 - px), min(W, x2 + px), max(0, y1 - py), min(H, y2 + py)
        w, h = max(16, x2 - x1), max(16, y2 - y1)
        k = min(2.5, 480 / max(w, h))
        tiles.append((img.crop((int(x1), int(y1), int(x1 + w), int(y1 + h))).resize((max(8, round(w * k)), max(8, round(h * k)))),))
    if not tiles:
        return None
    gap = 6
    width = sum(t[0].width for t in tiles) + gap * (len(tiles) - 1)
    height = max(t[0].height for t in tiles)
    sheet = Image.new('RGB', (width, height), (34, 34, 34))
    x = 0
    for t in tiles:
        sheet.paste(t[0], (x, 0))
        x += t[0].width + gap
    if width > 1400:
        sheet = sheet.resize((1400, max(1, round(height * 1400 / width))))
    out = io.BytesIO()
    sheet.save(out, 'JPEG', quality=88)
    return out.getvalue()


def call_verify(worker, key, montages, items, tank_type, ground=False):
    headers = {'Origin': ORIGIN, 'Content-Type': 'application/json'}
    if key:
        headers['X-Test-Key'] = key
    body = {'mode': 'verify', 'mime': 'image/jpeg', 'images': [base64.b64encode(m).decode() for m in montages], 'items': items, 'tank_type': tank_type}
    if ground:
        body['ground'] = True
    for attempt in range(3):
        try:
            r = requests.post(worker.rstrip('/') + '/scan', json=body, headers=headers, timeout=90)
            if r.status_code == 429:
                time.sleep(65)
                continue
            return r.json()
        except (requests.RequestException, ValueError):
            time.sleep(5)
    return {'ok': False}


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
    ap.add_argument('--no-verify', dest='verify', action='store_false', help='skip the zoom-in check the app does after the first look')
    ap.add_argument('--no-ground', dest='ground', action='store_false', help='skip the side-by-side run where the zoom-in check may use Google search')
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

    photo_cache, results, sent, sent_verify = {}, [], 0, 0
    sent_ground, searches = 0, 0
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
            found.append({'said': sp.get('common_name', ''), 'matched': hit['n'] if hit else '', 'count': sp.get('count', 0), 'conf': sp.get('confidence', 0), 'kind': sp.get('kind', ''), 'boxes': sp.get('boxes') or [], 'alts': sp.get('alternatives') or [], 'first': sp.get('common_name', '')})
        if a.verify:
            sheet = Image.open(io.BytesIO(jpg)).convert('RGB')
            targets = []
            for f in found:
                hit = db.find(f['matched']) if f['matched'] else None
                grp = db.groups.get(hit['g']) if hit and hit.get('g') else None
                if (f['kind'] in ('fish', 'coral', 'invert', 'plant') or grp) and f['boxes'] and (f['conf'] < 0.9 or (grp and grp.get('h')) or not hit):
                    targets.append(f)
            targets = sorted(targets, key=lambda f: f['conf'])[:6]
            if targets:
                ms = [montage(sheet, f['boxes']) for f in targets]
                pairs = [(f, m) for f, m in zip(targets, ms) if m]
                if pairs:
                    items = [{'name': f['said'], 'kind': f['kind'], 'count': f['count'], 'alternatives': f['alts']} for f, m in pairs]
                    chk = call_verify(a.worker, key, [m for f, m in pairs], items, ttype)
                    sent_verify += 1
                    for it in chk.get('items') or []:
                        if it.get('index') is None or it['index'] >= len(pairs):
                            continue
                        f = pairs[it['index']][0]
                        if (it.get('confidence') or 0) >= 0.45 and not str(it.get('common_name', '')).lower().startswith('unidentified'):
                            hit, how = db.resolve(it.get('common_name'), it.get('scientific_name'))
                            f['said'] = it.get('common_name', f['said'])
                            f['matched'] = hit['n'] if hit else ''
                            f['conf'] = it.get('confidence')
                    if a.ground:
                        gchk = call_verify(a.worker, key, [m for f, m in pairs], items, ttype, ground=True)
                        sent_ground += 1
                        searches += len((gchk.get('ground') or {}).get('queries') or [])
                        for f, m in pairs:
                            f['g_said'], f['g_matched'] = None, None
                        for it in gchk.get('items') or []:
                            if it.get('index') is None or it['index'] >= len(pairs):
                                continue
                            f = pairs[it['index']][0]
                            if (it.get('confidence') or 0) >= 0.45 and not str(it.get('common_name', '')).lower().startswith('unidentified'):
                                hit, how = db.resolve(it.get('common_name'), it.get('scientific_name'))
                                f['g_said'] = it.get('common_name')
                                f['g_matched'] = hit['n'] if hit else ''
                        gq = (gchk.get('ground') or {}).get('queries') or []
                        for f, m in pairs:
                            f['g_queries'] = len(gq)
            for f in found:
                f['nbox'] = len(f.get('boxes') or [])
                f['verify_target'] = any(f is t for t in targets)
                f.pop('boxes', None)
        row['found'] = found
        row['too_far'] = bool(data.get('too_far'))
        got = {f['matched'] for f in found if f['matched']}
        row['hits'] = [e['n'] for e in truth if e['n'] in got or any(f['matched'] and db.find(f['matched']) and norm_key(db.find(f['matched']).get('s', '')) == norm_key(e.get('s', '')) for f in found)]
        row['missed'] = [e['n'] for e in truth if e['n'] not in row['hits']]
        if a.ground:
            gm = {(f['g_matched'] if f.get('g_matched') is not None else f['matched']) for f in found if (f.get('g_matched') if f.get('g_matched') is not None else f['matched'])}
            row['hits_ground'] = [e['n'] for e in truth if e['n'] in gm or any(m and db.find(m) and norm_key(db.find(m).get('s', '')) == norm_key(e.get('s', '')) for m in gm)]
            row['extra_ground'] = sum(1 for f in found if (f.get('g_matched') if f.get('g_matched') is not None else f['matched']) not in {e['n'] for e in truth})
        names = {e['n'] for e in truth}
        row['extra'] = [f for f in found if f['matched'] not in names]
        row['counts'] = {f['matched']: f['count'] for f in found if f['matched'] in names}
        results.append(row)
        print('Tank %d: %d of %d found' % (ti + 1, len(row['hits']), len(truth)))
        time.sleep(delay)

    write_report(a, results, sent, sent_verify, db, sent_ground, searches)


def write_report(a, results, sent, sent_verify, db, sent_ground=0, searches=0):
    ok = [r for r in results if 'found' in r]
    total = sum(len(r['truth']) for r in ok)
    hits = sum(len(r['hits']) for r in ok)
    extras = sum(len(r['extra']) for r in ok)
    reported = sum(len(r['found']) for r in ok)
    def near(truth_name, row):
        t = db.find(truth_name)
        for f in row['found']:
            h = db.find(f['matched']) if f['matched'] else None
            if h and t and h['n'] != t['n'] and ((h.get('g') and h.get('g') == t.get('g')) or (genus_of(h.get('s')) and genus_of(h.get('s')) == genus_of(t.get('s')))):
                return True
        return False
    nearmiss = sum(1 for r in ok for n in r['missed'] if near(n, r))
    exact1 = sum(1 for r in ok for n, c in r['counts'].items() if c == 1)
    counted = sum(len(r['counts']) for r in ok)
    lines = ['# Schooled tank scan check', '',
             'Run: %s UTC. Worker: %s' % (datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M'), a.worker), '',
             'Each test tank is a grid of single-species Wikimedia Commons photos, so the right answer is known. This tests naming and counting across several species at once, not reflections or overlapping fish.', '',
             '**%d test tanks, %d species placed.**' % (len(ok), total), '',
             '| Measure | Result |', '|---|---|',
             '| Species found (recall) | %d of %d (%s) |' % (hits, total, pct(hits, total)),
             '| Answers that were really in the tank (precision) | %d of %d (%s) |' % (reported - extras, reported, pct(reported - extras, reported)),
             '| Missed but named a close relative (same genus or look-alike group) | %d |' % nearmiss,
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
    nb = sum(1 for r in ok for f in r['found'] if f.get('nbox'))
    nt = sum(1 for r in ok for f in r['found'] if f.get('verify_target'))
    lines += ['Answers that came with a location box (needed for the zoom-in step): %d of %d. Chosen for a zoom-in check: %d.' % (nb, reported, nt), '']
    lines += ['## Every test tank', '', '| Tank | Water | In the picture | Found | Missed | Extras |', '|---|---|---|---|---|---|']
    for r in ok:
        lines.append('| %d | %s | %s | %d | %s | %s |' % (r['tank'], r['type'], ', '.join(r['truth']), len(r['hits']), ', '.join(r['missed']) or '-', ', '.join(f['said'] for f in r['extra']) or '-'))
    if sent_ground:
        gh = sum(len(r.get('hits_ground', r['hits'])) for r in ok)
        gx = sum(r.get('extra_ground', len(r['extra'])) for r in ok)
        changed = [(t['tank'] if 'tank' in t else 0, f) for t in ok for f in t['found'] if f.get('verify_target') and f.get('g_said') is not None]
        better, worse = [], []
        for t in ok:
            truthset = set(t['truth'])
            for f in t['found']:
                if not f.get('verify_target') or f.get('g_said') is None:
                    continue
                base_ok = f['matched'] in truthset
                g_ok = (f.get('g_matched') or '') in truthset
                if g_ok and not base_ok:
                    better.append('Tank %d: %s -> %s' % (t['tank'], f['said'], f['g_said']))
                elif base_ok and not g_ok:
                    worse.append('Tank %d: %s -> %s' % (t['tank'], f['said'], f['g_said']))
        lines += ['## Zoom-in check with Google search (side by side)', '',
                  'Same crops, checked twice: plain, and with the model allowed to use Google search. Search works from text, so it checks which features separate the candidates, not the photo itself.', '',
                  '| Measure | Zoom-in only | Zoom-in + Google search |', '|---|---|---|',
                  '| Species found (recall) | %d of %d (%s) | %d of %d (%s) |' % (hits, total, pct(hits, total), gh, total, pct(gh, total)),
                  '| Answers not in the tank | %d | %d |' % (extras, gx), '',
                  'Searches the model ran: %d across %d checks.' % (searches, sent_ground), '',
                  '**Search made it right (%d):** %s' % (len(better), '; '.join(better) or 'none'), '',
                  '**Search made it wrong (%d):** %s' % (len(worse), '; '.join(worse) or 'none'), '']
    lines += ['', '## Cost', '', '%d scans plus %d zoom-in checks. A first look costs about 0.55 cents and a zoom-in check roughly 0.3 cents, so this run cost about %.1f cents.' % (sent, sent_verify, sent * 0.55 + sent_verify * 0.3)]
    if sent_ground:
        lines += ['', 'Search run: %d extra zoom-in checks (about %.1f cents) plus %d searches. Google charges about 1.4 cents per search after the free monthly allowance, so at most about %.1f cents. Per scan that is roughly %.1f to %.1f cents on top.' % (sent_ground, sent_ground * 0.3, searches, searches * 1.4, (sent_ground * 0.3) / max(1, sent_ground), (sent_ground * 0.3 + searches * 1.4) / max(1, sent_ground))]
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
