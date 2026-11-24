#!/usr/bin/env python3
"""Schooled accuracy check.

Pulls labeled photos from Wikimedia Commons (searching by scientific name), sends each one to the Worker's
Fish Check (the same call the app makes), matches the answer to species.json the same way the app does, and
writes a report. Nothing is stored in the repo: photos are downloaded, used and discarded.
"""
import argparse, base64, collections, datetime, json, os, random, re, sys, time, unicodedata
import requests

UA = 'SchooledAccuracyCheck/1.0 (https://github.com/ericwoodliff54/schooled; test script)'
ORIGIN = 'https://ericwoodliff54.github.io'
BAD_WORDS = re.compile(r'\b(drawing|illustration|diagram|map|stamp|skeleton|painting|print|plate|logo|cartoon|sketch|specimen label|fossil|egg|larva|fry)\b', re.I)


def norm_key(text):
    t = unicodedata.normalize('NFD', str(text).lower())
    t = ''.join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"['’]", '', t)
    return re.sub(r'[^a-z0-9]+', ' ', t).strip()


class SpeciesDB:
    """Same matching order as the app: common name, then scientific name, then genus."""

    def __init__(self, path):
        data = json.load(open(path, encoding='utf-8'))
        self.groups = data.get('groups', {})
        self.list = data['species']
        self.by_key, self.by_genus = {}, {}
        for e in self.list:
            g = re.match(r'^([A-Z][a-z]+)( sp\.?)?$', e.get('s') or '')
            if g:
                self.by_genus[norm_key(g.group(1))] = e
            for key in [e['n'], e.get('s', '')] + list(e.get('a') or []):
                k = norm_key(key)
                if k and k not in self.by_key:
                    self.by_key[k] = e

    def find(self, name):
        return self.by_key.get(norm_key(name)) if name else None

    def resolve(self, common, scientific):
        common = re.sub(r'\s*\(.*?(\)|$)', '', (common or '').split(' / ')[0]).strip()
        hit = self.find(common)
        how = 'exact' if hit else ''
        if not hit and scientific:
            hit = self.find(scientific)
            how = 'alias' if hit else ''
            if not hit:
                hit = self.by_genus.get(norm_key(scientific.strip().split()[0]))
                how = 'genus' if hit else ''
        return hit, how


def genus_of(sci):
    w = (sci or '').strip().split()
    return norm_key(w[0]) if w else ''


def commons_candidates(api, sci, rng, want):
    """Photos of one species from Wikimedia Commons: list of dicts with thumb url, title, license, page."""
    params = {
        'action': 'query', 'format': 'json', 'generator': 'search', 'gsrsearch': sci + ' filetype:bitmap',
        'gsrnamespace': 6, 'gsrlimit': 40, 'prop': 'imageinfo', 'iiprop': 'url|mime|size|extmetadata',
        'iiurlwidth': 1024, 'iiextmetadatafilter': 'LicenseShortName|ImageDescription|Categories|Artist',
    }
    r = requests.get(api, params=params, headers={'User-Agent': UA}, timeout=40)
    r.raise_for_status()
    pages = (r.json().get('query') or {}).get('pages') or {}
    full = norm_key(re.sub(r"\b(sp|spp|var|cf)\b\.?", '', sci))
    genus = genus_of(sci)
    out = []
    for p in pages.values():
        ii = (p.get('imageinfo') or [None])[0]
        if not ii or ii.get('mime') not in ('image/jpeg', 'image/png'):
            continue
        if (ii.get('width') or 0) < 600 or (ii.get('height') or 0) < 400:
            continue
        meta = ii.get('extmetadata') or {}
        title = p.get('title', '')
        text = norm_key(' '.join([title] + [str((meta.get(k) or {}).get('value', '')) for k in ('ImageDescription', 'Categories')]))
        if BAD_WORDS.search(title):
            continue
        needle = full if len(full.split()) >= 2 else genus
        if needle not in text:
            continue
        out.append({
            'title': title, 'url': ii.get('thumburl') or ii.get('url'), 'mime': ii.get('mime'),
            'page': ii.get('descriptionurl', ''), 'license': (meta.get('LicenseShortName') or {}).get('value', ''),
            'artist': re.sub(r'<[^>]+>', '', str((meta.get('Artist') or {}).get('value', '')))[:60],
        })
    rng.shuffle(out)
    return out[: want + 4]


