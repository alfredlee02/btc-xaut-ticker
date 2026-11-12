const SYMBOLS = ['BTCUSDT', 'XAUTUSDT'];
const NAMES = { BTCUSDT: '比特幣', XAUTUSDT: '黃金' };
const API = 'https://api.binance.com/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(SYMBOLS));
const POLL_MS = 5000;
const KLINE_MS = 15000;
const KLINE_LIMIT = 180;
const SPIKE_P = 0.97;
const COOLDOWN_MS = 180000;
const STORAGE_KEY = 'btc-xaut-quote-v1';
const ALERT_KEY = 'btc-xaut-alerts-v1';
const WAKE_KEY = 'btc-xaut-wakelock-v1';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_TTL = 60000;
const TZ = 'Asia/Hong_Kong';

const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');
const installBanner = document.getElementById('installBanner');
const refreshHint = document.getElementById('refreshHint');
const alertToggle = document.getElementById('alertToggle');
const alertHint = document.getElementById('alertHint');
const alertVolumeWrap = document.getElementById('alertVolumeWrap');
const alertVolume = document.getElementById('alertVolume');
const alertBar = document.getElementById('alertBar');
const alertToast = document.getElementById('alertToast');
const wakeToggle = document.getElementById('wakeToggle');
const wakeHint = document.getElementById('wakeHint');

const WAKE_HINT = '開咗就盡量唔讓電話自動熄屏，方便放係度睇。';
const WAKE_UNAVAILABLE = '呢部裝置暫時唔支援螢幕常亮。';
const WAKE_FAILED = '而家未能保持常亮，可能係系統限制。請保持 app 開住再試。';
const wakeSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

const DEFAULT_HINT = '1 或 5 分鐘成交額遠高過近 3 小時水平就會出聲。要 app 開住先會响；電話靜音可能唔會响。';
const UNLOCK_HINT = '撳呢度開啟提示聲。之後要 app 開住先會响。';

const lastPrices = {};
const lastAlertAt = {};
const lastAlertCandle = {};
let timer = null;
let klineTimer = null;
let inFlight = false;
let klineInFlight = false;
let audioCtx = null;
let audioUnlocked = false;
let toastTimer = null;
let previewTimer = null;
let wakeLock = null;
const weekCache = {};

function loadWakeEnabled() {
  try {
    return JSON.parse(localStorage.getItem(WAKE_KEY) || 'null')?.enabled === true;
  } catch {
    return false;
  }
}

let wakeEnabled = loadWakeEnabled();

function saveWakeEnabled() {
  localStorage.setItem(WAKE_KEY, JSON.stringify({ enabled: wakeEnabled }));
}

function loadAlertSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALERT_KEY) || 'null');
    return {
      enabled: raw?.enabled !== false,
      volume: Math.min(1, Math.max(0, Number(raw?.volume ?? 0.7))),
    };
  } catch {
    return { enabled: true, volume: 0.7 };
  }
}

function saveAlertSettings() {
  localStorage.setItem(ALERT_KEY, JSON.stringify(alertSettings));
}

const alertSettings = loadAlertSettings();

function money(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function moneyInt(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function signed(n) {
  const v = Number(n);
  const s = money(Math.abs(v));
  return (v > 0 ? '+' : v < 0 ? '−' : '') + s;
}

function formatQuote(n) {
  if (n >= 1e8) {
    const v = n / 1e8;
    return v.toLocaleString('en-US', { maximumFractionDigits: v >= 10 ? 1 : 2 }) + ' 億 USDT';
  }
  if (n >= 1e4) {
    const v = n / 1e4;
    return v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 0 : 1 }) + ' 萬 USDT';
  }
  return money(n) + ' USDT';
}

