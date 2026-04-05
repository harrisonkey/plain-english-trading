// api/scan.js — Two-stage scanner covering 90 small cap tickers
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLY = process.env.POLYGON_API_KEY;
  const CLAUDE = process.env.ANTHROPIC_API_KEY;
  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  if (!POLY || !CLAUDE) return res.status(500).json({ error: 'Missing API keys.' });

  try {
    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate() - 35);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = today.toISOString().split('T')[0];
    const from5 = new Date(today); from5.setDate(from5.getDate() - 5);
    const from5Str = from5.toISOString().split('T')[0];

    // ── LOAD LEARNING SCORES ───────────────────────────────────────────────
    let tickerScores = {};
    if (KV_URL && KV_TOKEN) {
      try {
        const r = await fetch(`${KV_URL}/get/pet_scores`, {
          headers: { Authorization: `Bearer ${KV_TOKEN}` }
        });
        const d = await r.json();
        if (d.result) tickerScores = JSON.parse(d.result);
      } catch(e) {}
    }

    // ── SPY + VIX ──────────────────────────────────────────────────────────
    const [spyR, vixR] = await Promise.all([
      fetch(`https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=25&apiKey=${POLY}`).then(r=>r.json()),
      fetch(`https://api.polygon.io/v2/aggs/ticker/I:VIX/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=2&apiKey=${POLY}`).then(r=>r.json()),
    ]);
    const spyBars = spyR.results || [];
    const spyPrice = spyBars[0]?.c || 500;
    const spy20 = spyBars.slice(0,20).reduce((s,b)=>s+b.c,0)/Math.min(20,spyBars.length);
    const spyTrend = spyPrice > spy20 ? 'BULLISH' : 'BEARISH';
    const spyChg = spyBars[0] ? (((spyBars[0].c-spyBars[0].o)/spyBars[0].o)*100).toFixed(2) : '0';
    const vix = vixR.results?.[0]?.c || 18;

    // ── 90 SMALL CAP TICKERS — diverse sectors ─────────────────────────────
    const ALL_TICKERS = [
      // Energy (oil, gas, E&P)
      'OXY','MRO','CIVI','MTDR','CHRD','SM','GPOR','VTLE','MNRL','BATL',
      // Defense & aerospace
      'KTOS','AVAV','RCAT','ASTS','LUNR','JOBY','ACHR','BYRN','RKLB','SPCE',
      // Small tech & AI
      'SOUN','IONQ','BTDR','BBAI','CXAI','MIND','REAX','PRCT','VZIO','AMBA',
      // Biotech & pharma
      'ARDX','PRAX','VKTX','RXRX','BEAM','IMVT','ARQT','NRIX','TGTX','CRSP',
      // Materials & mining
      'MP','UUUU','NXE','LAC','LITM','WOLF','GATO','USAS','CDE','HL',
      // Financials & mortgage
      'UWMC','RKT','PFSI','COOP','GHLD','OPFI','LPRO','ATLC','ENVA','PRAA',
      // Tech hardware & semis
      'SMCI','AEHR','FORM','VICR','DIOD','AOSL','SITM','SWKS','ALGM','AAOI',
      // Clean energy
      'ARRY','SHLS','STEM','NOVA','FLUX','CLNE','AMRC','HASI','MAXN','SPWR',
      // Consumer & retail
      'PRPL','CATO','GIII','XPOF','PTGX','BOWL','COOK','RENT','LOVE','CURV',
    ];

    // ── STAGE 1: FAST SCREEN — last 5 days only (lightweight) ─────────────
    // Fetch just recent bars for all 90 tickers simultaneously
    const stage1Results = await Promise.allSettled(
      ALL_TICKERS.map(sym =>
        fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${from5Str}/${toStr}?adjusted=true&sort=desc&limit=5&apiKey=${POLY}`)
          .then(r => r.json())
          .then(d => ({ sym, bars: d.results || [] }))
          .catch(() => ({ sym, bars: [] }))
      )
    );

    // Quick filter: price range + any recent activity
    const stage1Passed = [];
    for (const r of stage1Results) {
      if (r.status !== 'fulfilled') continue;
      const { sym, bars } = r.value;
      if (!bars || bars.length < 2) continue;
      const price = bars[0]?.c;
      if (!price || price < 5 || price > 100) continue;

      // Check if COLD ticker — skip immediately
      const score = tickerScores[sym];
      if (score && (score.rating === 'COLD' || score.rating === 'AVOID') && score.trades >= 5) continue;

      // Basic momentum check on recent bars
      const recentHigh = Math.max(...bars.map(b => b.h || 0));
      const recentLow = Math.min(...bars.map(b => b.l || Infinity));
      const recentRange = recentHigh > 0 ? (recentHigh - recentLow) / recentLow : 0;

      // Only pass if some recent movement (>2% range in last 5 days)
      if (recentRange < 0.02) continue;

      stage1Passed.push({ sym, price, recentRange, score });
    }

    // Sort stage 1 by: HOT tickers first, then by recent range
    stage1Passed.sort((a, b) => {
      const aHot = a.score?.rating === 'HOT' ? 1 : 0;
      const bHot = b.score?.rating === 'HOT' ? 1 : 0;
      if (aHot !== bHot) return bHot - aHot;
      return b.recentRange - a.recentRange;
    });

    // Take top 25 for deep analysis
    const stage1Top = stage1Passed.slice(0, 25).map(t => t.sym);

    // ── STAGE 2: DEEP ANALYSIS — full 35-day history on survivors ─────────
    const stage2Results = await Promise.allSettled(
      stage1Top.map(sym =>
        fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=25&apiKey=${POLY}`)
          .then(r => r.json())
          .then(d => ({ sym, bars: d.results || [] }))
          .catch(() => ({ sym, bars: [] }))
      )
    );

    // Apply full hard filters
    const passed = [];
    for (const r of stage2Results) {
      if (r.status !== 'fulfilled') continue;
      const { sym, bars } = r.value;
      if (!bars || bars.length < 10) continue;
      const price = bars[0]?.c;
      if (!price || price < 5 || price > 100) continue;

      const avgVol = bars.slice(1, 21).reduce((s, b) => s + (b.v || 0), 0) / 20;
      const todayVol = bars[0]?.v || 0;
      const volMult = avgVol > 0 ? todayVol / avgVol : 0;
      if (volMult < 1.2) continue; // Slightly relaxed from 1.5 to catch more signals

      const ma10 = bars.slice(0, 10).reduce((s, b) => s + b.c, 0) / Math.min(10, bars.length);
      const ma20 = bars.slice(0, 20).reduce((s, b) => s + b.c, 0) / Math.min(20, bars.length);
      const weekChg = bars[4]?.c ? (((price - bars[4].c) / bars[4].c) * 100).toFixed(1) : '0';
      const monthChg = bars[19]?.c ? (((price - bars[19].c) / bars[19].c) * 100).toFixed(1) : '0';
      const score = tickerScores[sym] || null;

      passed.push({
        sym, price: price.toFixed(2),
        volMult: volMult.toFixed(1),
        ma10: ma10.toFixed(2), ma20: ma20.toFixed(2),
        weekChg, monthChg,
        aboveMa10: price > ma10, aboveMa20: price > ma20,
        score,
        // HOT tickers get boosted sort priority
        sortScore: (score?.rating === 'HOT' ? 3 : score?.rating === 'WARM' ? 1 : 0) + parseFloat(volMult.toFixed(1)),
      });
    }

    // Sort: HOT tickers first, then by volume spike
    passed.sort((a, b) => b.sortScore - a.sortScore);
    const top = passed.slice(0, 12);

    if (!top.length) {
      return res.status(200).json({
        spyTrend, spyPrice: spyPrice.toFixed(2), spyChg, vix: vix.toFixed(1),
        picks: [], market_summary: 'No setups found today across 90 tickers. Market may be in low-volume consolidation.',
        tickers_scanned: ALL_TICKERS.length, stage1_passed: stage1Passed.length, stage2_passed: 0,
        timestamp: new Date().toISOString()
      });
    }

    // ── CLAUDE ANALYSIS ────────────────────────────────────────────────────
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const hasScores = Object.keys(tickerScores).length > 0;
    const hotTickers = Object.entries(tickerScores).filter(([, s]) => s.rating === 'HOT').map(([sym]) => sym);
    const coldTickers = Object.entries(tickerScores).filter(([, s]) => s.rating === 'COLD' || s.rating === 'AVOID').map(([sym]) => sym);

    const prompt = `Today is ${dateStr}. Market: SPY ${spyTrend} at $${spyPrice.toFixed(2)} vs 20MA $${spy20.toFixed(2)}. VIX: ${vix.toFixed(1)}.

${hasScores ? `LEARNING SYSTEM — Real historical performance:
HOT tickers (proven winners — prioritize): ${hotTickers.join(', ') || 'none yet'}
COLD tickers (poor performers — skip unless exceptional): ${coldTickers.join(', ') || 'none yet'}
Scores: ${JSON.stringify(Object.fromEntries(Object.entries(tickerScores).map(([k, v]) => [k, { wr: v.win_rate, rating: v.rating, trades: v.trades }])))}
` : 'No historical data yet — treat all equally.'}

Scanned ${ALL_TICKERS.length} tickers. These ${top.length} passed all filters:
${JSON.stringify(top, null, 2)}

You are Plain English Trading. Find the best 4-6 options trades. Favor HOT tickers. Skip COLD ones.

HARD RULES:
1. Only ${spyTrend === 'BULLISH' ? 'CALLS' : 'PUTS'} — market is ${spyTrend}
2. Strike: nearest OTM
3. Expiry: 30-45 days from today
4. HOT tickers = HIGH confidence. COLD = skip.
5. Plain English explanations — no jargon

Return ONLY raw JSON:
{
  "market_summary": "One plain English sentence on today's market + learning system insight",
  "play_type": "${spyTrend === 'BULLISH' ? 'CALLS — betting stocks go UP' : 'PUTS — betting stocks go DOWN'}",
  "top_pick": "TICKER",
  "learning_insight": "${hasScores ? 'What historical data says about todays picks' : 'Building track record — no data yet'}",
  "picks": [
    {
      "sym": "TICKER",
      "name": "Full Company Name",
      "sector": "Energy",
      "price": "42.10",
      "verdict": "BUY",
      "confidence": "HIGH",
      "historical_rating": "HOT",
      "historical_win_rate": "52.6%",
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
      "confidence_reason": "Why this is high confidence — mention historical win rate if HOT",
      "what_to_do": "Buy X contract of TICKER $Y Call expiring Date. Pay around $Z. Sell at $XX. Exit if drops to $XX.",
      "why_plain_english": "Two sentences. Why will this move? What is the catalyst or pattern?",
      "green_flags": ["flag 1", "flag 2", "flag 3"],
      "red_flags": ["warning 1", "warning 2"],
      "skip": false,
      "skip_reason": null
    }
  ]
}`;

    const cRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 2000,
        system: 'You are Plain English Trading — beginner-friendly options coach. Respond ONLY with raw JSON.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const cData = await cRes.json();
    const raw = (cData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let analysis;
    try { analysis = JSON.parse(clean); }
    catch(e) { const m = clean.match(/\{[\s\S]*\}/); analysis = m ? JSON.parse(m[0]) : { picks: [], market_summary: 'Parse error — try again', top_pick: '' }; }

    return res.status(200).json({
      spyTrend, spyPrice: spyPrice.toFixed(2), spyChg, spy20: spy20.toFixed(2), vix: vix.toFixed(1),
      tickers_scanned: ALL_TICKERS.length,
      stage1_passed: stage1Passed.length,
      stage2_passed: passed.length,
      ...analysis,
      timestamp: new Date().toISOString()
    });

  } catch(err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
