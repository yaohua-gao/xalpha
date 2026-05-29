// ============================================================
// Vercel Serverless Function · Unified Options Data Proxy
// 自动路由策略（按优先级）：
//   1. TRADIER_TOKEN     → Tradier（Greeks 最准，需要 brokerage 审核）
//   2. MARKETDATA_TOKEN  → MarketData.app（注意：免费层 IP 锁，不适合 Vercel）
//   3. POLYGON_API_KEY   → Polygon.io（serverless 友好，免费 5 req/min）
//   都没有 → NO_PROVIDER_TOKEN 错误
//
// 输出格式（统一规范，前端无需关心 provider）：
//   GET ?endpoint=quote&symbol=MSTR
//     → { last, change, changePct, volume, name, divYield }
//   GET ?endpoint=expirations&symbol=MSTR
//     → ["YYYY-MM-DD", ...]
//   GET ?endpoint=chain&symbol=MSTR&expiration=YYYY-MM-DD
//     → [{ strike, option_type, openInterest, volume, impliedVolatility,
//          gamma, delta, theta, vega, bid, ask, last, expiration }, ...]
// ============================================================

const TRADIER_TOKEN = process.env.TRADIER_TOKEN;
const MARKETDATA_TOKEN = process.env.MARKETDATA_TOKEN;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const PROVIDER = TRADIER_TOKEN ? 'tradier'
              : MARKETDATA_TOKEN ? 'marketdata'
              : POLYGON_API_KEY ? 'polygon'
              : null;

// 指数类（部分 provider 用专门端点）
const INDEX_SYMBOLS = new Set(['SPX', 'VIX', 'NDX', 'RUT', 'DJX', 'OEX', 'XSP', 'XEO']);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!PROVIDER) {
    res.status(500).json({
      error: 'NO_PROVIDER_TOKEN',
      hint: '在 Vercel Settings → Environment Variables 添加 MARKETDATA_TOKEN（推荐）或 TRADIER_TOKEN',
    });
    return;
  }

  const { endpoint, symbol, expiration } = req.query || {};
  if (!endpoint) { res.status(400).json({ error: 'MISSING_ENDPOINT' }); return; }
  if (!symbol)   { res.status(400).json({ error: 'MISSING_SYMBOL' }); return; }

  const sym = String(symbol).toUpperCase().trim();

  try {
    let result;
    if (PROVIDER === 'tradier')          result = await callTradier(endpoint, sym, expiration);
    else if (PROVIDER === 'marketdata')  result = await callMarketData(endpoint, sym, expiration);
    else if (PROVIDER === 'polygon')     result = await callPolygon(endpoint, sym, expiration);
    else throw new Error('Provider misconfigured');

    res.setHeader('X-Data-Provider', PROVIDER);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(result);
  } catch (e) {
    res.status(502).json({ error: 'PROVIDER_FAIL', provider: PROVIDER, message: e.message });
  }
};