function formatTime(ts) {
  return new Intl.DateTimeFormat('zh-Hant-HK', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

function setStatus(kind, text) {
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
  statusEl.textContent = text;
}

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveCache(payload) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function applyTickers(tickers, { fromCache = false, updatedAt } = {}) {
  for (const t of tickers) {
    const card = document.getElementById('card-' + t.symbol);
    if (!card) continue;

    const price = Number(t.lastPrice);
    const change = Number(t.priceChange);
    const pct = Number(t.priceChangePercent);
    const low = Number(t.lowPrice);
    const high = Number(t.highPrice);
    const prev = lastPrices[t.symbol];

    const priceEl = card.querySelector('[data-price]');
    priceEl.textContent = moneyInt(price);

    if (!fromCache && prev != null && prev !== price) {
      priceEl.classList.remove('flash-up', 'flash-down');
      void priceEl.offsetWidth;
      priceEl.classList.add(price > prev ? 'flash-up' : 'flash-down');
      setTimeout(() => priceEl.classList.remove('flash-up', 'flash-down'), 700);
    }
    lastPrices[t.symbol] = price;

    const changeBox = card.querySelector('[data-change]');
    const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
    changeBox.className = 'change' + (dir ? ' ' + dir : '');
    card.querySelector('[data-change-amt]').textContent = signed(change);
    card.querySelector('[data-change-pct]').textContent = signed(pct) + '%';

    const range = card.querySelector('.range');
    range.hidden = !(high > low);
    if (high > low) {
      card.querySelector('[data-low]').textContent = money(low);
      card.querySelector('[data-high]').textContent = money(high);
      const pos = Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
      card.querySelector('[data-range-pos]').style.left = pos + '%';
    }
  }

  if (fromCache) {
    setStatus('offline', '離線 · 顯示 ' + formatTime(updatedAt) + ' 嘅價格');
  } else {
    setStatus('live', '即時 · 更新於 ' + formatTime(updatedAt) + '（香港時間）');
  }
}

async function refresh({ manual = false } = {}) {
  if (inFlight) return;
  inFlight = true;
  if (manual) refreshBtn.classList.add('spin');

  try {
    const res = await fetch(API, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const tickers = await res.json();
    const updatedAt = Date.now();
    saveCache({ tickers, updatedAt });
    applyTickers(tickers, { updatedAt });
    refreshMarketExtras();
  } catch (err) {
    const cache = loadCache();
    if (cache?.tickers) {
      applyTickers(cache.tickers, { fromCache: true, updatedAt: cache.updatedAt });
    } else {
      setStatus('offline', '暫時攞唔到報價，稍後再試');
    }
    console.warn(err);
  } finally {
    inFlight = false;
    setTimeout(() => refreshBtn.classList.remove('spin'), 400);
  }
}

function startPolling() {
  stopPolling();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
  klineTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshMarketExtras();
  }, KLINE_MS);
  refreshMarketExtras();
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (klineTimer) {
    clearInterval(klineTimer);
    klineTimer = null;
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

async function fetchKlines(symbol) {
  const url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol + '&interval=1m&limit=' + KLINE_LIMIT;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const rows = await res.json();
  return rows.map((row) => ({
    openTime: row[0],
    close: Number(row[4]),
    quoteVolume: Number(row[7]),
  }));
}

function detectSpike(candles) {
  if (!candles || candles.length < 40) return null;
  const completed = candles.slice(0, -1);
  const current = candles[candles.length - 1];
  const vols1 = completed.map((c) => c.quoteVolume);
  const threshold1 = percentile(vols1, SPIKE_P);
  const windows5 = [];
  for (let i = 4; i < completed.length; i++) {
    let sum = 0;
    for (let j = i - 4; j <= i; j++) sum += completed[j].quoteVolume;
    windows5.push(sum);
  }
  const threshold5 = percentile(windows5, SPIKE_P);
  const last4 = completed.slice(-4).reduce((s, c) => s + c.quoteVolume, 0);
  const vol5 = last4 + current.quoteVolume;
  const justClosed = completed[completed.length - 1];

  const hit1Current = current.quoteVolume >= threshold1 && threshold1 > 0;
  const hit1Closed = justClosed.quoteVolume >= threshold1 && threshold1 > 0;
  const hit5 = vol5 >= threshold5 && threshold5 > 0;

  if (hit1Current) {
    return { window: 1, volume: current.quoteVolume, candleOpen: current.openTime };
  }
  if (hit1Closed) {
    return { window: 1, volume: justClosed.quoteVolume, candleOpen: justClosed.openTime };
  }
  if (hit5) {
    return { window: 5, volume: vol5, candleOpen: current.openTime };
  }
  return null;
}

function changePct(now, then) {
  if (!(then > 0) || now == null || Number.isNaN(now)) return null;
  return ((now - then) / then) * 100;
}

function applyPeriod(symbol, key, pct) {
  const el = document.getElementById('card-' + symbol)?.querySelector('[data-chg-' + key + ']');
  if (!el) return;
  const b = el.querySelector('b');
  if (pct == null || Number.isNaN(pct)) {
    b.textContent = '—';
    el.classList.remove('up', 'down');
    return;
  }
  b.textContent = signed(pct) + '%';
  el.classList.toggle('up', pct > 0);
  el.classList.toggle('down', pct < 0);
}

function closeAtOrBefore(candles, target) {
  let hit = null;
  for (const c of candles) {
    if (c.openTime <= target) hit = c;
    else break;
  }
  return hit;
}

function applyHourChange(symbol, candles) {
  if (!candles || candles.length < 61) return;
  const last = candles[candles.length - 1];
  const ago = closeAtOrBefore(candles, last.openTime - 60 * 60 * 1000) || candles[candles.length - 61];
  applyPeriod(symbol, '1h', changePct(last.close, ago.close));
}

async function fetchWeekChange(symbol) {
  const cached = weekCache[symbol];
  if (cached && Date.now() - cached.at < WEEK_TTL) return cached.pct;
  const url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol + '&interval=1h&limit=169';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const rows = await res.json();
  const last = Number(rows[rows.length - 1][4]);
  const target = Date.now() - WEEK_MS;
  let ago = rows[0];
  for (const row of rows) {
    if (row[0] <= target) ago = row;
    else break;
  }
  const pct = changePct(last, Number(ago[4]));
  weekCache[symbol] = { pct, at: Date.now() };
  return pct;
}

async function refreshWeekChanges() {
  const results = await Promise.allSettled(SYMBOLS.map(fetchWeekChange));
  SYMBOLS.forEach((symbol, i) => {
    if (results[i].status === 'fulfilled') applyPeriod(symbol, '7d', results[i].value);
  });
}

async function refreshMarketExtras() {
  if (document.visibilityState === 'hidden') return;
  if (klineInFlight) return;
  klineInFlight = true;
  try {
    const results = await Promise.allSettled(SYMBOLS.map(fetchKlines));
    for (let i = 0; i < SYMBOLS.length; i++) {
      if (results[i].status !== 'fulfilled') {
        console.warn(results[i].reason);
        continue;
      }
      applyHourChange(SYMBOLS[i], results[i].value);
      if (alertSettings.enabled) maybeAlert(SYMBOLS[i], detectSpike(results[i].value));
    }
    await refreshWeekChanges();
  } catch (err) {
    console.warn(err);
  } finally {
    klineInFlight = false;
  }
}

function maybeAlert(symbol, spike) {
  if (!spike) return;
  const now = Date.now();
  if (lastAlertCandle[symbol] === spike.candleOpen) return;
  if (lastAlertAt[symbol] && now - lastAlertAt[symbol] < COOLDOWN_MS) return;

  lastAlertAt[symbol] = now;
  lastAlertCandle[symbol] = spike.candleOpen;

  const text = NAMES[symbol] + ' ' + spike.window + ' 分鐘成交急升 · 約 ' + formatQuote(spike.volume);
  const card = document.getElementById('card-' + symbol);
  const spikeEl = card?.querySelector('[data-spike]');
  if (spikeEl) {
    spikeEl.hidden = false;
    spikeEl.textContent = text.replace(NAMES[symbol] + ' ', '');
  }
  card?.classList.add('spiking');
  setTimeout(() => card?.classList.remove('spiking'), 4000);

  alertToast.hidden = false;
  alertToast.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { alertToast.hidden = true; }, 8000);

  playAlert(symbol);
  try { navigator.vibrate?.(180); } catch { /* ignore */ }
}

function ensureAudio() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

async function unlockAudio({ preview = false } = {}) {
  const ctx = ensureAudio();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    audioUnlocked = ctx.state === 'running';
  } catch {
    audioUnlocked = false;
  }
  syncAlertUi();
  if (audioUnlocked && preview) playAlert('BTCUSDT');
  return audioUnlocked;
}

function playAlert(symbol) {
  if (!alertSettings.enabled || !audioUnlocked) return;
  const ctx = ensureAudio();
  if (!ctx || ctx.state !== 'running') return;
  const vol = Math.max(0.0001, alertSettings.volume * 0.22);
  const notes = symbol === 'XAUTUSDT' ? [698.5, 932] : [880, 1174.7];
  const now = ctx.currentTime;
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t0 = now + i * 0.16;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.3);
  });
}

