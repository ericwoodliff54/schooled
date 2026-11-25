#!/usr/bin/env python3
"""Schooled photo test set check.

Sends every photo in a folder (default: testset/) to the Worker's Fish Check, the same call the app makes, compares the
answer with labels.csv, and writes a report. The photos are NOT kept in this repo (they are other people's photos):
they live in a private repo that the workflow checks out into testset/.

labels.csv columns: file, expected (scientific name), mode
  species         score on the exact species
  genus           score on the genus only (for hybrids, localities, "sp." names)
  species_unsure  scored like species, but listed apart because the label is a best guess
  text            y if the photo has a visible watermark or caption (the AI can read the name off it), n if clean
  review          no label yet: the app's answer is recorded so a person can fill the label in
"""
import argparse, base64, collections, csv, datetime, json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests
from accuracy_check import SpeciesDB, norm_key, genus_of, pct, ORIGIN, RUN_COST, add_cost


def call_worker(worker, key, image, variant, tank):
    """variant: 'app' (exactly what the app does) or 'model[+ground][+solo]'. +ground lets the model use Google Search,
    +solo skips the automatic second opinion. Test runs only (needs TEST_KEY)."""
    headers = {'Origin': ORIGIN, 'Content-Type': 'application/json'}
    if key:
        headers['X-Test-Key'] = key
    body = {'mode': 'fish', 'mime': 'image/jpeg', 'images': [base64.b64encode(image).decode()], 'tank_type': tank}
    if variant != 'app':
        parts = variant.split('+')
        if parts[0] != 'default':
            body['model'] = parts[0]
        if 'ground' in parts:
            body['ground'] = True
        if 'solo' in parts:
            body['escalate'] = False
        for x in parts:
            if x.startswith('res='):
                body['res'] = x[4:]
            if x.startswith('think='):
                body['think'] = x[6:]
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--species-json', default='species.json')
    ap.add_argument('--dir', default='testset')
    ap.add_argument('--worker', default='https://schooled-worker.ericwoodliff.workers.dev')
    ap.add_argument('--tank', default='Freshwater')
    ap.add_argument('--variants', default='app', help="comma list, e.g. app,gemini-3.5-flash-lite+solo,gemini-3.6-flash+solo,gemini-4-hydrogen+solo,gemini-4-hydrogen+solo+ground")
    ap.add_argument('--delay', type=float, default=-1)
    ap.add_argument('--out', default='photo-out')
    a = ap.parse_args()
    key = os.environ.get('TEST_KEY', '').strip()
    delay = a.delay if a.delay >= 0 else (1.0 if key else 45.0)
    db = SpeciesDB(a.species_json)
    rows = list(csv.DictReader(open(os.path.join(a.dir, 'labels.csv'), encoding='utf-8')))
    summary = []
    for variant in [v.strip() for v in a.variants.split(',') if v.strip()]:
        print('=== variant:', variant)
        summary.append(run_variant(a, db, rows, key, delay, variant))
    if len(summary) > 1:
        L = ['# Model comparison (same photos, same labels)', '', '| Variant | Scored | Correct (all) | Correct (clean photos only) | Wrong | Wrong but Confident | Cents per photo | Tokens in | Tokens out |', '|---|---|---|---|---|---|---|---|---|']
        for v in summary:
            L.append('| %s | %d | %s | %s | %s | %d | %.2f | %d | %d |' % (v['variant'], v['n'], pct(v['c']['correct'], v['n']), pct(v['cl'][1], v['cl'][0]), pct(v['c']['wrong'], v['n']), v['bad_conf'], v['cost'], v['uin'], v['uout']))
        text = '\n'.join(L) + '\n'
        os.makedirs(a.out, exist_ok=True)
        open(os.path.join(a.out, 'comparison.md'), 'w', encoding='utf-8').write(text)
        sm = os.environ.get('GITHUB_STEP_SUMMARY')
        if sm:
            open(sm, 'a', encoding='utf-8').write(text)
        print(text)


