// outcomes.js — Trade outcome storage and ticker scoring engine
// Uses Vercel KV (free tier) to persist outcomes across sessions

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  // If no KV configured — use in-memory fallback with clear message
  const hasKV = KV_URL && KV_TOKEN;

  const { action, trade } = req.body || {};

  // ── KV HELPERS ────────────────────────────────────────────────────────────
  async function kvGet(key) {
    if (!hasKV) return null;
    try {
      const r = await fetch(`${KV_URL}/get/${key}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` }
      });
      const d = await r.json();
      return d.result ? JSON.parse(d.result) : null;
    } catch(e) { return null; }
  }

  async function kvSet(key, value) {
    if (!hasKV) return false;
    try {
      await fetch(`${KV_URL}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify(value) })
      });
      return true;
    } catch(e) { return false; }
  }

  // ── LOG A TRADE OUTCOME ───────────────────────────────────────────────────
  if (action === 'log' && trade) {
    const { sym, type, strike, expiry, entry_date, exit_date, outcome, pnl_pct, market_trend, spy_price } = trade;

    if (!sym || !outcome) {
      return res.status(400).json({ error: 'sym and outcome required' });
    }

    // Load existing outcomes
    let allOutcomes = await kvGet('pet_outcomes') || [];

    const record = {
      id: Date.now(),
      sym: sym.toUpperCase(),
      type, strike, expiry,
      entry_date: entry_date || new Date().toISOString().split('T')[0],
      exit_date: exit_date || new Date().toISOString().split('T')[0],
      outcome, // WIN, LOSS, EXPIRED
      pnl_pct: parseFloat(pnl_pct) || 0,
      market_trend: market_trend || 'UNKNOWN',
      spy_price: parseFloat(spy_price) || 0,
      month: (entry_date || new Date().toISOString()).slice(0, 7),
    };

    allOutcomes.push(record);

    // Keep last 500 outcomes
    if (allOutcomes.length > 500) allOutcomes = allOutcomes.slice(-500);

    await kvSet('pet_outcomes', allOutcomes);

    // Recalculate and store ticker scores
    const scores = calculateScores(allOutcomes);
    await kvSet('pet_scores', scores);

    return res.status(200).json({ success: true, record, scores });
  }

  // ── GET SCORES AND STATS ──────────────────────────────────────────────────
  if (action === 'scores' || req.method === 'GET') {
    const allOutcomes = await kvGet('pet_outcomes') || [];
    const scores = calculateScores(allOutcomes);

    // Market regime analysis
    const recentOutcomes = allOutcomes.slice(-30);
    const recentWinRate = recentOutcomes.length > 0
      ? (recentOutcomes.filter(o => o.outcome === 'WIN').length / recentOutcomes.length * 100).toFixed(1)
      : null;

    // Monthly performance
    const byMonth = {};
    allOutcomes.forEach(o => {
      if (!byMonth[o.month]) byMonth[o.month] = { trades: 0, wins: 0 };
      byMonth[o.month].trades++;
      if (o.outcome === 'WIN') byMonth[o.month].wins++;
    });

    const monthlyStats = Object.entries(byMonth)
      .map(([month, d]) => ({
        month,
        trades: d.trades,
        wins: d.wins,
        win_rate: ((d.wins / d.trades) * 100).toFixed(1)
      }))
      .sort((a, b) => b.month.localeCompare(a.month))
      .slice(0, 6);

    // Best and worst conditions
    const bullOutcomes = allOutcomes.filter(o => o.market_trend === 'BULLISH');
    const bearOutcomes = allOutcomes.filter(o => o.market_trend === 'BEARISH');
    const bullWR = bullOutcomes.length > 0
      ? (bullOutcomes.filter(o => o.outcome === 'WIN').length / bullOutcomes.length * 100).toFixed(1)
      : null;
    const bearWR = bearOutcomes.length > 0
      ? (bearOutcomes.filter(o => o.outcome === 'WIN').length / bearOutcomes.length * 100).toFixed(1)
      : null;

    return res.status(200).json({
      has_kv: hasKV,
      total_outcomes: allOutcomes.length,
      overall_win_rate: allOutcomes.length > 0
        ? (allOutcomes.filter(o => o.outcome === 'WIN').length / allOutcomes.length * 100).toFixed(1)
        : null,
      recent_win_rate: recentWinRate,
      ticker_scores: scores,
      monthly_performance: monthlyStats,
      market_conditions: { bullish_win_rate: bullWR, bearish_win_rate: bearWR },
      recent_outcomes: allOutcomes.slice(-10).reverse(),
      kv_status: hasKV ? 'connected' : 'not_configured',
      kv_message: hasKV ? null : 'Add KV_REST_API_URL and KV_REST_API_TOKEN in Vercel to persist outcomes. See setup instructions.',
      timestamp: new Date().toISOString()
    });
  }

  // ── DELETE AN OUTCOME ─────────────────────────────────────────────────────
  if (action === 'delete') {
    const { id } = req.body || {};
    let allOutcomes = await kvGet('pet_outcomes') || [];
    allOutcomes = allOutcomes.filter(o => o.id !== id);
    await kvSet('pet_outcomes', allOutcomes);
    const scores = calculateScores(allOutcomes);
    await kvSet('pet_scores', scores);
    return res.status(200).json({ success: true, remaining: allOutcomes.length });
  }

  return res.status(400).json({ error: 'Invalid action' });
}

// ── SCORING ENGINE ────────────────────────────────────────────────────────────
function calculateScores(outcomes) {
  if (!outcomes.length) return {};

  const byTicker = {};
  outcomes.forEach(o => {
    if (!byTicker[o.sym]) byTicker[o.sym] = { trades: 0, wins: 0, losses: 0, totalPnl: 0, recent: [] };
    byTicker[o.sym].trades++;
    if (o.outcome === 'WIN') byTicker[o.sym].wins++;
    else byTicker[o.sym].losses++;
    byTicker[o.sym].totalPnl += o.pnl_pct || 0;
    byTicker[o.sym].recent.push({ outcome: o.outcome, date: o.entry_date });
  });

  const scores = {};
  Object.entries(byTicker).forEach(([sym, d]) => {
    const winRate = d.trades > 0 ? (d.wins / d.trades) : 0.5;

    // Recent form — last 5 trades weighted more
    const recentTrades = d.recent.slice(-5);
    const recentWins = recentTrades.filter(t => t.outcome === 'WIN').length;
    const recentWR = recentTrades.length > 0 ? recentWins / recentTrades.length : 0.5;

    // Confidence based on sample size
    const confidence = Math.min(1, d.trades / 10);

    // Composite score: 60% overall win rate, 40% recent form
    const rawScore = (winRate * 0.6 + recentWR * 0.4);

    // Adjusted score weighted by confidence (small samples pulled toward 0.5)
    const adjustedScore = rawScore * confidence + 0.5 * (1 - confidence);

    // Rating
    let rating = 'NEUTRAL';
    let multiplier = 1.0;
    if (d.trades >= 3) {
      if (adjustedScore >= 0.55) { rating = 'HOT'; multiplier = 1.3; }
      else if (adjustedScore >= 0.50) { rating = 'WARM'; multiplier = 1.1; }
      else if (adjustedScore <= 0.35) { rating = 'COLD'; multiplier = 0.5; }
      else if (adjustedScore <= 0.45) { rating = 'AVOID'; multiplier = 0.7; }
    }

    scores[sym] = {
      sym,
      trades: d.trades,
      wins: d.wins,
      losses: d.losses,
      win_rate: (winRate * 100).toFixed(1),
      recent_win_rate: (recentWR * 100).toFixed(1),
      total_pnl: d.totalPnl.toFixed(1),
      adjusted_score: (adjustedScore * 100).toFixed(1),
      rating,
      confidence_pct: (confidence * 100).toFixed(0),
      multiplier,
    };
  });

  return scores;
}
