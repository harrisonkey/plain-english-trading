// api/analyze.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLY = process.env.POLYGON_API_KEY;
  const CLAUDE = process.env.ANTHROPIC_API_KEY;
  if (!POLY || !CLAUDE) return res.status(500).json({ error: 'Missing API keys' });

  const { ticker } = req.body || req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  const sym = ticker.toUpperCase().trim();

  try {
    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate()-60);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = today.toISOString().split('T')[0];

    const [priceR, spyR, newsR] = await Promise.allSettled([
      fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=60&apiKey=${POLY}`).then(r=>r.json()),
      fetch(`https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=25&apiKey=${POLY}`).then(r=>r.json()),
      fetch(`https://api.polygon.io/v2/reference/news?ticker=${sym}&limit=3&apiKey=${POLY}`).then(r=>r.json()),
    ]);

    const bars = priceR.status==='fulfilled'?(priceR.value.results||[]):[];
    const spyBars = spyR.status==='fulfilled'?(spyR.value.results||[]):[];
    const news = newsR.status==='fulfilled'?(newsR.value.results||[]):[];

    if (!bars.length) return res.status(404).json({ error:`No data found for ${sym}. Check the ticker and try again.` });

    const price = bars[0].c;
    const vol = bars[0].v;
    const avgVol = bars.slice(1,21).reduce((s,b)=>s+(b.v||0),0)/20;
    const volMult = (vol/avgVol).toFixed(1);
    const ma10 = bars.slice(0,10).reduce((s,b)=>s+b.c,0)/Math.min(10,bars.length);
    const ma20 = bars.slice(0,20).reduce((s,b)=>s+b.c,0)/Math.min(20,bars.length);
    const ma50 = bars.slice(0,50).reduce((s,b)=>s+b.c,0)/Math.min(50,bars.length);
    const spyPrice = spyBars[0]?.c||500;
    const spy20 = spyBars.slice(0,20).reduce((s,b)=>s+b.c,0)/Math.min(20,spyBars.length);
    const spyTrend = spyPrice>spy20?'BULLISH':'BEARISH';
    const weekChg = bars[4]?.c?(((price-bars[4].c)/bars[4].c)*100).toFixed(1):'0';
    const monthChg = bars[19]?.c?(((price-bars[19].c)/bars[19].c)*100).toFixed(1):'0';
    const hi60 = Math.max(...bars.map(b=>b.h)).toFixed(2);
    const lo60 = Math.min(...bars.map(b=>b.l)).toFixed(2);
    const headlines = news.slice(0,3).map(n=>n.title).join(' | ') || 'No recent news';
    const dateStr = new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});

    const prompt = `Today is ${dateStr}. Analyze ${sym} for a Plain English Trading options recommendation.

REAL MARKET DATA FROM POLYGON:
Ticker: ${sym}
Current price: $${price.toFixed(2)}
Volume today: ${(vol||0).toLocaleString()} (${volMult}x average — ${parseFloat(volMult)>=2?'STRONG SIGNAL':parseFloat(volMult)>=1.5?'MODERATE SIGNAL':'WEAK SIGNAL'})
10-day MA: $${ma10.toFixed(2)} | 20-day MA: $${ma20.toFixed(2)} | 50-day MA: $${ma50.toFixed(2)}
Price vs MAs: ${price>ma10?'ABOVE':'BELOW'} 10MA, ${price>ma20?'ABOVE':'BELOW'} 20MA, ${price>ma50?'ABOVE':'BELOW'} 50MA
1-week move: ${weekChg}% | 1-month move: ${monthChg}%
60-day range: $${lo60} to $${hi60}
Recent news: ${headlines}
SPY trend: ${spyTrend} ($${spyPrice.toFixed(2)} vs 20MA $${spy20.toFixed(2)})

HARD RULES:
1. Only recommend ${spyTrend==='BULLISH'?'CALLS':'PUTS'} — market is ${spyTrend}
2. Strike: nearest OTM
3. Expiry: 30-45 days from today
4. Skip if earnings within 14 days
5. Price range $5-$80 only
6. Be specific with real numbers based on real price data above

Return ONLY raw JSON:
{
  "sym": "${sym}",
  "name": "Full company name",
  "sector": "sector",
  "price": "${price.toFixed(2)}",
  "verdict": "BUY",
  "confidence": "HIGH",
  "type": "CALL",
  "strike": 45,
  "expiry": "May 16 2026",
  "days_to_expiry": 43,
  "est_premium": 1.80,
  "cost_per_contract": 180,
  "sell_at_premium": 3.60,
  "stop_at_premium": 0.90,
  "stock_must_reach": 48,
  "stock_get_out_if": 40,
  "vol_spike": "${volMult}x",
  "risk": 48,
  "spy_aligned": ${spyTrend==='BULLISH'},
  "confidence_reason": "One sentence why this is high/medium/low confidence",
  "what_to_do": "Plain English exact instructions: what to buy, what to pay, when to sell, when to get out",
  "why_plain_english": "Two sentences. No jargon. Why will this stock move? What is the catalyst?",
  "green_flags": ["Real flag based on actual data","Real flag 2","Real flag 3"],
  "red_flags": ["Real warning based on actual data","Real warning 2"],
  "verdict_label": "BUY NOW",
  "skip": false,
  "skip_reason": null,
  "sizing": {
    "account_500": {"contracts":1,"total_cost":180,"max_loss":90,"potential_gain":180},
    "account_1000": {"contracts":2,"total_cost":360,"max_loss":180,"potential_gain":360},
    "account_5000": {"contracts":5,"total_cost":900,"max_loss":450,"potential_gain":900}
  }
}`;

    const cRes = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':CLAUDE,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1500, system:'You are Plain English Trading. Use the real Polygon data provided to give specific, accurate options recommendations. Respond ONLY with raw JSON.', messages:[{role:'user',content:prompt}] })
    });
    const cData = await cRes.json();
    const raw = (cData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const clean = raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    let analysis;
    try { analysis=JSON.parse(clean); }
    catch(e) { const m=clean.match(/\{[\s\S]*\}/); analysis=m?JSON.parse(m[0]):{verdict:'SKIP',skip:true,skip_reason:'Analysis failed — try again'}; }

    return res.status(200).json({ ...analysis, spyTrend, raw_data:{ price, ma10, ma20, ma50, volMult, weekChg, monthChg, hi60, lo60 }, timestamp:new Date().toISOString() });

  } catch(err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
