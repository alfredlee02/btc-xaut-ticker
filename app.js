const SYMBOLS = ['BTCUSDT', 'XAUTUSDT'];
const API = 'https://api.binance.com/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(SYMBOLS));
const POLL_MS = 5000;
const STORAGE_KEY = 'btc-xaut-quote-v1';
const TZ = 'Asia/Hong_Kong';

const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');
const installBanner = document.getElementById('installBanner');
const refreshHint = document.getElementById('refreshHint');

const lastPrices = {};
let timer = null;
let inFlight = false;

function money(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signed(n) {
  const v = Number(n);
  const s = money(Math.abs(v));
  return (v > 0 ? '+' : v < 0 ? '−' : '') + s;
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
    priceEl.textContent = money(price);

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
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

refreshBtn.addEventListener('click', () => refresh({ manual: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refresh();
    startPolling();
  } else {
    stopPolling();
  }
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
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

const cache = loadCache();
if (cache?.tickers) applyTickers(cache.tickers, { fromCache: !navigator.onLine, updatedAt: cache.updatedAt });
refresh();
startPolling();
