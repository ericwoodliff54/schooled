// Schooled store-app subscriptions (RevenueCat). Bundled by build-www.js into the store apps only; the web version never loads this.
// Nobody signs in: RevenueCat gives each install an anonymous id tied to the store purchase, and the worker checks that id.
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Purchases } from '@revenuecat/purchases-capacitor';

const KEYS = { ios: __RC_IOS_KEY__, android: __RC_ANDROID_KEY__ };
const PRIVACY_URL = __PRIVACY_URL__;
const TERMS_URL = __TERMS_URL__;
const ENTITLEMENT = 'schooled_pro';
const LIMITS_TEXT = '110 fish scans, 30 water-strip reads, 2 Dream Tank pictures and 100 questions a month';

const platform = Capacitor.getPlatform();
const apiKey = KEYS[platform] || '';
const configured = Capacitor.isNativePlatform() && /^(appl|goog)_/.test(apiKey);
let appUserId = '';
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
let paywallEl = null;
let busy = false;

function isActive(info) { return !!(info && info.entitlements && info.entitlements.active && info.entitlements.active[ENTITLEMENT]); }
function workerUrl() { try { return typeof WORKER_URL === 'string' ? WORKER_URL : ''; } catch (e) { return ''; } }

// Every request to the worker carries the anonymous subscription id.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  try {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const base = workerUrl();
    if (base && url.indexOf(base) === 0) {
      if (configured) await Promise.race([ready, new Promise((r) => setTimeout(r, 4000))]);
      if (appUserId) {
        const h = new Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || undefined);
        h.set('X-RC-User', appUserId);
        init = Object.assign({}, init, { headers: h });
      }
      const res = await nativeFetch(input, init);
      if (res.status === 402) showPaywall();
      return res;
    }
  } catch (err) { /* fall through and send it plainly */ }
  return nativeFetch(input, init);
};

const css = `
#sch-paywall{position:fixed;inset:0;z-index:99999;background:linear-gradient(180deg,#0A1523,#123B73);color:#fff;font-family:'Plus Jakarta Sans',system-ui,sans-serif;overflow:auto;padding:max(24px,var(--safe-area-inset-top, env(safe-area-inset-top, 0px))) 20px max(24px,var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));display:flex;flex-direction:column;align-items:center}
#sch-paywall .in{width:100%;max-width:420px;margin:auto 0}
#sch-paywall h1{font-size:26px;line-height:1.2;margin:0 0 8px;text-align:center}
#sch-paywall p.sub{margin:0 0 20px;text-align:center;opacity:.85;font-size:15px}
#sch-paywall ul{list-style:none;padding:0;margin:0 0 20px}
#sch-paywall li{padding:6px 0 6px 28px;position:relative;font-size:15px}
#sch-paywall li:before{content:'\\2713';position:absolute;left:4px;color:#7FD1FF;font-weight:700}
#sch-paywall .plan{display:block;width:100%;text-align:left;background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.25);color:#fff;border-radius:14px;padding:14px 16px;margin:0 0 10px;font:inherit;cursor:pointer}
#sch-paywall .plan.best{border-color:#7FD1FF;background:rgba(127,209,255,.16)}
#sch-paywall .plan b{display:block;font-size:17px}
#sch-paywall .plan span{font-size:13px;opacity:.85}
#sch-paywall .go{display:block;width:100%;border:0;border-radius:14px;padding:15px;margin:14px 0 8px;font:inherit;font-weight:700;font-size:17px;background:#fff;color:#1A63C7;cursor:pointer}
#sch-paywall .go[disabled]{opacity:.6}
#sch-paywall .link{background:none;border:0;color:#fff;opacity:.85;text-decoration:underline;font:inherit;font-size:14px;padding:8px;cursor:pointer}
#sch-paywall .fine{font-size:12px;opacity:.7;text-align:center;line-height:1.4;margin-top:6px}
#sch-paywall .fine a{color:#fff}
#sch-paywall .err{color:#FFC9C9;text-align:center;font-size:14px;min-height:18px;margin:6px 0}
`;

function pkgInfo(p) {
  const prod = p.product || {};
  const intro = prod.introPrice;
  const free = !!((intro && Number(intro.price) === 0) || (prod.defaultOption && prod.defaultOption.freePhase));
  return { price: prod.priceString || '', free };
}