function syncAlertUi() {
  alertToggle.setAttribute('aria-checked', alertSettings.enabled ? 'true' : 'false');
  alertVolumeWrap.hidden = !alertSettings.enabled;
  alertVolume.value = String(Math.round(alertSettings.volume * 100));
  if (alertSettings.enabled && !audioUnlocked) {
    alertHint.textContent = UNLOCK_HINT;
    alertHint.classList.add('need-unlock');
  } else {
    alertHint.textContent = DEFAULT_HINT;
    alertHint.classList.remove('need-unlock');
  }
}

refreshBtn.addEventListener('click', () => refresh({ manual: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refresh();
    startPolling();
    if (alertSettings.enabled && audioUnlocked) unlockAudio();
    applyWakeLock();
  } else {
    stopPolling();
  }
});

alertToggle.addEventListener('click', async () => {
  alertSettings.enabled = !alertSettings.enabled;
  saveAlertSettings();
  if (alertSettings.enabled) {
    await unlockAudio({ preview: true });
    refreshMarketExtras();
  }
  syncAlertUi();
});

alertBar.addEventListener('click', (e) => {
  if (e.target === alertToggle || e.target === alertVolume) return;
  if (alertSettings.enabled && !audioUnlocked) unlockAudio({ preview: true });
});

alertVolume.addEventListener('input', () => {
  alertSettings.volume = Number(alertVolume.value) / 100;
  saveAlertSettings();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => unlockAudio({ preview: true }), 180);
});


