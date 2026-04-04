// api/scan.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLY = process.env.POLYGON_API_KEY;
  const CLAUDE = process.env.ANTHROPIC_API_KEY;
  if (!POLY || !CLAUDE) return res.status(500).json({ error: 'Missing API keys. Add POLYGON_API_KEY and ANTHROPIC_API_KEY in Vercel environment variables.' });

  try {
    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate() - 35);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = today.toISOString().split('T')[0];

    // GATE 1: SPY trend
    const spyR = await fetch(`https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=25&apiKey=${POLY}`);
    const spyD = await spyR.json();
    const spyBars = spyD.results || [];
    const spyPrice = spyBars[0]?.c || 500;
    const spy20 = spyBars.slice(0,20).reduce((s,b)=>s+b.c,0)/Math.min(20,spyBars.length);
    const spyTrend = spyPrice > spy20 ? 'BULLISH' : 'BEARISH';
    const spyChg = spyBars[0] ? (((spyBars[0].c-spyBars[0].o)/spyBars[0].o)*100).toFixed(2) : '0';

    // VIX
    const vixR = await fetch(`https://api.polygon.io/v2/aggs/ticker/I:VIX/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=2&apiKey=${POLY}`);
    const vixD = await vixR.json();
    const vix = vixD.results?.[0]?.c || 18;

    // Small cap candidates — diverse sectors, $5-$80 range
    const TICKERS = [
      'OXY','MRO','CIVI','MTDR','CHRD','SM',       // Energy
      'SOUN','IONQ','RKLB','ACHR','JOBY','BTDR',    // Small tech
      'ARDX','PRAX','VKTX','RXRX','BEAM','IMVT',    // Biotech
      'KTOS','AVAV','RCAT','ASTS','LUNR',            // Defense/space
      'MP','UUUU','NXE','LAC','LITM',               // Materials
      'UWMC','RKT','PFSI','COOP','GHLD',            // Financials
      'CLFD','SMCI','AEHR','FORM','VICR',           // Tech hardware
    ];

    // Fetch price data for all candidates
    const results = await Promise.allSettled(
      TICKERS.map(sym =>
        fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=25&apiKey=${POLY}`)
          .then(r=>r.json())
          .then(d=>({ sym, bars: d.results||[] }))
      )
    );

    // Apply hard filters
    const passed = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { sym, bars } = r.value;
      if (!bars || bars.length < 10) continue;
      const price = bars[0]?.c;
      if (!price || price < 5 || price > 80) continue;         // Price gate
      const avgVol = bars.slice(1,21).reduce((s,b)=>s+(b.v||0),0)/20;
      const todayVol = bars[0]?.v || 0;
      const volMult = avgVol > 0 ? todayVol/avgVol : 0;
      if (volMult < 1.5) continue;                              // Volume gate
      const ma10 = bars.slice(0,10).reduce((s,b)=>s+b.c,0)/Math.min(10,bars.length);
      const ma20 = bars.slice(0,20).reduce((s,b)=>s+b.c,0)/Math.min(20,bars.length);
      const weekChg = bars[4]?.c ? (((price-bars[4].c)/bars[4].c)*100).toFixed(1) : '0';
      const monthChg = bars[19]?.c ? (((price-bars[19].c)/bars[19].c)*100).toFixed(1) : '0';
      passed.push({ sym, price: price.toFixed(2), volMult: volMult.toFixed(1), ma10: ma10.toFixed(2), ma20: ma20.toFixed(2), weekChg, monthChg, aboveMa10: price>ma10, aboveMa20: price>ma20 });
    }

    passed.sort((a,b)=>parseFloat(b.volMult)-parseFloat(a.volMult));
    const top = passed.slice(0,10);

    if (!top.length) {
      return res.status(200).json({ spyTrend, spyPrice: spyPrice.toFixed(2), spyChg, vix: vix.toFixed(1), picks:[], marketNote:'No tickers passed filters today. Market may be in a low-volume consolidation phase.', timestamp: new Date().toISOString() });
    }

    // Claude analysis
    const dateStr = new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    const prompt = `Today is ${dateStr}. Market: SPY ${spyTrend} at $${spyPrice.toFixed(2)} vs 20MA $${spy20.toFixed(2)}. VIX: ${vix.toFixed(1)}.

These small-cap tickers passed all volume and price filters:
${JSON.stringify(top,null,2)}

You are Plain English Trading — the most beginner-friendly options coach ever built. Your job is to find the best 4-6 options trades from this list and explain them so simply that anyone can understand and act immediately.

HARD RULES:
1. Only recommend ${spyTrend==='BULLISH'?'CALLS':'PUTS'} — SPY is ${spyTrend}
2. Strike price: nearest OTM (out of the money, just above/below current price)
3. Expiry: exactly 30-45 days from today
4. Only include tickers with genuine momentum or catalyst — skip noise
5. Confidence must be HIGH or MEDIUM — skip LOW confidence setups
6. Focus on small caps where a 20-30% stock move is realistic

Return ONLY raw JSON, no markdown:
{
  "market_summary": "One sentence on market conditions right now in plain English",
  "play_type": "${spyTrend==='BULLISH'?'CALLS — betting stocks go UP':'PUTS — betting stocks go DOWN'}",
  "top_pick": "TICKER",
  "picks": [
    {
      "sym": "TICKER",
      "name": "Full Company Name",
      "sector": "Energy",
      "price": "42.10",
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
      "vol_spike": "2.4x",
      "risk": 45,
      "confidence_reason": "One sentence: exactly why this is high confidence",
      "what_to_do": "Buy 1 contract of TICKER $45 Call expiring May 16. Pay around $1.80 per contract ($180 total). Sell when premium hits $3.60. Get out if premium drops to $0.90.",
      "why_plain_english": "Two sentences max. No jargon. Why is this stock likely to move up? What is the specific catalyst or pattern?",
      "green_flags": ["Simple flag 1","Simple flag 2","Simple flag 3"],
      "red_flags": ["Simple warning 1","Simple warning 2"],
      "skip": false,
      "skip_reason": null
    }
  ]
}`;

    const cRes = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':CLAUDE,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:2000, system:'You are Plain English Trading — an options coach that explains everything simply. Respond ONLY with raw JSON.', messages:[{role:'user',content:prompt}] })
    });
    const cData = await cRes.json();
    const raw = (cData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const clean = raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    let analysis;
    try { analysis=JSON.parse(clean); }
    catch(e) { const m=clean.match(/\{[\s\S]*\}/); analysis=m?JSON.parse(m[0]):{picks:[],market_summary:'Parse error',top_pick:''}; }

    return res.status(200).json({ spyTrend, spyPrice:spyPrice.toFixed(2), spyChg, spy20:spy20.toFixed(2), vix:vix.toFixed(1), ...analysis, timestamp:new Date().toISOString() });

  } catch(err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
