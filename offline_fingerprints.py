#!/usr/bin/env python3
"""Schooled offline fish ID, step 1: collect licensed photos, make fingerprints, and grade them.

For every species in species.json this script:
  1. finds photos that allow commercial use (iNaturalist research-grade photos, aquarium photos first,
     then Wikimedia Commons), keeping only CC0, public domain, CC BY and CC BY-SA licenses;
  2. turns each photo into a "fingerprint" (a list of numbers) with free, open image models, and keeps only
     the fingerprints, never the photos;
  3. holds some photos back and checks how often the right species comes out on top, so we know whether
     offline ID is good enough before building anything into the app.

Color varieties that share one scientific name (Picasso and Snowflake clownfish, goldfish types...) cannot be
told apart by iNaturalist, so their photos come from Wikimedia Commons searches by their own name, and the
report lists how many each one got.

Outputs (folder offline-out/): report.md, coverage.csv, credits.csv, fingerprints_<model>.npz
"""
import argparse, collections, concurrent.futures as cf, csv, datetime, io, json, os, random, re, sys, time, unicodedata
import requests

UA = 'SchooledOfflineID/1.0 (https://github.com/ericwoodliff54/schooled; builds species fingerprints)'
INAT = 'https://api.inaturalist.org/v1'
COMMONS = 'https://commons.wikimedia.org/w/api.php'
INAT_LICENSES = {'cc0', 'cc-by', 'cc-by-sa'}
COMMONS_OK = re.compile(r'^(cc0|cc-zero|public domain|pd\b|pd-|cc by(-sa)? \d)', re.I)
COMMONS_BAD = re.compile(r'\b(nc|nd|non-?commercial|noderiv)', re.I)
BAD_WORDS = re.compile(r'\b(drawing|illustration|diagram|map|stamp|skeleton|painting|print|plate|logo|cartoon|sketch|specimen label|fossil|egg|larva|fry|herbarium|preserved)\b', re.I)
MODELS = {
    'small': 'mobilenetv3_large_100.ra_in1k',
    'large': 'vit_small_patch14_dinov2.lvd142m',
}


def norm_key(text):
    t = unicodedata.normalize('NFD', str(text).lower())
    t = ''.join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"['’]", '', t)
    return re.sub(r'[^a-z0-9]+', ' ', t).strip()


def base_sci(sci):
    """'Premnas biaculeatus 'Gold Stripe'' -> 'Premnas biaculeatus'; 'Gastromyzon sp.' -> 'Gastromyzon'."""
    s = re.split(r"\s*['\"‘’(]", sci or '')[0].strip()
    s = re.split(r'\s+(?:var|subsp|ssp|f|cv)\.?\s', s)[0]
    s = re.sub(r'\s+(sp|spp|cf)\.?$', '', s).strip()
    return s if re.match(r'^[A-Z][a-z]+( [a-z][a-z-]+)?$', s) else ''


class Http:
    def __init__(self, min_gap):
        self.s = requests.Session()
        self.s.headers['User-Agent'] = UA
        self.min_gap, self.last = min_gap, 0.0

    def get_json(self, url, params):
        for attempt in range(4):
            wait = self.min_gap - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                r = self.s.get(url, params=params, timeout=40)
                if r.status_code in (429, 500, 502, 503):
                    time.sleep(15 * (attempt + 1))
                    continue
                r.raise_for_status()
                return r.json()
            except requests.RequestException:
                time.sleep(5 * (attempt + 1))
        return {}


def inat_taxon(api, name):
    rank = 'species' if ' ' in name else 'genus'
    j = api.get_json(INAT + '/taxa', {'q': name, 'rank': rank, 'is_active': 'true', 'per_page': 5})
    for t in j.get('results') or []:
        if (t.get('name') or '').lower() == name.lower():
            return t.get('id')
    return None