def run_variant(a, db, rows, key, delay, variant):
    results, models, uin, uout, errs_in_row = [], collections.Counter(), 0, 0, 0
    RUN_COST[0] = 0.0
    for r in rows:
        path = os.path.join(a.dir, r['file'])
        if not os.path.exists(path):
            results.append(dict(r, verdict='missing'))
            continue
        if errs_in_row >= 6:
            break
        data = call_worker(a.worker, key, open(path, 'rb').read(), variant, a.tank)
        row = dict(r)
        if not data.get('ok'):
            row.update(verdict='error', detail=str(data.get('error'))[:80])
            errs_in_row += 1
            results.append(row)
            time.sleep(delay)
            continue
        errs_in_row = 0
        f = data.get('fish') or {}
        u = data.get('usage') or {}
        uin += u.get('input', 0)
        uout += u.get('output', 0)
        add_cost(data)
        models[data.get('model', '?')] += 1
        hit, how = db.resolve(f.get('common_name'), f.get('scientific_name'))
        conf = f.get('confidence') or 0
        alts = [str(x) for x in (f.get('alternatives') or [])]
        row.update(answer=f.get('common_name', ''), sci=f.get('scientific_name', ''), conf=conf, matched=hit['n'] if hit else '',
                   alternatives=alts, life_stage=f.get('life_stage', ''), features=f.get('features', ''), model=data.get('model', ''))
        exp, mode = (r.get('expected') or '').strip(), r.get('mode', 'review')
        if mode == 'review' or not exp:
            row['verdict'] = 'unlabeled'
        elif not f.get('common_name') or not f.get('is_aquarium', True):
            row['verdict'] = 'no_answer'
        else:
            exp_hit = db.find(exp)
            ans_sci = (hit.get('s') if hit else '') or f.get('scientific_name', '')
            same_sp = norm_key(ans_sci) == norm_key(exp) or (exp_hit and hit and hit['n'] == exp_hit['n'])
            same_genus = genus_of(ans_sci) == genus_of(exp) or genus_of(f.get('scientific_name')) == genus_of(exp)
            if mode == 'genus':
                row['verdict'] = 'correct' if same_genus else 'wrong'
            elif same_sp:
                row['verdict'] = 'correct'
            elif any(db.resolve(x, '')[0] and exp_hit and db.resolve(x, '')[0]['n'] == exp_hit['n'] for x in alts):
                row['verdict'] = 'in_alternatives'
            elif same_genus:
                row['verdict'] = 'right_genus'
            else:
                row['verdict'] = 'wrong'
            row['in_db'] = bool(exp_hit)
        results.append(row)
        time.sleep(delay)
    n, c, bad_conf, cl = write_report(a, results, models, uin, uout, variant)
    return {'variant': variant, 'n': n, 'c': c, 'bad_conf': bad_conf, 'uin': uin, 'uout': uout, 'cl': cl, 'cost': RUN_COST[0] * 100 / max(1, len(results))}


