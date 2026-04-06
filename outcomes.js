// api/outcomes.js — Learning system. Stores outcomes, scores tickers, improves scan.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOK = process.env.KV_REST_API_TOKEN;
  const hasKV  = !!(KV_URL && KV_TOK);

  async function kvGet(key) {
    if (!hasKV) return null;
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOK}` } });
      const d = await r.json();
      return d.result ? JSON.parse(d.result) : null;
    } catch(e) { return null; }
  }

  async function kvSet(key, value) {
    if (!hasKV) return false;
    try {
      await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify(value) })
      });
      return true;
    } catch(e) { return false; }
  }

  function scoreTickets(outcomes) {
    const byTicker = {};
    for (const o of outcomes) {
      if (!byTicker[o.sym]) byTicker[o.sym] = { trades: 0, wins: 0, losses: 0, pnl: 0, recent: [] };
      byTicker[o.sym].trades++;
      if (o.outcome === 'WIN') byTicker[o.sym].wins++;
      else byTicker[o.sym].losses++;
      byTicker[o.sym].pnl += o.pnl_pct || 0;
      byTicker[o.sym].recent.push(o.outcome);
    }
    const scores = {};
    for (const [sym, d] of Object.entries(byTicker)) {
      const wr = d.trades > 0 ? d.wins / d.trades : 0.5;
      const recent5 = d.recent.slice(-5);
      const recentWR = recent5.length > 0 ? recent5.filter(o=>o==='WIN').length / recent5.length : 0.5;
      const conf = Math.min(1, d.trades / 10);
      const raw  = wr * 0.6 + recentWR * 0.4;
      const adj  = raw * conf + 0.5 * (1 - conf);
      let rating = 'NEUTRAL', mult = 1.0;
      if (d.trades >= 3) {
        if (adj >= 0.58)      { rating = 'HOT';   mult = 1.4; }
        else if (adj >= 0.52) { rating = 'WARM';  mult = 1.2; }
        else if (adj <= 0.35) { rating = 'AVOID'; mult = 0.4; }
        else if (adj <= 0.42) { rating = 'COLD';  mult = 0.7; }
      }
      scores[sym] = { sym, trades: d.trades, wins: d.wins, losses: d.losses, win_rate: (wr*100).toFixed(1), recent_win_rate: (recentWR*100).toFixed(1), total_pnl: d.pnl.toFixed(1), rating, multiplier: mult, confidence: (conf*100).toFixed(0) };
    }
    return scores;
  }

  const body = req.body || {};
  const { action } = body;

  if (action === 'log') {
    const { sym, type, outcome, entry_date, exit_date, pnl_pct, market_trend } = body.trade || {};
    if (!sym || !outcome) return res.status(400).json({ error: 'sym and outcome required' });
    let outcomes = await kvGet('pet_outcomes') || [];
    const record = { id: Date.now(), sym: sym.toUpperCase(), type, outcome, entry_date: entry_date||new Date().toISOString().split('T')[0], exit_date: exit_date||new Date().toISOString().split('T')[0], pnl_pct: parseFloat(pnl_pct)||0, market_trend: market_trend||'UNKNOWN', month: (entry_date||new Date().toISOString()).slice(0,7) };
    outcomes.push(record);
    if (outcomes.length > 500) outcomes = outcomes.slice(-500);
    await kvSet('pet_outcomes', outcomes);
    const scores = scoreTickets(outcomes);
    await kvSet('pet_scores', scores);
    return res.status(200).json({ success: true, record, total_outcomes: outcomes.length, scores });
  }

  if (action === 'delete') {
    let outcomes = await kvGet('pet_outcomes') || [];
    outcomes = outcomes.filter(o => o.id !== body.id);
    await kvSet('pet_outcomes', outcomes);
    const scores = scoreTickets(outcomes);
    await kvSet('pet_scores', scores);
    return res.status(200).json({ success: true, remaining: outcomes.length });
  }

  // Default: get scores and stats
  const outcomes = await kvGet('pet_outcomes') || [];
  const scores   = scoreTickets(outcomes);

  const totalWins = outcomes.filter(o=>o.outcome==='WIN').length;
  const overallWR = outcomes.length > 0 ? ((totalWins/outcomes.length)*100).toFixed(1) : null;
  const recent30  = outcomes.slice(-30);
  const recentWR  = recent30.length > 0 ? ((recent30.filter(o=>o.outcome==='WIN').length/recent30.length)*100).toFixed(1) : null;

  const byMonth = {};
  for (const o of outcomes) {
    if (!byMonth[o.month]) byMonth[o.month] = { trades:0, wins:0 };
    byMonth[o.month].trades++;
    if (o.outcome==='WIN') byMonth[o.month].wins++;
  }

  const bullish = outcomes.filter(o=>o.market_trend==='BULLISH');
  const bearish = outcomes.filter(o=>o.market_trend==='BEARISH');

  return res.status(200).json({
    has_kv: hasKV,
    kv_message: hasKV ? null : 'Add KV_REST_API_URL and KV_REST_API_TOKEN in Vercel → Storage → KV to persist learning across sessions.',
    total_outcomes: outcomes.length,
    overall_win_rate: overallWR,
    recent_win_rate: recentWR,
    ticker_scores: scores,
    market_conditions: {
      bullish_win_rate: bullish.length > 0 ? ((bullish.filter(o=>o.outcome==='WIN').length/bullish.length)*100).toFixed(1) : null,
      bearish_win_rate: bearish.length > 0 ? ((bearish.filter(o=>o.outcome==='WIN').length/bearish.length)*100).toFixed(1) : null,
    },
    monthly_performance: Object.entries(byMonth).map(([month,d])=>({ month, trades:d.trades, wins:d.wins, win_rate:((d.wins/d.trades)*100).toFixed(1) })).sort((a,b)=>b.month.localeCompare(a.month)).slice(0,6),
    recent_outcomes: outcomes.slice(-10).reverse(),
    timestamp: new Date().toISOString(),
  });
}
