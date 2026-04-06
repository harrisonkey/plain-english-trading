// api/scan.js — Two-stage scanner. 90 tickers. Learning system integrated.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLY   = process.env.POLYGON_API_KEY;
  const CLAUDE = process.env.ANTHROPIC_API_KEY;
  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOK = process.env.KV_REST_API_TOKEN;
  if (!POLY || !CLAUDE) return res.status(500).json({ error: 'Missing API keys' });

  // All 90 tickers across 9 sectors
  const ALL = [
    'OXY','MRO','CIVI','MTDR','CHRD','SM','GPOR','VTLE','MNRL','BATL',
    'KTOS','AVAV','RCAT','ASTS','LUNR','JOBY','ACHR','BYRN','RKLB','SPCE',
    'SOUN','IONQ','BTDR','BBAI','CXAI','MIND','REAX','PRCT','VZIO','AMBA',
    'ARDX','PRAX','VKTX','RXRX','BEAM','IMVT','ARQT','NRIX','TGTX','CRSP',
    'MP','UUUU','NXE','LAC','LITM','WOLF','GATO','USAS','CDE','HL',
    'UWMC','RKT','PFSI','COOP','GHLD','OPFI','LPRO','ATLC','ENVA','PRAA',
    'SMCI','AEHR','FORM','VICR','DIOD','AOSL','SITM','SWKS','ALGM','AAOI',
    'ARRY','SHLS','STEM','NOVA','FLUX','CLNE','AMRC','HASI','MAXN','SPWR',
    'PRPL','CATO','GIII','XPOF','PTGX','BOWL','COOK','RENT','LOVE','CURV',
  ];

  try {
    const today = new Date();
    const from35 = new Date(today); from35.setDate(from35.getDate() - 35);
    const from5  = new Date(today); from5.setDate(from5.getDate() - 5);
    const toStr   = today.toISOString().split('T')[0];
    const from35S = from35.toISOString().split('T')[0];
    const from5S  = from5.toISOString().split('T')[0];

    // Load learning scores from KV
    let scores = {};
    if (KV_URL && KV_TOK) {
      try {
        const r = await fetch(`${KV_URL}/get/pet_scores`, { headers: { Authorization: `Bearer ${KV_TOK}` } });
        const d = await r.json();
        if (d.result) scores = JSON.parse(d.result);
      } catch(e) {}
    }

    // SPY + VIX
    const [spyR, vixR] = await Promise.all([
      fetch(`https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${from35S}/${toStr}?adjusted=true&sort=desc&limit=25&apiKey=${POLY}`).then(r=>r.json()),
      fetch(`https://api.polygon.io/v2/aggs/ticker/I:VIX/range/1/day/${from35S}/${toStr}?adjusted=true&sort=desc&limit=2&apiKey=${POLY}`).then(r=>r.json()).catch(()=>({results:[]})),
    ]);
    const spyBars  = spyR.results || [];
    const spyPrice = spyBars[0]?.c || 500;
    const spy20    = spyBars.slice(0,20).reduce((s,b)=>s+b.c,0) / Math.min(20, spyBars.length);
    const spyTrend = spyPrice > spy20 ? 'BULLISH' : 'BEARISH';
    const spyChg   = spyBars[0] ? (((spyBars[0].c - spyBars[0].o) / spyBars[0].o)*100).toFixed(2) : '0';
    const vix      = vixR.results?.[0]?.c || 18;

    // STAGE 1 — fast 5-day screen on all 90
    const s1 = await Promise.allSettled(
      ALL.map(sym =>
        fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${from5S}/${toStr}?adjusted=true&sort=desc&limit=5&apiKey=${POLY}`)
          .then(r=>r.json()).then(d=>({ sym, bars: d.results||[] })).catch(()=>({ sym, bars:[] }))
      )
    );

    const s1passed = [];
    for (const r of s1) {
      if (r.status !== 'fulfilled') continue;
      const { sym, bars } = r.value;
      if (!bars || bars.length < 2) continue;
      const price = bars[0]?.c;
      if (!price || price < 5 || price > 120) continue;
      const sc = scores[sym];
      if (sc && (sc.rating === 'COLD' || sc.rating === 'AVOID') && sc.trades >= 5) continue;
      const hi = Math.max(...bars.map(b=>b.h||0));
      const lo = Math.min(...bars.map(b=>b.l||9999));
      const range = lo > 0 ? (hi - lo) / lo : 0;
      if (range < 0.015) continue;
      const hotBoost = sc?.rating === 'HOT' ? 2 : sc?.rating === 'WARM' ? 1 : 0;
      s1passed.push({ sym, price, range, hotBoost, score: sc || null });
    }
    s1passed.sort((a,b) => (b.hotBoost - a.hotBoost) || (b.range - a.range));
    const s1top = s1passed.slice(0, 25).map(t => t.sym);

    // STAGE 2 — deep 35-day analysis on survivors
    const s2 = await Promise.allSettled(
      s1top.map(sym =>
        fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${from35S}/${toStr}?adjusted=true&sort=desc&limit=25&apiKey=${POLY}`)
          .then(r=>r.json()).then(d=>({ sym, bars: d.results||[] })).catch(()=>({ sym, bars:[] }))
      )
    );

    const passed = [];
    for (const r of s2) {
      if (r.status !== 'fulfilled') continue;
      const { sym, bars } = r.value;
      if (!bars || bars.length < 10) continue;
      const price  = bars[0]?.c;
      if (!price || price < 5 || price > 120) continue;
      const avgVol = bars.slice(1,21).reduce((s,b)=>s+(b.v||0),0) / 20;
      const todVol = bars[0]?.v || 0;
      const volMult = avgVol > 0 ? todVol / avgVol : 0;
      if (volMult < 1.2) continue;
      const ma10   = bars.slice(0,10).reduce((s,b)=>s+b.c,0) / Math.min(10, bars.length);
      const ma20   = bars.slice(0,20).reduce((s,b)=>s+b.c,0) / Math.min(20, bars.length);
      const weekChg  = bars[4]?.c  ? (((price-bars[4].c)/bars[4].c)*100).toFixed(1)  : '0';
      const monthChg = bars[19]?.c ? (((price-bars[19].c)/bars[19].c)*100).toFixed(1) : '0';
      const sc = scores[sym] || null;
      const sortScore = (sc?.rating==='HOT'?3:sc?.rating==='WARM'?1:0) + parseFloat(volMult.toFixed(1));
      passed.push({ sym, price: price.toFixed(2), volMult: volMult.toFixed(1), ma10: ma10.toFixed(2), ma20: ma20.toFixed(2), weekChg, monthChg, aboveMa10: price>ma10, aboveMa20: price>ma20, score: sc, sortScore });
    }
    passed.sort((a,b) => b.sortScore - a.sortScore);
    const top = passed.slice(0, 12);

    if (!top.length) {
      return res.status(200).json({
        spyTrend, spyPrice: spyPrice.toFixed(2), spyChg, spy20: spy20.toFixed(2), vix: vix.toFixed(1),
        tickers_scanned: ALL.length, stage1_passed: s1passed.length, stage2_passed: 0,
        picks: [], market_summary: `Scanned ${ALL.length} tickers — no setups passed filters today. Market may be in consolidation.`,
        timestamp: new Date().toISOString()
      });
    }

    // Build learning context
    const hotList  = Object.entries(scores).filter(([,s])=>s.rating==='HOT').map(([sym])=>sym);
    const coldList = Object.entries(scores).filter(([,s])=>s.rating==='COLD'||s.rating==='AVOID').map(([sym])=>sym);
    const hasScores = Object.keys(scores).length > 0;

    const dateStr = new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    const prompt = `Today is ${dateStr}. SPY: ${spyTrend} at $${spyPrice.toFixed(2)} vs 20MA $${spy20.toFixed(2)}. VIX: ${vix.toFixed(1)}.

${hasScores ? `LEARNING SYSTEM (from real past trades):
HOT tickers — proven winners, prioritize: ${hotList.join(', ')||'none yet'}
COLD tickers — poor performers, skip: ${coldList.join(', ')||'none yet'}
` : 'No historical data yet — treat all tickers equally.'}

Scanned ${ALL.length} tickers. These ${top.length} passed all filters:
${JSON.stringify(top, null, 2)}

You are Plain English Trading — an options coach for beginners. Find the 4-6 best trades.

RULES:
1. Only ${spyTrend==='BULLISH'?'CALLS':'PUTS'} — market is ${spyTrend}
2. Strike: nearest OTM
3. Expiry: 30-45 days out
4. Favor HOT tickers. Skip COLD.
5. Plain English — no jargon

Return ONLY raw JSON (no markdown):
{
  "market_summary": "one plain English sentence on today",
  "play_type": "${spyTrend==='BULLISH'?'CALLS — betting stocks go UP':'PUTS — betting stocks go DOWN'}",
  "top_pick": "TICKER",
  "picks": [
    {
      "sym": "TICKER",
      "name": "Full Name",
      "sector": "Energy",
      "price": "42.10",
      "verdict": "BUY",
      "confidence": "HIGH",
      "historical_rating": "HOT",
      "type": "CALL",
      "strike": 45,
      "expiry": "May 16 2026",
      "days_to_expiry": 41,
      "est_premium": 1.80,
      "cost_per_contract": 180,
      "sell_at_premium": 3.60,
      "stop_at_premium": 0.90,
      "stock_target": 48,
      "stock_stop": 40,
      "vol_spike": "2.4x",
      "risk_score": 45,
      "what_to_do": "Buy 1 contract of TICKER $45 Call expiring May 16. Pay ~$1.80 per contract. Sell when premium hits $3.60. Exit if premium drops to $0.90.",
      "why": "Two plain English sentences. What is the catalyst? Why will it move?",
      "green_flags": ["flag 1","flag 2","flag 3"],
      "red_flags": ["warning 1","warning 2"]
    }
  ]
}`;

    const cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2500, system: 'Plain English Trading options coach. Respond ONLY with raw JSON.', messages: [{ role: 'user', content: prompt }] })
    });
    const cj = await cr.json();
    const raw = (cj.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const clean = raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    let analysis;
    try { analysis = JSON.parse(clean); }
    catch(e) { const m = clean.match(/\{[\s\S]*\}/); analysis = m ? JSON.parse(m[0]) : { picks:[], market_summary:'Parse error', top_pick:'' }; }

    return res.status(200).json({
      spyTrend, spyPrice: spyPrice.toFixed(2), spyChg, spy20: spy20.toFixed(2), vix: vix.toFixed(1),
      tickers_scanned: ALL.length, stage1_passed: s1passed.length, stage2_passed: passed.length,
      ...analysis,
      timestamp: new Date().toISOString()
    });

  } catch(err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