def write_report(a, results, models, uin, uout, variant='app'):
    scored = [r for r in results if r['verdict'] in ('correct', 'in_alternatives', 'right_genus', 'wrong', 'no_answer')]
    firm = [r for r in scored if r.get('mode') != 'species_unsure']
    c = collections.Counter(r['verdict'] for r in firm)
    n = len(firm)
    L = ['# Schooled photo test set: ' + variant, '', 'Run: %s UTC. Worker: %s' % (datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M'), a.worker), '',
         '**%d labeled photos scored** (%d more have a best-guess label, %d have no label yet).' % (n, sum(1 for r in scored if r.get('mode') == 'species_unsure'), sum(1 for r in results if r['verdict'] == 'unlabeled')), '',
         '| Result | Photos | Share |', '|---|---|---|',
         '| Correct | %d | %s |' % (c['correct'], pct(c['correct'], n)),
         '| Right answer in the alternatives | %d | %s |' % (c['in_alternatives'], pct(c['in_alternatives'], n)),
         '| Right genus, wrong species | %d | %s |' % (c['right_genus'], pct(c['right_genus'], n)),
         '| Wrong | %d | %s |' % (c['wrong'], pct(c['wrong'], n)),
         '| No answer | %d | %s |' % (c['no_answer'], pct(c['no_answer'], n)), '']
    clean = [r for r in firm if r.get('text') != 'y']
    txt = [r for r in firm if r.get('text') == 'y']
    L += ['## Clean photos vs photos with a watermark or caption', '', '| Photos | Scored | Correct |', '|---|---|---|',
          '| Clean (no text on the photo) | %d | %s |' % (len(clean), pct(sum(1 for r in clean if r['verdict'] == 'correct'), len(clean))),
          '| Has a watermark or caption | %d | %s |' % (len(txt), pct(sum(1 for r in txt if r['verdict'] == 'correct'), len(txt))), '',
          'Trust the clean row: the AI can read a name off a watermark.', '']
    tiers = [('Confident (95% or more)', 0.95, 2), ('Likely (80 to 94%)', 0.8, 0.95), ('Not sure (under 80%)', 0, 0.8)]
    L += ['## Do the labels mean anything?', '', '| Label in the app | Photos | Correct |', '|---|---|---|']
    for name, lo, hi in tiers:
        rs = [r for r in firm if lo <= r.get('conf', 0) < hi]
        L.append('| %s | %d | %s |' % (name, len(rs), pct(sum(1 for r in rs if r['verdict'] == 'correct'), len(rs))))
    L.append('')
    bad = [r for r in firm if r['verdict'] in ('wrong', 'right_genus', 'in_alternatives', 'no_answer')]
    L += ['## Misses', '', '| Photo | Should be | App said | Conf | Result | Alternatives |', '|---|---|---|---|---|---|']
    for r in bad:
        L.append('| %s | %s | %s | %d%% | %s | %s |' % (r['file'][:-4][:34], r['expected'], r.get('answer', ''), round(100 * r.get('conf', 0)), r['verdict'], ', '.join(r.get('alternatives', []))[:60]))
    L.append('')
    unsure = [r for r in scored if r.get('mode') == 'species_unsure']
    if unsure:
        L += ['## Best-guess labels (check these before trusting a miss)', '', '| Photo | Label | App said | Result |', '|---|---|---|---|']
        for r in unsure:
            L.append('| %s | %s | %s | %s |' % (r['file'][:-4][:34], r['expected'], r.get('answer', ''), r['verdict']))
        L.append('')
    un = [r for r in results if r['verdict'] == 'unlabeled']
    if un:
        L += ['## No label yet: what the app said (fill in labels.csv with the right name)', '', '| Photo | App said | Scientific | Conf |', '|---|---|---|---|']
        for r in un:
            L.append('| %s | %s | %s | %d%% |' % (r['file'][:-4][:34], r.get('answer', ''), r.get('sci', ''), round(100 * r.get('conf', 0))))
        L.append('')
    notdb = [r for r in firm if r.get('in_db') is False]
    if notdb:
        L += ['## Labeled species that are not in species.json', '', ', '.join(sorted({r['expected'] for r in notdb})), '']
    errs = [r for r in results if r['verdict'] == 'error']
    if errs:
        L += ['%d Worker errors (not scored): %s' % (len(errs), '; '.join(sorted({r.get('detail', '') for r in errs}))), '']
    L += ['## Cost', '', '%d Worker calls. Tokens in: %d, out: %d. Models: %s. Cost at list prices: %.1f cents, %.2f cents per photo.' % (len(results), uin, uout, ', '.join('%s x%d' % kv for kv in models.items()) or '-', RUN_COST[0] * 100, RUN_COST[0] * 100 / max(1, len(results)))]
    out = os.path.join(a.out, re.sub(r'[^A-Za-z0-9.+-]+', '_', variant))
    os.makedirs(out, exist_ok=True)
    text = '\n'.join(L) + '\n'
    open(os.path.join(out, 'report.md'), 'w', encoding='utf-8').write(text)
    json.dump(results, open(os.path.join(out, 'results.json'), 'w', encoding='utf-8'), indent=1)
    s = os.environ.get('GITHUB_STEP_SUMMARY')
    if s:
        open(s, 'a', encoding='utf-8').write(text)
    print(text[:1500])
    cl = [r for r in firm if r.get('text') != 'y']
    return n, c, sum(1 for r in firm if r.get('conf', 0) >= 0.9 and r['verdict'] in ('wrong', 'right_genus')), (len(cl), sum(1 for r in cl if r['verdict'] == 'correct'))


if __name__ == '__main__':
    main()
