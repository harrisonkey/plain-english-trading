// api/analyze.js — Single ticker deep analysis
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLY   = process.env.POLYGON_API_KEY;
  const CLAUDE = process.env.ANTHROPIC_API_KEY;
  if (!POLY || !CLAUDE) return res.status(500).json({ error: 'Missing API keys' });

  const { sym } = req.body || req.query;
  if (!sym) return res.status(400).json({ error: 'sym required' });
  const ticker = sym.toUpperCase().trim();

  try {
    const today = new Date();
    const from  = new Date(today); from.setDate(from.getDate() - 60);
    const toStr   = today.toISOString().split('T')[0];
    const fromStr = from.toISOString().split('T')[0];

    const [tickR, spyR] = await Promise.all([
      fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=50&apiKey=${POLY}`).then(r=>r.json()),
      fetch(`https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=25&apiKey=${POLY}`).then(r=>r.json()),
    ]);

    const bars    = tickR.results || [];
    const spyBars = spyR.results  || [];

    if (!bars.length) return res.status(200).json({ error: `No data found for ${ticker}. Check the ticker symbol.` });

    const price   = bars[0].c;
    const ma10    = bars.slice(0,10).reduce((s,b)=>s+b.c,0) / Math.min(10, bars.length);
    const ma20    = bars.slice(0,20).reduce((s,b)=>s+b.c,0) / Math.min(20, bars.length);
    const ma50    = bars.slice(0,50).reduce((s,b)=>s+b.c,0) / Math.min(50, bars.length);
    const avgVol  = bars.slice(1,21).reduce((s,b)=>s+(b.v||0),0) / 20;
    const todVol  = bars[0].v || 0;
    const volMult = avgVol > 0 ? (todVol/avgVol).toFixed(1) : 'N/A';
    const weekChg  = bars[4]?.c  ? (((price-bars[4].c)/bars[4].c)*100).toFixed(1)  : 'N/A';
    const monthChg = bars[19]?.c ? (((price-bars[19].c)/bars[19].c)*100).toFixed(1) : 'N/A';
    const high52   = Math.max(...bars.map(b=>b.h||0)).toFixed(2);
    const low52    = Math.min(...bars.map(b=>b.l||9999)).toFixed(2);

    const spyPrice = spyBars[0]?.c || 500;
    const spy20    = spyBars.slice(0,20).reduce((s,b)=>s+b.c,0) / Math.min(20, spyBars.length);
    const spyTrend = spyPrice > spy20 ? 'BULLISH' : 'BEARISH';

    const prompt = `Analyze ${ticker} for an options trade today.

Price data:
- Current price: $${price.toFixed(2)}
- 10-day MA: $${ma10.toFixed(2)} (price is ${price>ma10?'ABOVE':'BELOW'})
- 20-day MA: $${ma20.toFixed(2)} (price is ${price>ma20?'ABOVE':'BELOW'})
- 50-day MA: $${ma50.toFixed(2)} (price is ${price>ma50?'ABOVE':'BELOW'})
- Volume today vs 20-day avg: ${volMult}x
- 1 week change: ${weekChg}%
- 1 month change: ${monthChg}%
- 52-week range: $${low52} - $${high52}
- SPY market trend: ${spyTrend}

Give a specific options trade recommendation in plain English.

Return ONLY raw JSON:
{
  "sym": "${ticker}",
  "name": "Full Company Name",
  "sector": "Sector",
  "price": "${price.toFixed(2)}",
  "verdict": "BUY or SKIP",
  "confidence": "HIGH or MEDIUM or LOW",
  "type": "CALL or PUT",
  "strike": 45,
  "expiry": "May 16 2026",
  "days_to_expiry": 41,
  "est_premium": 1.80,
  "cost_per_contract": 180,
  "sell_at_premium": 3.60,
  "stop_at_premium": 0.90,
  "stock_target": 48,
  "stock_stop": 40,
  "vol_spike": "${volMult}x",
  "risk_score": 50,
  "what_to_do": "Specific instruction: Buy X contract of TICKER $Y Call expiring Date. Pay ~$Z per contract. Sell when premium hits $XX. Exit if premium drops to $XX.",
  "why": "Two sentences. Why will this move? What is the specific pattern or catalyst?",
  "green_flags": ["flag 1","flag 2","flag 3"],
  "red_flags": ["warning 1","warning 2"],
  "sizing": {
    "account_5k": { "contracts": 1, "max_loss": 90, "potential_gain": 180 },
    "account_10k": { "contracts": 2, "max_loss": 180, "potential_gain": 360 },
    "account_25k": { "contracts": 5, "max_loss": 450, "potential_gain": 900 }
  }
}`;

    const cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: 'Plain English Trading. Return ONLY raw JSON.', messages: [{ role: 'user', content: prompt }] })
    });
    const cj = await cr.json();
    const raw = (cj.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const clean = raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    let result;
    try { result = JSON.parse(clean); }
    catch(e) { const m = clean.match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : { error: 'Parse error' }; }

    return res.status(200).json({ ...result, timestamp: new Date().toISOString() });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
