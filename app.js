const DEFAULT_PAIRS = ['BTCUSDT', 'XAUTUSDT'];
const PAIRS_KEY = 'btc-xaut-pairs-v1';
const TOP_N = 20;
const UNIVERSE_MS = 12 * 60 * 1000;
const TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';
const POLL_MS = 3000;
const KLINE_MS = 15000;
const KLINE_LIMIT = 250;
const SPIKE_P = 0.97;
const COOLDOWN_MS = 180000;
const STORAGE_KEY = 'btc-xaut-quote-v1';
const ALERT_KEY = 'btc-xaut-alerts-v1';
const WAKE_KEY = 'btc-xaut-wakelock-v1';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_TTL = 60000;
const SPARK_TTL = 60000;
const TZ = 'Asia/Hong_Kong';
const PAIR_RE = /^[A-Z0-9]{2,20}USDT$/;
const LEVERAGED_RE = /(?:[A-Z0-9]{2,}(?:UP|DOWN|BULL|BEAR)|[0-9]+[LS])$/;

const NAMES = {
  BTCUSDT: '比特幣',
  XAUTUSDT: '黃金',
  ETHUSDT: '以太幣',
  SOLUSDT: 'Solana',
  BNBUSDT: '幣安幣',
  XRPUSDT: '瑞波幣',
  DOGEUSDT: '狗狗幣',
  ADAUSDT: '艾達幣',
  AVAXUSDT: 'Avalanche',
  DOTUSDT: '波卡',
  TRXUSDT: '波場',
  LINKUSDT: 'Chainlink',
  MATICUSDT: 'Polygon',
  POLUSDT: 'Polygon',
  LTCUSDT: '萊特幣',
  BCHUSDT: '比特幣現金',
  ATOMUSDT: 'Cosmos',
  NEARUSDT: 'NEAR',
  APTUSDT: 'Aptos',
  ARBUSDT: 'Arbitrum',
  OPUSDT: 'Optimism',
  SUIUSDT: 'Sui',
  TONUSDT: 'Toncoin',
  SHIBUSDT: '柴犬幣',
  PEPEUSDT: 'Pepe',
  UNIUSDT: 'Uniswap',
  AAVEUSDT: 'Aave',
  FILUSDT: 'Filecoin',
  INJUSDT: 'Injective',
  SEIUSDT: 'Sei',
  TIAUSDT: 'Celestia',
  WIFUSDT: 'dogwifhat',
  TAOUSDT: 'Bittensor',
  RENDERUSDT: 'Render',
  HBARUSDT: 'Hedera',
  ETCUSDT: '以太經典',
  USDCUSDT: 'USD Coin',
  FDUSDUSDT: 'First Digital USD',
  ZECUSDT: 'Zcash',
  HYPEUSDT: 'Hyperliquid',
};

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
const pickerEl = document.getElementById('picker');
const pickerList = document.getElementById('pickerList');
const pickerSub = document.getElementById('pickerSub');
const pickerSheet = pickerEl.querySelector('.picker-sheet');

const WAKE_HINT = '開咗就盡量唔讓電話自動熄屏，方便放係度睇。';
const WAKE_UNAVAILABLE = '呢部裝置暫時唔支援螢幕常亮。';
const WAKE_FAILED = '而家未能保持常亮，可能係系統限制。請保持 app 開住再試。';
const wakeSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

const DEFAULT_HINT = '1 或 5 分鐘成交額遠高過近 3 小時水平就會出聲。要 app 開住先會响；電話靜音可能唔會响。';
const UNLOCK_HINT = '撳呢度開啟提示聲。之後要 app 開住先會响。';
const PICKER_SUB = 'Binance USDT 成交額頭 20，名單會跟成交量更新。';

