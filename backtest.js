// backtest.js — Clean rebuild v2. No regime filter. No volume filter. Pure MA signal.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLY = process.env.POLYGON_API_KEY;
  const CLAUDE = process.env.ANTHROPIC_API_KEY;
  if (!POLY || !CLAUDE) return res.status(500).json({ error: 'Missing API keys' });

  const body = req.body || {};
  const monthsBack = Math.min(12, Math.max(1, parseInt(body.months || 6)));

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setMonth(fromDate.getMonth() - monthsBack);
  const fromStr = fromDate.toISOString().split('T')[0];
  const toStr = toDate.toISOString().split('T')[0];

  // 25 best small caps — active options, good liquidity, proven movers
  const TICKERS = [
    'RKLB','IONQ','SOUN','ASTS','LUNR',   // Space/tech — high momentum
    'KTOS','AVAV','RCAT','ACHR','JOBY',   // Defense/aerospace
    'OXY','MRO','CIVI','MTDR','CHRD',     // Energy — directional movers
    'ARDX','PRAX','VKTX','BEAM','CRSP',   // Biotech — high vol
    'MP','UUUU','UWMC','RKT','SMCI',      // Mixed — active options
  ];

  try {
    // Fetch SPY for trend
    const spyRes = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=500&apiKey=${POLY}`
    );
    const spyJson = await spyRes.json();
    const spyBars = spyJson.results || [];

    // Build SPY trend lookup by date
    const spyTrendByDate = {};
    spyBars.forEach((bar, i) => {
      const date = new Date(bar.t).toISOString().split('T')[0];
      const window = spyBars.slice(Math.max(0, i - 19), i + 1);
      const ma20 = window.reduce((s, b) => s + b.c, 0) / window.length;
      spyTrendByDate[date] = bar.c > ma20 ? 'BULLISH' : 'BEARISH';
    });

    // Fetch all tickers in parallel
    const fetched = await Promise.allSettled(
      TICKERS.map(sym =>
        fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=500&apiKey=${POLY}`)
          .then(r => r.json())
          .then(d => ({ sym, bars: d.results || [] }))
          .catch(() => ({ sym, bars: [] }))
      )
    );

    const allTrades = [];
    const tickerStats = {};

    for (const result of fetched) {
      if (result.status !== 'fulfilled') continue;
      const { sym, bars } = result.value;
      if (!bars || bars.length < 25) continue;

      tickerStats[sym] = { trades: 0, wins: 0, losses: 0, pnl: 0 };

      // Walk every 3rd bar starting from day 22 (need 20-day MA history)
      // Stop 40 bars from end (need future bars for outcome)
      for (let i = 22; i < bars.length - 40; i += 3) {
        const bar = bars[i];
        const price = bar.c;

        // Price gate — options need to be liquid
        if (!price || price < 3 || price > 150) continue;

        // Moving averages
        const ma10 = bars.slice(i - 10, i).reduce((s, b) => s + b.c, 0) / 10;
        const ma20 = bars.slice(i - 20, i).reduce((s, b) => s + b.c, 0) / 20;

        // Momentum — need clear trend
        const bullish = price > ma10 && ma10 > ma20;
        const bearish = price < ma10 && ma10 < ma20;
        if (!bullish && !bearish) continue;

        // SPY trend gate
        const date = new Date(bar.t).toISOString().split('T')[0];
        const spyTrend = spyTrendByDate[date] || 'BULLISH';

        // Only take trades aligned with both stock AND market direction
        const type = spyTrend === 'BULLISH' && bullish ? 'CALL'
                   : spyTrend === 'BEARISH' && bearish ? 'PUT'
                   : null;
        if (!type) continue;

        // Nearest OTM strike
        const strike = type === 'CALL'
          ? Math.ceil(price / 5) * 5
          : Math.floor(price / 5) * 5;

        // Target: 12% stock move = ~100% option gain
        // Stop: 6% against = ~50% option loss
        const target = type === 'CALL' ? price * 1.12 : price * 0.88;
        const stop   = type === 'CALL' ? price * 0.94 : price * 1.06;

        // Simulate next 37 trading days
        const futureBars = bars.slice(i + 1, i + 38);
        let outcome = 'EXPIRED';
        let pnl = -100; // expired worthless by default

        for (const fb of futureBars) {
          if (type === 'CALL') {
            if (fb.h >= target) { outcome = 'WIN';  pnl = 100; break; }
            if (fb.l <= stop)   { outcome = 'LOSS'; pnl = -50; break; }
          } else {
            if (fb.l <= target) { outcome = 'WIN';  pnl = 100; break; }
            if (fb.h >= stop)   { outcome = 'LOSS'; pnl = -50; break; }
          }
        }

        // If expired — check if barely in the money
        if (outcome === 'EXPIRED' && futureBars.length > 0) {
          const last = futureBars[futureBars.length - 1].c;
          const itm = type === 'CALL' ? last > strike : last < strike;
          if (itm) { outcome = 'PARTIAL'; pnl = 15; }
        }

        // Record
        tickerStats[sym].trades++;
        if (outcome === 'WIN')     { tickerStats[sym].wins++; tickerStats[sym].pnl += 100; }
        else if (outcome === 'LOSS')    { tickerStats[sym].losses++; tickerStats[sym].pnl -= 50; }
        else if (outcome === 'PARTIAL') { tickerStats[sym].pnl += 15; }
        else                            { tickerStats[sym].losses++; tickerStats[sym].pnl -= 100; }

        allTrades.push({ sym, date, price: price.toFixed(2), type, strike, outcome, pnl });
      }
    }

    // Sort by date
    allTrades.sort((a, b) => a.date.localeCompare(b.date));

    // Summary stats
    const total  = allTrades.length;
    const wins   = allTrades.filter(t => t.outcome === 'WIN').length;
    const losses = allTrades.filter(t => t.outcome === 'LOSS' || t.outcome === 'EXPIRED').length;
    const parts  = allTrades.filter(t => t.outcome === 'PARTIAL').length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0';

    // Equity curve — 5% position sizing
    let balance = 1000;
    const curve = [{ date: fromStr, balance: 1000 }];
    for (const t of allTrades) {
      balance = Math.max(0, balance + balance * 0.05 * (t.pnl / 100));
      curve.push({ date: t.date, balance: parseFloat(balance.toFixed(2)) });
    }

    // Monthly breakdown
    const monthly = {};
    for (const t of allTrades) {
      const m = t.date.slice(0, 7);
      if (!monthly[m]) monthly[m] = { trades: 0, wins: 0 };
      monthly[m].trades++;
      if (t.outcome === 'WIN') monthly[m].wins++;
    }

    // Ticker performance
    const tickerPerf = Object.entries(tickerStats)
      .filter(([, s]) => s.trades > 0)
      .map(([sym, s]) => ({
        sym,
        trades: s.trades,
        wins: s.wins,
        win_rate: ((s.wins / s.trades) * 100).toFixed(1),
        total_pnl: s.pnl,
      }))
      .sort((a, b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));

    // Claude insight
    const prompt = `Plain English Trading backtest results:
- Period: ${monthsBack} months (${fromStr} to ${toStr})
- Total trades: ${total}
- Win rate: ${winRate}%  
- Wins: ${wins} | Losses: ${losses} | Partial: ${parts}
- $1,000 grew to: $${balance.toFixed(0)} (${(((balance-1000)/1000)*100).toFixed(1)}% return)
- Best tickers: ${tickerPerf.slice(0,3).map(t => `${t.sym} ${t.win_rate}%`).join(', ')}
- Worst tickers: ${tickerPerf.slice(-2).map(t => `${t.sym} ${t.win_rate}%`).join(', ')}

Write 2-3 sentences in plain English. Be honest. If above 40% win rate with positive return say it shows promise. If below 35% say it needs work. Mention the best ticker specifically.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: 'You are Plain English Trading. Honest, direct, no jargon.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const claudeJson = await claudeRes.json();
    const insight = (claudeJson.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('') || 'Analysis complete.';

    return res.status(200).json({
      summary: {
        months_tested: monthsBack,
        from: fromStr,
        to: toStr,
        total_trades: total,
        wins,
        losses,
        partials: parts,
        win_rate: winRate,
        starting_balance: 1000,
        ending_balance: parseFloat(balance.toFixed(2)),
        return_pct: (((balance - 1000) / 1000) * 100).toFixed(1),
      },
      insight,
      ticker_performance: tickerPerf,
      monthly_breakdown: Object.entries(monthly)
        .map(([month, d]) => ({
          month,
          trades: d.trades,
          wins: d.wins,
          win_rate: ((d.wins / d.trades) * 100).toFixed(1),
        }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      equity_curve: curve.filter((_, i) => i % 5 === 0 || i === curve.length - 1),
      recent_trades: allTrades.slice(-30),
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Backtest error:', err);
    return res.status(500).json({ error: err.message });
  }
}