async function showPaywall() {
  if (paywallEl || !configured) return;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  paywallEl = document.createElement('div'); paywallEl.id = 'sch-paywall';
  paywallEl.innerHTML = '<div class="in"><h1>Keep your tank healthy</h1><p class="sub">Schooled’s AI fish ID, water-strip reads, Dream Tank and tank Q&amp;A.</p>' +
    '<ul><li>Fish Check: snap a photo, get the species and care</li><li>Water-test strip reads</li><li>Dream Tank pictures of your future tank</li><li>Ask Schooled anything about your tank</li></ul>' +
    '<div id="sch-plans"><p class="sub">Loading prices…</p></div><div class="err" id="sch-err"></div>' +
    '<button class="go" id="sch-go" disabled>Continue</button><div style="text-align:center"><button class="link" id="sch-restore">Restore purchases</button></div>' +
    '<div class="fine" id="sch-fine"></div></div>';
  document.body.appendChild(paywallEl);
  const err = (m) => { const e = document.getElementById('sch-err'); if (e) e.textContent = m || ''; };
  let chosen = null;
  function setGo(p) { const go = document.getElementById('sch-go'); if (!go) return; go.disabled = false; go.textContent = pkgInfo(p).free ? 'Start 3-day free trial' : 'Subscribe'; }
  async function loadPlans() {
    const box = document.getElementById('sch-plans');
    if (!box) return;
    box.innerHTML = '<p class="sub">Loading prices…</p>';
    try {
      const offerings = await Purchases.getOfferings();
      const cur = offerings.current;
      const pk = ((cur && cur.availablePackages) || []).slice();
      if (!pk.length) throw new Error('no packages');
      pk.sort((a, b) => (a.packageType === 'ANNUAL' ? -1 : 0) - (b.packageType === 'ANNUAL' ? -1 : 0));
      box.innerHTML = '';
      pk.forEach((p, i) => {
        const info = pkgInfo(p);
        const annual = p.packageType === 'ANNUAL';
        const b = document.createElement('button'); b.className = 'plan' + (i === 0 ? ' best' : '');
        b.innerHTML = '<b>' + (annual ? 'Yearly' : p.packageType === 'MONTHLY' ? 'Monthly' : (p.product.title || 'Plan')) + ' · ' + info.price + (annual ? ' / year' : p.packageType === 'MONTHLY' ? ' / month' : '') + '</b><span>' + (info.free ? '3 days free, then ' + info.price : 'Cancel anytime') + (annual ? ' · best value' : '') + '</span>';
        b.onclick = () => { chosen = p; box.querySelectorAll('.plan').forEach((x) => x.classList.remove('best')); b.classList.add('best'); setGo(p); };
        box.appendChild(b);
        if (i === 0) { chosen = p; setGo(p); }
      });
      const fine = document.getElementById('sch-fine');
      const first = pkgInfo(pk[0]);
      fine.innerHTML = (first.free ? 'Free for 3 days, then ' : '') + 'renews automatically at the price shown until you cancel. Cancel any time in your ' + (platform === 'ios' ? 'Apple ID' : 'Google Play') + ' subscription settings, at least 24 hours before the period ends. Payment is charged to your ' + (platform === 'ios' ? 'Apple ID' : 'Google Play') + ' account.<br>Fair-use monthly limits apply to the AI features (about ' + LIMITS_TEXT + ').<br><a href="' + TERMS_URL + '" target="_blank" rel="noopener">Terms</a> · <a href="' + PRIVACY_URL + '" target="_blank" rel="noopener">Privacy</a>';
    } catch (e) {
      box.innerHTML = '<p class="sub">Prices could not be loaded. Check your connection and try again.</p><button class="link" id="sch-retry">Try again</button>';
      const r = document.getElementById('sch-retry'); if (r) r.onclick = loadPlans;
    }
  }
  await loadPlans();
  document.getElementById('sch-go').onclick = async () => {
    if (!chosen || busy) return; busy = true; err('');
    const go = document.getElementById('sch-go'); go.disabled = true;
    try {
      const r = await Purchases.purchasePackage({ aPackage: chosen });
      if (isActive(r.customerInfo)) closePaywall(); else err('The purchase did not finish. Try again.');
    } catch (e) {
      if (!(e && (e.userCancelled || e.code === '1' || e.code === 1))) err('The purchase did not go through. Nothing was charged.');
    }
    busy = false; go.disabled = false;
  };
  document.getElementById('sch-restore').onclick = async () => {
    if (busy) return; busy = true; err('');
    try {
      const r = await Purchases.restorePurchases();
      if (isActive(r.customerInfo)) closePaywall(); else err('No active subscription was found for this store account.');
    } catch (e) { err('Restore did not work. Try again.'); }
    busy = false;
  };
}
function closePaywall() { if (paywallEl) { paywallEl.remove(); paywallEl = null; } }

async function start() {
  if (!configured) { readyResolve(); return; }
  try {
    await Purchases.configure({ apiKey });
    appUserId = (await Purchases.getAppUserID()).appUserID || '';
    readyResolve();
    await Purchases.addCustomerInfoUpdateListener((info) => { if (isActive(info)) closePaywall(); });
    let { customerInfo } = await Purchases.getCustomerInfo();
    if (!isActive(customerInfo)) {
      // The first answer can be an out-of-date cached one, so ask RevenueCat again before showing the paywall.
      try { await Purchases.invalidateCustomerInfoCache(); } catch (e) {}
      try { customerInfo = (await Purchases.getCustomerInfo()).customerInfo; } catch (e) {}
    }
    if (!isActive(customerInfo)) showPaywall();
    // Re-check when the app comes back to the foreground, and close the paywall if they are subscribed.
    App.addListener('appStateChange', async ({ isActive: foreground }) => {
      if (!foreground) return;
      try {
        const { customerInfo: ci } = await Purchases.getCustomerInfo();
        if (isActive(ci)) closePaywall();
      } catch (e) { /* keep whatever is showing */ }
    });
  } catch (e) { readyResolve(); /* no paywall on an error; the worker's 402 shows it if they really are not subscribed */ }
}
// Opens the store's own subscription page. The RevenueCat Capacitor plugin has no built-in call for this, so use its management link, or the store's standard address.
async function manageSubscription() {
  let url = '';
  try { const r = await Purchases.getCustomerInfo(); url = (r && r.customerInfo && r.customerInfo.managementURL) || ''; } catch (e) { url = ''; }
  if (!url) url = platform === 'ios' ? 'https://apps.apple.com/account/subscriptions' : 'https://play.google.com/store/account/subscriptions?package=com.schooled.aquarium';
  window.open(url, '_blank');
}
window.Schooled = { native: configured, showPaywall, manageSubscription };
start();