const lastPrices = {};
const lastAlertAt = {};
const lastAlertCandle = {};
let timer = null;
let klineTimer = null;
let universeTimer = null;
let inFlight = false;
let klineInFlight = false;
let extrasGen = 0;
let tickerGen = 0;
let audioCtx = null;
let audioUnlocked = false;
let alertBuffer = null;
let alertBufferLoading = null;
let alertEl = null;
let htmlAudioUnlocked = false;
let keepAliveSrc = null;
let audioKeepAliveTimer = null;
let htmlSilenceTimer = null;
let toastTimer = null;
let previewTimer = null;
let wakeLock = null;
let pickerSlot = 0;
let pickerReturnFocus = null;
let universeInFlight = false;
const weekCache = {};
const sparkCache = {};
const universeCache = { at: 0, list: [], bySymbol: {}, error: false };

function loadPairs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PAIRS_KEY) || 'null');
    if (
      Array.isArray(raw) &&
      raw.length === 2 &&
      raw.every((s) => typeof s === 'string' && PAIR_RE.test(s)) &&
      raw[0] !== raw[1]
    ) {
      return raw;
    }
  } catch { /* ignore */ }
  return [...DEFAULT_PAIRS];
}

function savePairs() {
  localStorage.setItem(PAIRS_KEY, JSON.stringify(SYMBOLS));
}

let SYMBOLS = loadPairs();

function tickerUrl(symbols) {
  return TICKER_URL + '?symbols=' + encodeURIComponent(JSON.stringify(symbols));
}

function baseAsset(symbol) {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
}

function displayName(symbol) {
  return NAMES[symbol] || baseAsset(symbol);
}

function tickerLabel(symbol) {
  return baseAsset(symbol) + ' / USDT';
}

function isLeveragedToken(symbol) {
  return LEVERAGED_RE.test(baseAsset(symbol));
}

function cardAt(slot) {
  return document.getElementById('card-' + slot);
}

function cardFor(symbol) {
  return document.querySelector('.card[data-symbol="' + symbol + '"]');
}

function logoNode(symbol, size) {
  if (symbol === 'BTCUSDT' || symbol === 'XAUTUSDT') {
    const img = document.createElement('img');
    img.className = 'logo';
    img.src = symbol === 'BTCUSDT' ? 'icons/btc.svg' : 'icons/xaut.svg';
    img.width = size;
    img.height = size;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    return img;
  }
  const span = document.createElement('span');
  span.className = 'logo avatar';
  span.setAttribute('aria-hidden', 'true');
  const base = baseAsset(symbol);
  span.textContent = base.length <= 4 ? base : base.slice(0, 4);
  let hash = 0;
  for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  span.style.background = 'hsl(' + (hash % 360) + ' 26% 30%)';
  return span;
}

function paintCardIdentity(card, symbol) {
  card.dataset.symbol = symbol;
  card.querySelector('[data-name]').textContent = displayName(symbol);
  card.querySelector('[data-ticker]').textContent = tickerLabel(symbol);
  const slot = card.querySelector('[data-logo]');
  slot.replaceChildren(logoNode(symbol, 36));
  const head = card.querySelector('.card-head');
  head.setAttribute('aria-label', '揀幣種，而家係' + displayName(symbol));
}

function resetCardVisuals(card) {
  const priceEl = card.querySelector('[data-price]');
  priceEl.textContent = '—';
  priceEl.classList.remove('flash-up', 'flash-down', 'price-long');
  const changeBox = card.querySelector('[data-change]');
  changeBox.className = 'change';
  card.querySelector('[data-change-amt]').textContent = '—';
  card.querySelector('[data-change-pct]').textContent = '—';
  for (const key of ['1h', '4h', '7d']) {
    const el = card.querySelector('[data-chg-' + key + ']');
    if (!el) continue;
    el.querySelector('b').textContent = '—';
    el.classList.remove('up', 'down');
  }
  card.querySelector('.range').hidden = true;
  const spikeEl = card.querySelector('[data-spike]');
  if (spikeEl) {
    spikeEl.hidden = true;
    spikeEl.textContent = '';
  }
  card.classList.remove('spiking');
  const svg = card.querySelector('[data-spark]');
  if (svg) {
    svg.replaceChildren();
    svg.setAttribute('class', 'spark');
  }
}