/* ====================== MarketData.app ====================== */
async function mdGet(path) {
  const r = await fetch(`https://api.marketdata.app${path}`, {
    headers: {
      'Authorization': `Bearer ${MARKETDATA_TOKEN}`,
      'Accept': 'application/json',
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`MD HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const d = await r.json();
  if (d.s && d.s !== 'ok') throw new Error(`MD: ${d.s}${d.errmsg ? ' · ' + d.errmsg : ''}`);
  return d;
}

async function callMarketData(endpoint, sym, expiration) {
  if (endpoint === 'quote') {
    const path = INDEX_SYMBOLS.has(sym)
      ? `/v1/indices/quotes/${encodeURIComponent(sym)}/`
      : `/v1/stocks/quotes/${encodeURIComponent(sym)}/`;
    const d = await mdGet(path);
    return {
      last:      d.last?.[0] ?? d.mid?.[0] ?? null,
      change:    d.change?.[0] ?? 0,
      changePct: (d.changepct?.[0] ?? 0) * 100,
      volume:    d.volume?.[0] ?? 0,
      name:      sym,
      divYield:  0,
    };
  }

  if (endpoint === 'expirations') {
    const d = await mdGet(`/v1/options/expirations/${encodeURIComponent(sym)}/`);
    return d.expirations || [];
  }

  if (endpoint === 'chain') {
    if (!expiration) throw new Error('expiration required');
    const d = await mdGet(`/v1/options/chain/${encodeURIComponent(sym)}/?expiration=${expiration}`);
    const n = d.optionSymbol?.length || 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        strike:             d.strike[i],
        option_type:        d.side[i],                 // 'call' / 'put'
        openInterest:       d.openInterest?.[i] ?? 0,
        volume:             d.volume?.[i] ?? 0,
        impliedVolatility:  d.iv?.[i] ?? null,
        gamma:              d.gamma?.[i] ?? null,      // provider-given Greeks ✨
        delta:              d.delta?.[i] ?? null,
        theta:              d.theta?.[i] ?? null,
        vega:               d.vega?.[i] ?? null,
        bid:                d.bid?.[i],
        ask:                d.ask?.[i],
        last:               d.last?.[i],
        expiration,
      });
    }
    return out;
  }

  throw new Error('Unknown endpoint: ' + endpoint);
}

/* ====================== Tradier ====================== */
async function trGet(path) {
  const r = await fetch(`https://sandbox.tradier.com/v1${path}`, {
    headers: {
      'Authorization': `Bearer ${TRADIER_TOKEN}`,
      'Accept': 'application/json',
    },
  });
  if (!r.ok) throw new Error(`Tradier HTTP ${r.status}`);
  return r.json();
}

async function callTradier(endpoint, sym, expiration) {
  if (endpoint === 'quote') {
    const d = await trGet(`/markets/quotes?symbols=${encodeURIComponent(sym)}`);
    const q = d.quotes?.quote;
    const quote = Array.isArray(q) ? q[0] : q;
    if (!quote) throw new Error('No quote for ' + sym);
    return {
      last:      parseFloat(quote.last || quote.close || quote.prevclose),
      change:    parseFloat(quote.change),
      changePct: parseFloat(quote.change_percentage),
      volume:    parseFloat(quote.volume),
      name:      quote.description || sym,
      divYield:  0,
    };
  }

  if (endpoint === 'expirations') {
    const d = await trGet(`/markets/options/expirations?symbol=${encodeURIComponent(sym)}&includeAllRoots=true&strikes=false`);
    const arr = d.expirations?.date || [];
    return Array.isArray(arr) ? arr : [arr];
  }

  if (endpoint === 'chain') {
    if (!expiration) throw new Error('expiration required');
    const d = await trGet(`/markets/options/chains?symbol=${encodeURIComponent(sym)}&expiration=${expiration}&greeks=true`);
    const opts = d.options?.option || [];
    const list = Array.isArray(opts) ? opts : [opts];
    return list.map(o => ({
      strike:            o.strike,
      option_type:       o.option_type,
      openInterest:      o.open_interest || 0,
      volume:            o.volume || 0,
      impliedVolatility: o.greeks?.mid_iv ?? o.greeks?.smv_vol ?? null,
      gamma:             o.greeks?.gamma ?? null,
      delta:             o.greeks?.delta ?? null,
      theta:             o.greeks?.theta ?? null,
      vega:              o.greeks?.vega ?? null,
      bid:               o.bid,
      ask:               o.ask,
      last:              o.last,
      expiration,
    }));
  }

  throw new Error('Unknown endpoint: ' + endpoint);
}

/* ====================== Polygon.io ====================== */
async function polyGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.polygon.io${path}${sep}apiKey=${POLYGON_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Polygon HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const d = await r.json();
  if (d.status && d.status === 'ERROR') throw new Error(`Polygon: ${d.error || 'unknown'}`);
  return d;
}

async function callPolygon(endpoint, sym, expiration) {
  // Polygon 指数代码加 I: 前缀（如 SPX → I:SPX）
  const polySym = INDEX_SYMBOLS.has(sym) ? `I:${sym}` : sym;

  if (endpoint === 'quote') {
    // 免费层用 EOD 上一日 close（实时数据需付费）
    const d = await polyGet(`/v2/aggs/ticker/${encodeURIComponent(polySym)}/prev`);
    const r = d.results?.[0];
    if (!r) throw new Error('No quote for ' + sym);
    const change = (r.c ?? 0) - (r.o ?? r.c);
    return {
      last:      r.c ?? null,
      change:    change,
      changePct: r.o ? (change / r.o) * 100 : 0,
      volume:    r.v ?? 0,
      name:      sym,
      divYield:  0,
    };
  }

  if (endpoint === 'expirations') {
    // Polygon 无独立 expirations 端点；从 options snapshot 提取 unique dates
    const d = await polyGet(`/v3/snapshot/options/${encodeURIComponent(sym)}?limit=250`);
    const expSet = new Set();
    for (const opt of d.results || []) {
      const exp = opt.details?.expiration_date;
      if (exp) expSet.add(exp);
    }
    return [...expSet].sort();
  }

  if (endpoint === 'chain') {
    if (!expiration) throw new Error('expiration required');
    // 按到期日筛选 snapshot
    let url = `/v3/snapshot/options/${encodeURIComponent(sym)}?expiration_date=${expiration}&limit=250`;
    const all = [];
    // 处理 pagination（虽然 250 通常一次够单到期）
    while (url) {
      const d = await polyGet(url);
      for (const opt of d.results || []) {
        all.push({
          strike:            opt.details?.strike_price,
          option_type:       opt.details?.contract_type,   // 'call' / 'put'
          openInterest:      opt.open_interest ?? 0,
          volume:            opt.day?.volume ?? 0,
          impliedVolatility: opt.implied_volatility ?? null,
          gamma:             opt.greeks?.gamma ?? null,    // 免费层可能为 null → 前端走 BS
          delta:             opt.greeks?.delta ?? null,
          theta:             opt.greeks?.theta ?? null,
          vega:              opt.greeks?.vega ?? null,
          bid:               opt.last_quote?.bid,
          ask:               opt.last_quote?.ask,
          last:              opt.day?.close,
          expiration,
        });
      }
      // next_url 已经包含 apiKey，去掉前缀单独处理
      if (d.next_url) {
        const next = new URL(d.next_url);
        url = next.pathname + next.search;
      } else url = null;
    }
    return all;
  }

  throw new Error('Unknown endpoint: ' + endpoint);
}