def download(url):
    for attempt in range(3):
        try:
            r = requests.get(url, headers={'User-Agent': UA}, timeout=40)
            if r.status_code == 429:
                time.sleep(10 * (attempt + 1))
                continue
            r.raise_for_status()
            if len(r.content) > 1_900_000:
                return None
            return r.content
        except requests.RequestException:
            time.sleep(3)
    return None


def call_worker(worker, key, image, mime, tank_type):
    headers = {'Origin': ORIGIN, 'Content-Type': 'application/json'}
    if key:
        headers['X-Test-Key'] = key
    body = {'mode': 'fish', 'mime': mime, 'images': [base64.b64encode(image).decode()], 'tank_type': tank_type}
    for attempt in range(4):
        try:
            r = requests.post(worker.rstrip('/') + '/scan', json=body, headers=headers, timeout=70)
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
    ap.add_argument('--names-file', default='test_species.txt')
    ap.add_argument('--names', default='', help='comma list; overrides the names file')
    ap.add_argument('--kinds', default='', help='comma list: fish, coral, plant, shrimp, snail, invert')
    ap.add_argument('--limit', type=int, default=25, help='how many species to test (random sample, repeatable)')
    ap.add_argument('--per', type=int, default=2, help='photos per species')
    ap.add_argument('--max-photos', type=int, default=120, help='hard cap on photos sent')
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--worker', default='https://schooled-worker.ericwoodliff.workers.dev')
    ap.add_argument('--commons', default='https://commons.wikimedia.org/w/api.php')
    ap.add_argument('--delay', type=float, default=-1, help='seconds between Worker calls (default 1, or 45 without a test key)')
    ap.add_argument('--out', default='accuracy-out')
    a = ap.parse_args()

    key = os.environ.get('TEST_KEY', '').strip()
    delay = a.delay if a.delay >= 0 else (1.0 if key else 45.0)
    db = SpeciesDB(a.species_json)
    rng = random.Random(a.seed)

    wanted = [n.strip() for n in a.names.split(',') if n.strip()] if a.names.strip() else \
        [l.strip() for l in open(a.names_file, encoding='utf-8') if l.strip() and not l.startswith('#')]
    kinds = {k.strip() for k in a.kinds.split(',') if k.strip()}
    chosen, seen, skipped = [], set(), []
    for n in wanted:
        e = db.find(n)
        if not e:
            print('Not in the species list, skipped:', n)
            skipped.append(n + ' (not in the species list)')
            continue
        if e['n'] in seen or (kinds and e['k'] not in kinds):
            if kinds and e['k'] not in kinds:
                skipped.append(n + ' (kind is ' + e['k'] + ', not in: ' + ', '.join(sorted(kinds)) + ')')
            continue
        if (e.get('s') or '').strip().lower() in ('plantae', 'animalia', ''):
            print('Too generic to test, skipped:', n)
            skipped.append(n + ' (too generic to test)')
            continue
        seen.add(e['n'])
        chosen.append(e)
    if not chosen:
        print('Nothing to test. Wanted %d names, none usable (kinds filter: %r).' % (len(wanted), a.kinds))
        for x in skipped[:30]:
            print('  -', x)
        sys.exit(1)
    if a.limit and len(chosen) > a.limit:
        chosen = rng.sample(chosen, a.limit)
    chosen.sort(key=lambda e: (e['k'], e['n']))
    per = max(1, min(a.per, 6))
    cap = max(1, a.max_photos)
    print('Testing %d species, up to %d photos each (cap %d photos).' % (len(chosen), per, cap))

    results, sent, errors_in_row, usage_in, usage_out = [], 0, 0, 0, 0
    models = collections.Counter()
    for e in chosen:
        if sent >= cap or errors_in_row >= 6:
            break
        try:
            cands = commons_candidates(a.commons, e['s'], rng, per)
        except Exception as err:
            print('Commons search failed for', e['n'], str(err)[:80])
            results.append({'expected': e['n'], 'kind': e['k'], 'verdict': 'no_photo', 'detail': 'search failed'})
            continue
        got = 0
        for c in cands:
            if got >= per or sent >= cap:
                break
            img = download(c['url'])
            if not img:
                continue
            tank = 'Saltwater' if 's' in e.get('w', 'f') and 'f' not in e.get('w', 'f') else 'Freshwater'
            data = call_worker(a.worker, key, img, c['mime'], tank)
            sent += 1
            got += 1
            row = {'expected': e['n'], 'kind': e['k'], 'file': c['title'], 'page': c['page'], 'license': c['license'], 'artist': c['artist']}
            if not data.get('ok'):
                row.update(verdict='error', detail=str(data.get('error'))[:80])
                errors_in_row += 1
            else:
                errors_in_row = 0
                f = data.get('fish') or {}
                u = data.get('usage') or {}
                usage_in += u.get('input', 0)
                usage_out += u.get('output', 0)
                models[data.get('model', '?')] += 1
                hit, how = db.resolve(f.get('common_name'), f.get('scientific_name'))
                conf = f.get('confidence') or 0
                if hit and hit.get('g') and db.groups.get(hit['g'], {}).get('h'):
                    conf = min(conf, 0.85)  # the app never says Confident for look-alike groups
                row.update(answer=f.get('common_name', ''), sci=f.get('scientific_name', ''), conf=conf, matched=hit['n'] if hit else '', how=how)
                hl = f.get('health') or {}
                row.update(health=hl.get('status') or 'none', health_score=hl.get('score'), health_signs=hl.get('signs') or [])
                if not f.get('is_aquarium', True) or not f.get('common_name'):
                    row['verdict'] = 'no_answer'
                elif hit and (hit['n'] == e['n'] or norm_key(hit.get('s', '')) == norm_key(e.get('s', ''))):
                    row['verdict'] = 'correct'
                else:
                    alt_hits = [db.resolve(x, '')[0] for x in (f.get('alternatives') or [])]
                    same_genus = genus_of(hit['s'] if hit else f.get('scientific_name')) == genus_of(e['s'])
                    if any(h and h['n'] == e['n'] for h in alt_hits):
                        row['verdict'] = 'in_alternatives'
                    elif same_genus and genus_of(e['s']):
                        row['verdict'] = 'right_genus'
                    else:
                        row['verdict'] = 'wrong'
                    if not hit:
                        row['not_in_list'] = True
            results.append(row)
            time.sleep(delay)
        if got == 0:
            results.append({'expected': e['n'], 'kind': e['k'], 'verdict': 'no_photo', 'detail': 'no usable photo found'})

    write_report(a, db, results, sent, usage_in, usage_out, models)