function applyPairs(next) {
  const prev = [...SYMBOLS];
  SYMBOLS = next;
  savePairs();
  for (let i = 0; i < SYMBOLS.length; i++) {
    const card = cardAt(i);
    const changed = prev[i] !== SYMBOLS[i];
    paintCardIdentity(card, SYMBOLS[i]);
    if (changed) resetCardVisuals(card);
  }
  for (const s of prev) {
    if (!SYMBOLS.includes(s)) {
      delete lastPrices[s];
      delete lastAlertAt[s];
      delete lastAlertCandle[s];
    }
  }
  extrasGen += 1;
  klineInFlight = false;
  tickerGen += 1;
  inFlight = false;
  refresh({ manual: true });
}

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

function moneyPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 100) {
    return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  if (abs >= 1) {
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  if (abs === 0) return '0.00';
  const maxFrac = Math.min(10, Math.max(4, -Math.floor(Math.log10(abs)) + 3));
  return v.toLocaleString('en-US', {
    minimumFractionDigits: Math.min(4, maxFrac),
    maximumFractionDigits: maxFrac,
  });
}

function moneyRange(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs === 0 || abs >= 0.01) return money(v);
  return moneyPrice(v);
}

function signed(n) {
  const v = Number(n);
  const s = money(Math.abs(v));
  return (v > 0 ? '+' : v < 0 ? '−' : '') + s;
}

