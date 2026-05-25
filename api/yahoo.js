const INDEX_SYMBOLS = new Set(['SPX', 'VIX', 'NDX', 'RUT', 'DJX', 'OEX', 'XSP', 'SPXW']);

function normalizeSymbol(sym) {
  const s = String(sym).toUpperCase().trim();
  if (INDEX_SYMBOLS.has(s)) return '^' + s;
  return s;
}

const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

async function tryFetch(path) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const r = await fetch(`https://${host}${path}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('All Yahoo hosts failed');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const { endpoint, symbol, expiration } = req.query || {};

  if (!['quote', 'options'].includes(endpoint)) {
    res.status(400).json({ error: 'INVALID_ENDPOINT', allowed: ['quote', 'options'] });
    return;
  }
  if (!symbol) {
    res.status(400).json({ error: 'MISSING_SYMBOL' });
    return;
  }

  const sym = normalizeSymbol(symbol);
  let path;

  if (endpoint === 'quote') {
    path = `/v7/finance/quote?symbols=${encodeURIComponent(sym)}`;
  } else {
    path = `/v7/finance/options/${encodeURIComponent(sym)}`;
    if (expiration) path += `?date=${expiration}`;
  }

  try {
    const data = await tryFetch(path);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'YAHOO_FAIL', message: e.message });
  }
};