def inat_photos(api, taxon_id, want):
    """Research-grade photos with commercial-OK licenses: aquarium (captive) photos first, then wild ones."""
    out, seen = [], set()
    for captive in ('true', 'false'):
        if len(out) >= want:
            break
        j = api.get_json(INAT + '/observations', {
            'taxon_id': taxon_id, 'quality_grade': 'research' if captive == 'false' else 'any', 'captive': captive,
            'photo_license': ','.join(sorted(INAT_LICENSES)), 'photos': 'true', 'per_page': 60, 'order_by': 'votes'})
        for ob in j.get('results') or []:
            # captive observations cannot be research grade on iNaturalist; require community agreement instead
            if captive == 'true' and not (ob.get('community_taxon_id') == taxon_id or ob.get('quality_grade') == 'research'):
                continue
            for ph in (ob.get('photos') or [])[:1]:  # one photo per observation, for variety
                lic = (ph.get('license_code') or '').lower()
                url = (ph.get('url') or '').replace('/square.', '/medium.')
                if lic in INAT_LICENSES and url and url not in seen:
                    seen.add(url)
                    out.append({'url': url, 'source': 'iNaturalist' + (' (aquarium)' if captive == 'true' else ''),
                                'license': lic.upper(), 'author': (ph.get('attribution') or '')[:120],
                                'page': 'https://www.inaturalist.org/observations/' + str(ob.get('id'))})
    return out[:want]


def commons_photos(api, query, must_contain, want):
    j = api.get_json(COMMONS, {
        'action': 'query', 'format': 'json', 'generator': 'search', 'gsrsearch': query + ' filetype:bitmap',
        'gsrnamespace': 6, 'gsrlimit': 50, 'prop': 'imageinfo', 'iiprop': 'url|mime|size|extmetadata',
        'iiurlwidth': 500, 'iiextmetadatafilter': 'LicenseShortName|ImageDescription|Categories|Artist'})
    out = []
    for p in ((j.get('query') or {}).get('pages') or {}).values():
        ii = (p.get('imageinfo') or [None])[0]
        if not ii or ii.get('mime') not in ('image/jpeg', 'image/png') or (ii.get('width') or 0) < 400:
            continue
        meta = ii.get('extmetadata') or {}
        lic = str((meta.get('LicenseShortName') or {}).get('value', ''))
        if not COMMONS_OK.search(lic) or COMMONS_BAD.search(lic):
            continue
        title = p.get('title', '')
        if BAD_WORDS.search(title):
            continue
        text = norm_key(' '.join([title] + [str((meta.get(k) or {}).get('value', '')) for k in ('ImageDescription', 'Categories')]))
        if norm_key(must_contain) not in text:
            continue
        out.append({'url': ii.get('thumburl') or ii.get('url'), 'source': 'Wikimedia Commons', 'license': lic,
                    'author': re.sub(r'<[^>]+>', '', str((meta.get('Artist') or {}).get('value', '')))[:120],
                    'page': ii.get('descriptionurl', '')})
    return out[:want]


def download(session, url):
    for attempt in range(3):
        try:
            r = session.get(url, timeout=40)
            if r.status_code == 429:
                time.sleep(10 * (attempt + 1))
                continue
            r.raise_for_status()
            return r.content if len(r.content) < 3_000_000 else None
        except requests.RequestException:
            time.sleep(3)
    return None


class Embedder:
    def __init__(self, names):
        import timm, torch
        self.torch = torch
        torch.set_num_threads(max(1, os.cpu_count() or 1))
        self.models = {}
        for label, arch in names.items():
            kw = {'img_size': 224} if 'dinov2' in arch else {}
            m = timm.create_model(arch, pretrained=True, num_classes=0, **kw).eval()
            cfg = timm.data.resolve_data_config({}, model=m)
            cfg['input_size'] = (3, 224, 224)
            self.models[label] = (m, timm.data.create_transform(**cfg), sum(p.numel() for p in m.parameters()))

    def __call__(self, images):
        import numpy as np
        out = {}
        with self.torch.no_grad():
            for label, (m, tf, _) in self.models.items():
                x = self.torch.stack([tf(im) for im in images])
                f = m(x).float().numpy()
                out[label] = f / np.maximum(np.linalg.norm(f, axis=1, keepdims=True), 1e-8)
        return out