function signedAmt(n) {
  const v = Number(n);
  const abs = Math.abs(v);
  const s = abs === 0 || abs >= 0.01 ? money(abs) : moneyPrice(abs);
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
    const card = cardFor(t.symbol);
    if (!card) continue;

    const price = Number(t.lastPrice);
    const change = Number(t.priceChange);
    const pct = Number(t.priceChangePercent);
    const low = Number(t.lowPrice);
    const high = Number(t.highPrice);
    const prev = lastPrices[t.symbol];

    const priceEl = card.querySelector('[data-price]');
    const text = moneyPrice(price);
    priceEl.textContent = text;
    priceEl.classList.toggle('price-long', text.length > 9);

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
    card.querySelector('[data-change-amt]').textContent = signedAmt(change);
    card.querySelector('[data-change-pct]').textContent = signed(pct) + '%';

    const range = card.querySelector('.range');
    range.hidden = !(high > low);
    if (high > low) {
      card.querySelector('[data-low]').textContent = moneyRange(low);
      card.querySelector('[data-high]').textContent = moneyRange(high);
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
  if (inFlight && !manual) return;
  if (manual) refreshBtn.classList.add('spin');
  const gen = ++tickerGen;
  const symbols = [...SYMBOLS];
  inFlight = true;

  try {
    const res = await fetch(tickerUrl(symbols), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const tickers = await res.json();
    if (gen !== tickerGen) return;
    const updatedAt = Date.now();
    saveCache({ tickers, updatedAt, symbols });
    applyTickers(tickers, { updatedAt });
    refreshMarketExtras();
  } catch (err) {
    if (gen !== tickerGen) return;
    const cache = loadCache();
    if (cache?.tickers) {
      applyTickers(cache.tickers, { fromCache: true, updatedAt: cache.updatedAt });
    } else {
      setStatus('offline', '暫時攞唔到報價，稍後再試');
    }
    console.warn(err);
  } finally {
    if (gen === tickerGen) inFlight = false;
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
  universeTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshUniverse();
  }, UNIVERSE_MS);
  refreshMarketExtras();
  refreshUniverse();
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
  if (universeTimer) {
    clearInterval(universeTimer);
    universeTimer = null;
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
  const el = cardFor(symbol)?.querySelector('[data-chg-' + key + ']');
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

function applyTrailingChange(symbol, key, candles, msAgo, minCandles) {
  if (!candles || candles.length < minCandles) {
    applyPeriod(symbol, key, null);
    return;
  }
  const last = candles[candles.length - 1];
  const ago = closeAtOrBefore(candles, last.openTime - msAgo) || candles[candles.length - minCandles];
  applyPeriod(symbol, key, changePct(last.close, ago.close));
}

function applyHourChanges(symbol, candles) {
  applyTrailingChange(symbol, '1h', candles, 60 * 60 * 1000, 61);
  applyTrailingChange(symbol, '4h', candles, 4 * 60 * 60 * 1000, 241);
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

async function refreshWeekChanges(symbols) {
  const results = await Promise.allSettled(symbols.map(fetchWeekChange));
  symbols.forEach((symbol, i) => {
    if (results[i].status === 'fulfilled') applyPeriod(symbol, '7d', results[i].value);
  });
}

const SPARK_W = 240;
const SPARK_H = 100;
const SPARK_PAD_Y = 10;
const SVG_NS = 'http://www.w3.org/2000/svg';

async function fetchSparkline(symbol) {
  const cached = sparkCache[symbol];
  if (cached && Date.now() - cached.at < SPARK_TTL) return cached.closes;
  const url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol + '&interval=15m&limit=97';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const rows = await res.json();
  const closes = rows.map((row) => Number(row[4])).filter((n) => Number.isFinite(n));
  sparkCache[symbol] = { closes, at: Date.now() };
  return closes;
}

function sparkCoords(closes) {
  if (!closes || closes.length < 2) return null;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min;
  const last = closes.length - 1;
  return closes.map((c, i) => {
    const x = (i / last) * SPARK_W;
    const y = span === 0
      ? SPARK_H / 2
      : SPARK_PAD_Y + (1 - (c - min) / span) * (SPARK_H - SPARK_PAD_Y * 2);
    return [x, y];
  });
}

function fmtPt(p) {
  return p[0].toFixed(2) + ' ' + p[1].toFixed(2);
}

function smoothLine(points) {
  if (points.length < 2) return '';
  let d = 'M' + fmtPt(points[0]);
  if (points.length === 2) return d + ' L' + fmtPt(points[1]);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ' C' + fmtPt([c1x, c1y]) + ' ' + fmtPt([c2x, c2y]) + ' ' + fmtPt(p2);
  }
  return d;
}

function applySparkline(symbol, closes) {
  const svg = cardFor(symbol)?.querySelector('[data-spark]');
  if (!svg) return;
  svg.replaceChildren();
  const points = sparkCoords(closes);
  if (!points) {
    svg.setAttribute('class', 'spark');
    return;
  }
  const first = closes[0];
  const last = closes[closes.length - 1];
  const dir = last > first ? 'up' : last < first ? 'down' : '';
  svg.setAttribute('class', 'spark' + (dir ? ' ' + dir : ''));
  svg.setAttribute('viewBox', '0 0 ' + SPARK_W + ' ' + SPARK_H);
  svg.setAttribute('preserveAspectRatio', 'none');

  const lineD = smoothLine(points);
  const end = points[points.length - 1];
  const fillD = lineD + ' L' + end[0].toFixed(2) + ' ' + SPARK_H + ' L0 ' + SPARK_H + ' Z';

  const fill = document.createElementNS(SVG_NS, 'path');
  fill.setAttribute('class', 'spark-fill');
  fill.setAttribute('d', fillD);
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('class', 'spark-line');
  line.setAttribute('d', lineD);
  svg.append(fill, line);
}

async function refreshSparklines(symbols) {
  const results = await Promise.allSettled(symbols.map(fetchSparkline));
  symbols.forEach((symbol, i) => {
    if (results[i].status === 'fulfilled') applySparkline(symbol, results[i].value);
    else console.warn(results[i].reason);
  });
}

async function refreshMarketExtras() {
  if (document.visibilityState === 'hidden') return;
  if (klineInFlight) return;
  klineInFlight = true;
  const gen = ++extrasGen;
  const symbols = [...SYMBOLS];
  try {
    const klineP = Promise.allSettled(symbols.map(fetchKlines));
    const sparkP = refreshSparklines(symbols);
    const weekP = refreshWeekChanges(symbols);

    const results = await klineP;
    if (gen !== extrasGen) return;
    for (let i = 0; i < symbols.length; i++) {
      if (results[i].status !== 'fulfilled') {
        console.warn(results[i].reason);
        continue;
      }
      if (!SYMBOLS.includes(symbols[i])) continue;
      applyHourChanges(symbols[i], results[i].value);
      if (alertSettings.enabled) maybeAlert(symbols[i], detectSpike(results[i].value.slice(-180)));
    }
    await Promise.allSettled([sparkP, weekP]);
  } catch (err) {
    console.warn(err);
  } finally {
    if (gen === extrasGen) klineInFlight = false;
  }
}

function maybeAlert(symbol, spike) {
  if (!spike) return;
  if (!SYMBOLS.includes(symbol)) return;
  const now = Date.now();
  if (lastAlertCandle[symbol] === spike.candleOpen) return;
  if (lastAlertAt[symbol] && now - lastAlertAt[symbol] < COOLDOWN_MS) return;

  lastAlertAt[symbol] = now;
  lastAlertCandle[symbol] = spike.candleOpen;

  const name = displayName(symbol);
  const text = name + ' ' + spike.window + ' 分鐘成交急升 · 約 ' + formatQuote(spike.volume);
  const card = cardFor(symbol);
  const spikeEl = card?.querySelector('[data-spike]');
  if (spikeEl) {
    spikeEl.hidden = false;
    spikeEl.textContent = text.replace(name + ' ', '');
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

function ensureAlertEl() {
  if (alertEl) return alertEl;
  alertEl = new Audio('sounds/alert.mp3');
  alertEl.preload = 'auto';
  alertEl.playsInline = true;
  alertEl.setAttribute('playsinline', 'true');
  return alertEl;
}

function decodeAlertData(ctx, data) {
  return new Promise((resolve, reject) => {
    const ret = ctx.decodeAudioData(data, resolve, reject);
    if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
  });
}

function loadAlertBuffer() {
  if (alertBuffer) return Promise.resolve(alertBuffer);
  if (alertBufferLoading) return alertBufferLoading;
  const ctx = ensureAudio();
  if (!ctx) return Promise.resolve(null);
  alertBufferLoading = fetch('sounds/alert.mp3')
    .then((res) => {
      if (!res.ok) throw new Error('alert sound missing');
      return res.arrayBuffer();
    })
    .then((data) => decodeAlertData(ctx, data))
    .then((buf) => {
      alertBuffer = buf;
      alertBufferLoading = null;
      return buf;
    })
    .catch(() => {
      alertBufferLoading = null;
      return null;
    });
  return alertBufferLoading;
}

function stopHtmlKeepAlive() {
  clearTimeout(htmlSilenceTimer);
  htmlSilenceTimer = null;
  if (!alertEl) return;
  try {
    alertEl.volume = 0;
    alertEl.loop = false;
    alertEl.pause();
  } catch { /* ignore */ }
}

function stopAudioKeepAlive() {
  stopHtmlKeepAlive();
  if (keepAliveSrc) {
    try { keepAliveSrc.stop(); } catch { /* ignore */ }
    try { keepAliveSrc.disconnect(); } catch { /* ignore */ }
    keepAliveSrc = null;
  }
  if (audioKeepAliveTimer) {
    clearInterval(audioKeepAliveTimer);
    audioKeepAliveTimer = null;
  }
}

function startOscKeepAlive() {
  const ctx = audioCtx;
  if (!ctx || ctx.state !== 'running' || keepAliveSrc) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 20;
    osc.type = 'sine';
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => { if (keepAliveSrc === osc) keepAliveSrc = null; };
    osc.start();
    keepAliveSrc = osc;
  } catch { /* ignore */ }
}

function startAudioKeepAlive() {
  if (!alertSettings.enabled || !audioUnlocked) {
    stopAudioKeepAlive();
    return;
  }
  if (document.visibilityState !== 'visible') return;
  const ctx = audioCtx;
  if (ctx && ctx.state !== 'running') {
    if (keepAliveSrc) {
      try { keepAliveSrc.stop(); } catch { /* ignore */ }
      keepAliveSrc = null;
    }
    ctx.resume().then(() => {
      startOscKeepAlive();
    }).catch(() => {});
  } else {
    startOscKeepAlive();
  }
  startHtmlKeepAlive();
  if (!audioKeepAliveTimer) {
    audioKeepAliveTimer = setInterval(startAudioKeepAlive, 5000);
  }
}

function alertDurationMs(el) {
  const d = el?.duration;
  if (Number.isFinite(d) && d > 0.2) return Math.ceil(d * 1000);
  return 2400;
}

async function startHtmlKeepAlive() {
  if (!alertSettings.enabled || document.visibilityState !== 'visible') {
    stopHtmlKeepAlive();
    return false;
  }
  const el = ensureAlertEl();
  el.loop = true;
  el.muted = false;
  if (!htmlSilenceTimer) el.volume = 0;
  if (!el.paused) {
    htmlAudioUnlocked = true;
    return true;
  }
  try {
    if (el.ended || el.currentTime > 0) el.currentTime = 0;
    await el.play();
    htmlAudioUnlocked = true;
    return true;
  } catch {
    return false;
  }
}

async function unlockHtmlAudio() {
  return startHtmlKeepAlive();
}

async function unlockAudio({ preview = false } = {}) {
  const ctx = ensureAudio();
  try {
    if (ctx && ctx.state !== 'running') await ctx.resume();
    if (ctx) audioUnlocked = ctx.state === 'running';
  } catch {
    /* keep existing flag */
  }
  if (await unlockHtmlAudio()) audioUnlocked = true;
  if (audioUnlocked) await loadAlertBuffer();
  if (audioUnlocked) startAudioKeepAlive();
  else stopAudioKeepAlive();
  syncAlertUi();
  if (audioUnlocked && preview) playAlert();
  return audioUnlocked;
}

async function playAlertHtml(vol) {
  const el = ensureAlertEl();
  if (!el) return false;
  clearTimeout(htmlSilenceTimer);
  el.muted = false;
  el.loop = true;
  el.volume = vol;
  const armSilence = () => {
    htmlSilenceTimer = setTimeout(() => {
      htmlSilenceTimer = null;
      if (alertSettings.enabled && document.visibilityState === 'visible') {
        el.volume = 0;
      }
    }, alertDurationMs(el) + 40);
  };
  try {
    if (el.paused) {
      el.currentTime = 0;
      await el.play();
    } else {
      el.currentTime = 0;
    }
    armSilence();
    return true;
  } catch {
    el.volume = 0;
    return false;
  }
}

function playAlert() {
  if (!alertSettings.enabled || !audioUnlocked) return;
  playAlertNow();
}

async function playAlertNow() {
  const ctx = ensureAudio();
  const vol = Math.max(0.0001, alertSettings.volume);

  // Prefer the already-playing HTML element: just raise volume and rewind.
  // This does not need a new tap, unlike audio.play() or a suspended AudioContext.
  if (await playAlertHtml(vol)) return;

  if (ctx && ctx.state !== 'running') {
    try { await ctx.resume(); } catch { /* ignore */ }
  }

  if (ctx && ctx.state === 'running') {
    if (!alertBuffer) await loadAlertBuffer();
    if (alertBuffer) {
      try {
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = alertBuffer;
        gain.gain.value = vol;
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start();
        startAudioKeepAlive();
      } catch { /* ignore */ }
    }
  }
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

function summarizeTicker(t) {
  return {
    symbol: t.symbol,
    quoteVolume: Number(t.quoteVolume) || 0,
    priceChangePercent: Number(t.priceChangePercent) || 0,
    lastPrice: Number(t.lastPrice) || 0,
  };
}

function buildUniverse(tickers) {
  const eligible = [];
  const bySymbol = {};
  for (const t of tickers) {
    const symbol = t.symbol;
    if (!symbol || !symbol.endsWith('USDT') || isLeveragedToken(symbol)) continue;
    const row = summarizeTicker(t);
    bySymbol[symbol] = row;
    if (row.quoteVolume > 0 && row.lastPrice > 0) eligible.push(row);
  }
  eligible.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return { list: eligible.slice(0, TOP_N), bySymbol };
}

function pickerEntries() {
  const top = universeCache.list || [];
  const inTop = new Set(top.map((r) => r.symbol));
  const extras = [];
  const must = [...DEFAULT_PAIRS, ...SYMBOLS];
  for (const symbol of must) {
    if (inTop.has(symbol) || extras.some((r) => r.symbol === symbol)) continue;
    extras.push(universeCache.bySymbol[symbol] || {
      symbol,
      quoteVolume: 0,
      priceChangePercent: 0,
      lastPrice: 0,
    });
  }
  return { top, extras };
}

function renderPickerList() {
  const { top, extras } = pickerEntries();
  const selected = SYMBOLS[pickerSlot];
  pickerList.replaceChildren();

  if (!top.length && !universeCache.at) {
    const p = document.createElement('p');
    p.className = 'picker-status';
    p.textContent = universeInFlight ? '正在載入幣種名單…' : '暫時攞唔到名單，顯示預設幣種。';
    pickerList.append(p);
  } else if (universeCache.error && !top.length) {
    const p = document.createElement('p');
    p.className = 'picker-status';
    p.textContent = '暫時攞唔到最新名單，顯示預設同你而家揀緊嘅幣。';
    pickerList.append(p);
  }

  const appendItems = (rows) => {
    for (const row of rows) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker-item';
      btn.setAttribute('role', 'option');
      btn.dataset.symbol = row.symbol;
      const isSel = row.symbol === selected;
      btn.setAttribute('aria-selected', isSel ? 'true' : 'false');

      btn.append(logoNode(row.symbol, 32));

      const id = document.createElement('span');
      id.className = 'picker-id';
      const name = document.createElement('strong');
      name.textContent = displayName(row.symbol);
      const tick = document.createElement('span');
      tick.textContent = tickerLabel(row.symbol);
      id.append(name, tick);

      const meta = document.createElement('span');
      meta.className = 'picker-meta';
      const pct = document.createElement('span');
      const p = row.priceChangePercent;
      pct.className = 'pct' + (p > 0 ? ' up' : p < 0 ? ' down' : '');
      pct.textContent = row.lastPrice || row.quoteVolume ? signed(p) + '%' : '—';
      const vol = document.createElement('span');
      vol.textContent = row.quoteVolume ? formatQuote(row.quoteVolume) : '—';
      meta.append(pct, vol);

      const check = document.createElement('span');
      check.className = 'picker-check';
      check.textContent = isSel ? '✓' : '';
      check.setAttribute('aria-hidden', 'true');

      btn.append(id, meta, check);
      btn.addEventListener('click', () => selectPair(pickerSlot, row.symbol));
      pickerList.append(btn);
    }
  };

  if (top.length) {
    appendItems(top);
  }
  if (extras.length) {
    const sep = document.createElement('p');
    sep.className = 'picker-sep';
    sep.textContent = top.length ? '預設或你而家揀緊（唔喺頭 20）' : '預設同你而家揀緊';
    pickerList.append(sep);
    appendItems(extras);
  }

  pickerSub.textContent = top.length
    ? PICKER_SUB
    : (universeInFlight ? '正在載入最新成交量排名…' : PICKER_SUB);
}

async function refreshUniverse({ force = false } = {}) {
  if (!force && universeCache.at && Date.now() - universeCache.at < UNIVERSE_MS && universeCache.list.length) {
    return universeCache;
  }
  if (universeInFlight) return universeCache;
  universeInFlight = true;
  if (!pickerEl.hidden) renderPickerList();
  try {
    const res = await fetch(TICKER_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const tickers = await res.json();
    const { list, bySymbol } = buildUniverse(tickers);
    universeCache.at = Date.now();
    universeCache.list = list;
    universeCache.bySymbol = bySymbol;
    universeCache.error = false;
  } catch (err) {
    console.warn(err);
    universeCache.error = true;
  } finally {
    universeInFlight = false;
    if (!pickerEl.hidden) renderPickerList();
  }
  return universeCache;
}

function openPicker(slot, trigger) {
  pickerSlot = slot;
  pickerReturnFocus = trigger || cardAt(slot).querySelector('.card-head');
  pickerEl.hidden = false;
  document.body.classList.add('picker-open');
  document.querySelectorAll('.card-head').forEach((el, i) => {
    el.setAttribute('aria-expanded', i === slot ? 'true' : 'false');
  });
  renderPickerList();
  refreshUniverse().then(() => {
    if (!pickerEl.hidden && pickerSlot === slot) renderPickerList();
  });
  const closeBtn = document.getElementById('pickerClose');
  (closeBtn || pickerSheet).focus();
}

function closePicker() {
  if (pickerEl.hidden) return;
  pickerEl.hidden = true;
  document.body.classList.remove('picker-open');
  document.querySelectorAll('.card-head').forEach((el) => {
    el.setAttribute('aria-expanded', 'false');
  });
  pickerReturnFocus?.focus?.();
  pickerReturnFocus = null;
}

function selectPair(slot, symbol) {
  if (!PAIR_RE.test(symbol)) return;
  const next = [...SYMBOLS];
  const other = slot === 0 ? 1 : 0;
  if (next[slot] === symbol) {
    closePicker();
    return;
  }
  if (next[other] === symbol) {
    const tmp = next[0];
    next[0] = next[1];
    next[1] = tmp;
  } else {
    next[slot] = symbol;
  }
  applyPairs(next);
  closePicker();
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
    stopAudioKeepAlive();
  }
});

document.addEventListener('pointerdown', () => {
  if (alertSettings.enabled) unlockAudio();
}, { passive: true });

alertToggle.addEventListener('click', async () => {
  alertSettings.enabled = !alertSettings.enabled;
  saveAlertSettings();
  if (alertSettings.enabled) {
    await unlockAudio({ preview: true });
    refreshMarketExtras();
  } else {
    stopAudioKeepAlive();
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

document.querySelectorAll('.card-head').forEach((head) => {
  head.addEventListener('click', () => {
    const slot = Number(head.closest('.card')?.dataset.slot);
    if (Number.isInteger(slot)) openPicker(slot, head);
  });
});

pickerEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-picker-close]')) closePicker();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pickerEl.hidden) {
    e.preventDefault();
    closePicker();
  }
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
  if (!pickerEl.hidden) return;
  if (window.scrollY <= 0) {
    startY = e.touches[0].clientY;
    pulling = true;
  }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!pulling) return;
  if (!pickerEl.hidden) {
    pulling = false;
    refreshHint.hidden = true;
    return;
  }
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
  if (!pickerEl.hidden) return;
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
  navigator.serviceWorker.register('./sw.js?v=24').catch(() => {});
}

SYMBOLS.forEach((symbol, i) => paintCardIdentity(cardAt(i), symbol));
syncAlertUi();
syncWakeUi();
applyWakeLock();
const cache = loadCache();
if (cache?.tickers) applyTickers(cache.tickers, { fromCache: !navigator.onLine, updatedAt: cache.updatedAt });
refresh();
startPolling();