async function applyWakeLock() {
  if (!wakeSupported) {
    if (wakeLock) {
      try { await wakeLock.release(); } catch { /* ignore */ }
      wakeLock = null;
    }
    return false;
  }
  if (!wakeEnabled || document.visibilityState !== 'visible') {
    if (wakeLock) {
      try { await wakeLock.release(); } catch { /* ignore */ }
      wakeLock = null;
    }
    return false;
  }
  try {
    if (wakeLock && wakeLock.released === false) return true;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { syncWakeUi(); });
    syncWakeUi();
    return true;
  } catch (err) {
    console.warn(err);
    wakeLock = null;
    return false;
  }
}

function syncWakeUi(failed) {
  const checked = !!(wakeSupported && wakeEnabled);
  wakeToggle.disabled = false;
  wakeToggle.setAttribute('aria-checked', checked ? 'true' : 'false');
  const showWarn = !wakeSupported || !!(failed && wakeEnabled);
  wakeHint.classList.toggle('need-unlock', showWarn);
  if (!wakeSupported) {
    wakeHint.textContent = WAKE_UNAVAILABLE;
  } else if (failed && wakeEnabled) {
    wakeHint.textContent = WAKE_FAILED;
  } else {
    wakeHint.textContent = WAKE_HINT;
  }
}

wakeToggle.addEventListener('click', async () => {
  if (!wakeSupported) {
    wakeEnabled = false;
    saveWakeEnabled();
    syncWakeUi();
    return;
  }
  wakeEnabled = !wakeEnabled;
  saveWakeEnabled();
  const ok = await applyWakeLock();
  syncWakeUi(wakeEnabled && !ok);
});

// Pull to refresh
let startY = 0;
let pulling = false;
const THRESHOLD = 64;

document.addEventListener('touchstart', (e) => {
  if (window.scrollY <= 0) {
    startY = e.touches[0].clientY;
    pulling = true;
  }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!pulling) return;
  const dy = e.touches[0].clientY - startY;
  if (dy > 24) {
    refreshHint.hidden = false;
    refreshHint.textContent = dy > THRESHOLD ? '釋放以更新' : '下拉更新';
  }
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (!pulling) return;
  const dy = (e.changedTouches[0]?.clientY || 0) - startY;
  pulling = false;
  refreshHint.hidden = true;
  if (dy > THRESHOLD) refresh({ manual: true });
}, { passive: true });

// iOS add-to-home hint
const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
if (isIOS && !standalone && !localStorage.getItem('hide-install-hint')) {
  installBanner.hidden = false;
}
document.getElementById('dismissInstall').addEventListener('click', () => {
  installBanner.hidden = true;
  localStorage.setItem('hide-install-hint', '1');
});

if ('serviceWorker' in navigator) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js?v=12').catch(() => {});
}

syncAlertUi();
syncWakeUi();
applyWakeLock();
const cache = loadCache();
if (cache?.tickers) applyTickers(cache.tickers, { fromCache: !navigator.onLine, updatedAt: cache.updatedAt });
refresh();
startPolling();