def plan_classes(db, kinds, water, limit, rng):
    """One class per species-list entry. Varieties that share a scientific name with other entries
    (or carry a variety name in quotes) get photos only from searches by their own common name."""
    species = [e for e in db['species'] if (not kinds or e['k'] in kinds) and (not water or water in e['w'])]
    by_base = collections.defaultdict(list)
    for e in species:
        by_base[base_sci(e.get('s', ''))].append(e)
    classes = []
    for e in species:
        b = base_sci(e.get('s', ''))
        shared = len(by_base[b]) > 1 if b else False
        variety = shared or bool(re.search(r"['\"‘’]", e.get('s', '')))
        classes.append({'name': e['n'], 'kind': e['k'], 'water': e['w'], 'group': e.get('g', ''), 'base': b,
                        'variety': variety, 'shared_with': [x['n'] for x in by_base[b] if x is not e] if shared else []})
    if limit:
        rng.shuffle(classes)
        classes = classes[:limit]
    return classes


def collect_variety(api, c, per):
    """A color variety: Wikimedia Commons photos found by its own name, e.g. "Picasso clownfish"."""
    photos = commons_photos(api, '"' + c['name'] + '"', c['name'], per)
    if len(photos) < per and c['base']:
        photos += commons_photos(api, '"' + c['name'] + '" ' + c['base'].split()[0], c['name'], per - len(photos))
    return dedupe(photos)[:per]


def dedupe(photos):
    seen, out = set(), []
    for p in photos:
        if p['url'] not in seen:
            seen.add(p['url'])
            out.append(p)
    return out


def evaluate(emb, labels, names_list, classes, rng, holdout=0.2):
    """Hold back ~20% of each class (classes with 5+ photos), match each held-back photo to the nearest
    reference photo of every class, and score top-1 / top-3."""
    import numpy as np
    by_class = collections.defaultdict(list)
    for i, l in enumerate(labels):
        by_class[l].append(i)
    test, ref = [], []
    for l, idx in by_class.items():
        idx = idx[:]
        rng.shuffle(idx)
        if len(idx) >= 5:
            k = max(1, int(round(len(idx) * holdout)))
            test += idx[:k]
            ref += idx[k:]
        else:
            ref += idx
    if not test:
        return None
    ref = np.array(ref)
    ref_lab = np.array([labels[i] for i in ref])
    n_cls = len(names_list)
    sims = emb[test] @ emb[ref].T  # cosine similarity (fingerprints are unit length)
    best = np.full((len(test), n_cls), -2.0, dtype=np.float32)
    for c in range(n_cls):
        cols = np.where(ref_lab == c)[0]
        if len(cols):
            best[:, c] = sims[:, cols].max(axis=1)
    order = np.argsort(-best, axis=1)[:, :3]
    truth = np.array([labels[i] for i in test])
    top1 = order[:, 0] == truth
    top3 = (order == truth[:, None]).any(axis=1)
    conf = collections.Counter()
    per_group = collections.defaultdict(lambda: [0, 0, 0])
    per_kind = collections.defaultdict(lambda: [0, 0, 0])
    for t, o, ok1, ok3 in zip(truth, order, top1, top3):
        cl = classes[t]
        for bucket, key in ((per_group, cl['group'] or '(no look-alike group)'), (per_kind, cl['kind'])):
            bucket[key][0] += 1
            bucket[key][1] += int(ok1)
            bucket[key][2] += int(ok3)
        if not ok1:
            conf[(names_list[t], names_list[o[0]])] += 1
    return {'n': len(test), 'top1': float(top1.mean()), 'top3': float(top3.mean()),
            'per_group': dict(per_group), 'per_kind': dict(per_kind), 'confusions': conf.most_common(25)}