def pct(n, d):
    return '%d%%' % round(100 * n / d) if d else '-'


def write_report(a, db, results, sent, uin, uout, models):
    scored = [r for r in results if r['verdict'] not in ('no_photo', 'error')]
    n = len(scored)
    c = collections.Counter(r['verdict'] for r in scored)
    lines = ['# Schooled accuracy check', '', 'Run: %s UTC. Worker: %s' % (datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M'), a.worker), '']
    lines += ['**%d photos checked** across %d species.' % (n, len({r['expected'] for r in scored})), '',
              '| Result | Photos | Share |', '|---|---|---|',
              '| Correct species | %d | %s |' % (c['correct'], pct(c['correct'], n)),
              '| Right answer in the alternatives | %d | %s |' % (c['in_alternatives'], pct(c['in_alternatives'], n)),
              '| Right genus, wrong species | %d | %s |' % (c['right_genus'], pct(c['right_genus'], n)),
              '| Wrong | %d | %s |' % (c['wrong'], pct(c['wrong'], n)),
              '| No answer | %d | %s |' % (c['no_answer'], pct(c['no_answer'], n)), '']
    errs = [r for r in results if r['verdict'] == 'error']
    nophoto = [r for r in results if r['verdict'] == 'no_photo']
    if errs or nophoto:
        lines += ['Not scored: %d Worker errors, %d species with no usable photo.' % (len(errs), len(nophoto)), '']

    hi = [r for r in scored if r.get('conf', 0) >= 0.95]
    tiers = [('Confident (95%% or more)', 0.95, 2), ('Likely (80 to 94%%)', 0.8, 0.95), ('Not sure (under 80%%)', 0, 0.8)]
    lines += ['## Do the labels mean anything?', '', '| Label in the app | Photos | Correct |', '|---|---|---|']
    for name, lo, hi_ in tiers:
        rs = [r for r in scored if lo <= r.get('conf', 0) < hi_]
        lines.append('| ' + name % () + ' | %d | %s |' % (len(rs), pct(sum(1 for r in rs if r['verdict'] == 'correct'), len(rs))))
    lines.append('')

    lines += ['## By kind', '', '| Kind | Photos | Correct |', '|---|---|---|']
    for k in sorted({r['kind'] for r in scored}):
        rs = [r for r in scored if r['kind'] == k]
        lines.append('| %s | %d | %s |' % (k, len(rs), pct(sum(1 for r in rs if r['verdict'] == 'correct'), len(rs))))
    lines.append('')

    conf = collections.Counter((r['expected'], r.get('matched') or r.get('answer') or '(none)') for r in scored if r['verdict'] != 'correct')
    if conf:
        lines += ['## Most common mix-ups', '', '| Should be | App said | Times |', '|---|---|---|']
        for (exp, got), t in conf.most_common(15):
            lines.append('| %s | %s | %d |' % (exp, got, t))
        lines.append('')

    bad_hi = [r for r in hi if r['verdict'] != 'correct']
    if bad_hi:
        lines += ['## Wrong but Confident (the ones that matter most)', '', '| Should be | App said | Confidence | Photo |', '|---|---|---|---|']
        for r in bad_hi:
            lines.append('| %s | %s | %d%% | [%s](%s) |' % (r['expected'], r.get('answer', ''), round(100 * r['conf']), r['file'][5:60], r['page']))
        lines.append('')

    gaps = collections.Counter(r['answer'] for r in scored if r.get('not_in_list') and r.get('answer'))
    if gaps:
        lines += ['## Names the app said that are not in the species list', '', ', '.join('%s (%d)' % (k, v) for k, v in gaps.most_common(20)), '']

    hs = collections.Counter(r.get('health', 'none') for r in scored)
    nh = sum(hs.values())
    labels = [('healthy', 'Healthy'), ('some_concerns', 'Some concerns'), ('unwell', 'Unwell'), ('cannot_tell', "Can't tell"), ('none', 'No health answer')]
    lines += ['## Health check', '']
    if nh:
        lines += ['| Result | Photos | Share |', '|---|---|---|']
    for key, label in labels:
        if hs.get(key):
            lines.append('| %s | %d | %s |' % (label, hs[key], pct(hs[key], nh)))
    scores = [r['health_score'] for r in scored if isinstance(r.get('health_score'), (int, float))]
    if scores:
        lines += ['', 'Average health score where one was given: %d/100 (these are photos from Wikimedia Commons, mostly healthy fish, so most should score well).' % round(sum(scores) / len(scores))]
    why = collections.Counter(x for r in scored if r.get('health') in ('cannot_tell', 'some_concerns', 'unwell') for x in r.get('health_signs', []))
    if why:
        lines += ['', 'Reasons given for concerns or "can\'t tell":', '']
        lines += ['- %s (%d)' % (k, v) for k, v in why.most_common(10)]
    lines.append('')

    lines += ['## Every species', '', '| Species | Photos | Correct | What the app said |', '|---|---|---|---|']
    for e in sorted({(r['kind'], r['expected']) for r in scored}):
        rs = [r for r in scored if r['expected'] == e[1]]
        said = '; '.join('%s%s' % (r.get('answer', '') or '-', '' if r['verdict'] == 'correct' else ' (x)') for r in rs)
        lines.append('| %s | %d | %d | %s |' % (e[1], len(rs), sum(1 for r in rs if r['verdict'] == 'correct'), said))
    lines.append('')
    lines += ['## Cost', '', '%d Worker calls. Tokens in: %d, out: %d. Models: %s. At the measured ~0.15 cents per Fish Check this run cost roughly %.1f cents.' % (sent, uin, uout, ', '.join('%s x%d' % kv for kv in models.items()) or '-', sent * 0.15), '',
              'Photos come from Wikimedia Commons under free licenses; the links above lead to each photo page with its author and license.']
    os.makedirs(a.out, exist_ok=True)
    text = '\n'.join(lines) + '\n'
    open(os.path.join(a.out, 'report.md'), 'w', encoding='utf-8').write(text)
    json.dump(results, open(os.path.join(a.out, 'results.json'), 'w', encoding='utf-8'), indent=1)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        open(summary, 'a', encoding='utf-8').write(text)
    print(text[:1800])


if __name__ == '__main__':
    main()