def pct(x):
    return f'{100 * x:.0f}%'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--species-file', default='species.json')
    ap.add_argument('--limit', type=int, default=0, help='0 = every species')
    ap.add_argument('--per', type=int, default=30, help='photos per species')
    ap.add_argument('--kinds', default='', help='fish,coral,plant,invert,shrimp,snail (blank = all)')
    ap.add_argument('--water', default='', help='f, s or blank')
    ap.add_argument('--models', default='small,large')
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--out', default='offline-out')
    ap.add_argument('--max-minutes', type=float, default=300, help='stop collecting after this long and report what we have')
    a = ap.parse_args()

    import numpy as np
    from PIL import Image
    t0 = time.time()
    rng = random.Random(a.seed)
    os.makedirs(a.out, exist_ok=True)
    db = json.load(open(a.species_file, encoding='utf-8'))
    kinds = {k.strip() for k in a.kinds.split(',') if k.strip()}
    classes = plan_classes(db, kinds, a.water.strip(), a.limit, rng)
    models = {k: MODELS[k] for k in a.models.split(',') if k in MODELS}
    print(f'{len(classes)} species to collect, up to {a.per} photos each, models: {", ".join(models)}', flush=True)
    emb_model = Embedder(models)
    inat_api = Http(1.05)      # iNaturalist asks for about one request a second
    commons_api = Http(0.25)
    dl = requests.Session()
    dl.headers['User-Agent'] = UA

    feats = {k: [] for k in models}
    labels, credits, coverage = [], [], []
    stopped_early = False
    for ci, c in enumerate(classes):
        if (time.time() - t0) / 60 > a.max_minutes:
            stopped_early = True
            print('Time limit reached; reporting what was collected.', flush=True)
            break
        try:
            if c['base'] and not c['variety']:
                photos = collect_inat_first(inat_api, commons_api, c, a.per)
            else:
                photos = collect_variety(commons_api, c, a.per)
        except Exception as err:  # keep going; one bad species should not stop the run
            print('  error collecting', c['name'], err, flush=True)
            photos = []
        imgs, kept = [], []
        with cf.ThreadPoolExecutor(8) as pool:
            for p, raw in zip(photos, pool.map(lambda p: download(dl, p['url']), photos)):
                if not raw:
                    continue
                try:
                    im = Image.open(io.BytesIO(raw)).convert('RGB')
                    im.thumbnail((448, 448))
                except Exception:
                    continue
                imgs.append(im)
                kept.append(p)
        if imgs:
            for start in range(0, len(imgs), 32):
                out = emb_model(imgs[start:start + 32])
                for k in models:
                    feats[k].append(out[k].astype(np.float32))
            labels += [ci] * len(imgs)
            for p in kept:
                credits.append([c['name'], p['source'], p['license'], p['author'], p['page']])
        srcs = collections.Counter(p['source'].split(' ')[0] for p in kept)
        aquarium = sum(1 for p in kept if 'aquarium' in p['source'])
        coverage.append([c['name'], c['kind'], c['water'], c['group'], 'yes' if c['variety'] else '', len(kept), aquarium,
                         srcs.get('iNaturalist', 0), srcs.get('Wikimedia', 0)])
        if ci % 25 == 0:
            print(f'  {ci + 1}/{len(classes)} {c["name"]}: {len(kept)} photos ({aquarium} aquarium) '
                  f'[{(time.time() - t0) / 60:.0f} min]', flush=True)

    names_list = [c['name'] for c in classes]
    results, sizes = {}, {}
    for k in models:
        if not feats[k]:
            continue
        E = np.concatenate(feats[k])
        lab = np.array(labels)
        np.savez_compressed(os.path.join(a.out, f'fingerprints_{k}.npz'), fingerprints=E.astype(np.float16), labels=lab,
                            names=np.array(names_list), model=np.array(models[k]))
        results[k] = evaluate(E, labels, names_list, classes, random.Random(a.seed))
        params = emb_model.models[k][2]
        dim = E.shape[1]
        n_cls = len(set(labels))
        sizes[k] = {'model_mb': params / 1e6, 'dim': dim,
                    'pack_centroids_mb': n_cls * 3 * dim / 1e6,   # 3 averaged fingerprints per species, 1 byte each
                    'pack_all_mb': len(labels) * dim / 1e6}

    with open(os.path.join(a.out, 'coverage.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['species', 'kind', 'water', 'group', 'variety', 'photos', 'aquarium_photos', 'from_inaturalist', 'from_commons'])
        w.writerows(sorted(coverage, key=lambda r: r[5]))
    with open(os.path.join(a.out, 'credits.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['species', 'source', 'license', 'author', 'page'])
        w.writerows(credits)

    report = write_report(a, classes, coverage, results, sizes, labels, stopped_early, (time.time() - t0) / 60)
    open(os.path.join(a.out, 'report.md'), 'w', encoding='utf-8').write(report)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        open(summary, 'a', encoding='utf-8').write(report)
    print(report)


def collect_inat_first(inat_api, commons_api, c, per):
    photos = []
    tid = inat_taxon(inat_api, c['base'])
    if tid:
        photos += inat_photos(inat_api, tid, per)
    if len(photos) < per:
        photos += commons_photos(commons_api, c['base'], c['base'], per - len(photos))
    return dedupe(photos)[:per]


def write_report(a, classes, coverage, results, sizes, labels, stopped_early, minutes):
    L = []
    L.append('# Schooled offline ID: report card')
    L.append('')
    L.append(f'Run {datetime.datetime.utcnow():%Y-%m-%d %H:%M} UTC, {minutes:.0f} minutes. '
             f'{len(coverage)} of {len(classes)} species collected, {len(labels)} photos fingerprinted '
             f'(up to {a.per} per species).' + (' **Stopped early at the time limit.**' if stopped_early else ''))
    L.append('')
    L.append('## How well it recognizes held-back photos')
    L.append('')
    L.append('Each species with 5 or more photos had about 1 in 5 photos held back. Each held-back photo was matched '
             'against all the rest. "Top 1" = the right species came first; "Top 3" = it was in the first three.')
    L.append('')
    L.append('| Model | Photos tested | Top 1 | Top 3 | Model size | Offline pack (fingerprints) |')
    L.append('|---|---|---|---|---|---|')
    for k, r in results.items():
        if not r:
            L.append(f'| {k} | 0 | – | – | | |')
            continue
        s = sizes[k]
        L.append(f'| {k} ({MODELS[k].split(".")[0]}) | {r["n"]} | {pct(r["top1"])} | {pct(r["top3"])} | '
                 f'~{s["model_mb"]:.0f} MB (shrinks to about a quarter in the app) | {s["pack_centroids_mb"]:.2f} MB small / {s["pack_all_mb"]:.2f} MB full |')
    L.append('')
    best = max((k for k in results if results[k]), key=lambda k: results[k]['top1'], default=None)
    if best:
        r = results[best]
        L.append(f'## By kind ({best} model)')
        L.append('')
        L.append('| Kind | Tested | Top 1 | Top 3 |')
        L.append('|---|---|---|---|')
        for kind, (n, t1, t3) in sorted(r['per_kind'].items(), key=lambda x: -x[1][0]):
            L.append(f'| {kind} | {n} | {pct(t1 / n)} | {pct(t3 / n)} |')
        L.append('')
        L.append(f'## Look-alike groups ({best} model, groups with 10+ test photos)')
        L.append('')
        L.append('| Group | Tested | Top 1 | Top 3 |')
        L.append('|---|---|---|---|')
        for g, (n, t1, t3) in sorted(r['per_group'].items(), key=lambda x: x[1][1] / max(1, x[1][0])):
            if n >= 10:
                L.append(f'| {g} | {n} | {pct(t1 / n)} | {pct(t3 / n)} |')
        L.append('')
        L.append('## Most common mix-ups')
        L.append('')
        for (t, p), n in r['confusions']:
            L.append(f'- {t} taken for {p} ({n}x)')
        L.append('')
    few = [r for r in coverage if r[5] < 5]
    none = [r for r in coverage if r[5] == 0]
    var = [r for r in coverage if r[4]]
    aq = sum(r[6] for r in coverage)
    L.append('## Photo coverage')
    L.append('')
    L.append(f'- Species with 0 photos: **{len(none)}**; with fewer than 5: **{len(few)}** (these are the gaps to fill).')
    L.append(f'- Photos taken in aquariums (iNaturalist "captive"): {aq} of {len(labels)}.')
    L.append(f'- Color varieties: {len(var)}, of which {sum(1 for r in var if r[5] >= 5)} got 5 or more photos.')
    L.append('')
    L.append('Full list, fewest photos first: coverage.csv. Every photo\'s source, license and author: credits.csv.')
    L.append('')
    L.append('### Species and varieties with fewer than 5 photos (first 80)')
    L.append('')
    for r in few[:80]:
        L.append(f'- {r[0]} ({r[1]}, {"salt" if "s" in r[2] else "fresh"}{", variety" if r[4] else ""}): {r[5]}')
    L.append('')
    return '\n'.join(L) + '\n'


if __name__ == '__main__':
    main()
