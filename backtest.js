// backtest.js — Historical signal backtesting engine
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLY = process.env.POLYGON_API_KEY;
  const CLAUDE = process.env.ANTHROPIC_API_KEY;
  if (!POLY || !CLAUDE) return res.status(500).json({ error: 'Missing API keys' });

  const { months = 6, tickers: tickerParam } = req.body || req.query;
  const monthsBack = Math.min(12, Math.max(1, parseInt(months) || 6));

  // Date range
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsBack);
  const fromStr = startDate.toISOString().split('T')[0];
  const toStr = endDate.toISOString().split('T')[0];

  // Small cap candidates
  const TICKERS = tickerParam
    ? (Array.isArray(tickerParam) ? tickerParam : tickerParam.split(',').map(t => t.trim().toUpperCase()))
    : ['OXY','MRO','CIVI','MTDR','SOUN','IONQ','RKLB','ACHR','ARDX','PRAX','VKTX','KTOS','AVAV','RCAT','MP','UUUU','UWMC','RKT','PFSI','SMCI','AEHR','ASTS','LUNR','CHRD','BEAM'];

  try {
    // Fetch SPY for trend gate
    const spyR = await fetch(`https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=500&apiKey=${POLY}`);
    const spyD = await spyR.json();
    const spyBars = spyD.results || [];

    // Build SPY MA lookup by date
    const spyByDate = {};
    spyBars.forEach((b, i) => {
      const date = new Date(b.t).toISOString().split('T')[0];
      const slice = spyBars.slice(Math.max(0, i - 19), i + 1);
      const ma20 = slice.reduce((s, x) => s + x.c, 0) / slice.length;
      spyByDate[date] = { price: b.c, ma20, trend: b.c > ma20 ? 'BULLISH' : 'BEARISH' };
    });

    // Fetch price history for all tickers
    const priceResults = await Promise.allSettled(
      TICKERS.map(sym =>
        fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=500&apiKey=${POLY}`)
          .then(r => r.json())
          .then(d => ({ sym, bars: d.results || [] }))
      )
    );

    const allTrades = [];
    const tickerStats = {};

    for (const result of priceResults) {
      if (result.status !== 'fulfilled') continue;
      const { sym, bars } = result.value;
      if (!bars || bars.length < 30) continue;

      tickerStats[sym] = { signals: 0, trades: 0, wins: 0, losses: 0, totalPnl: 0 };

      // Walk through each trading day
      for (let i = 20; i < bars.length - 45; i++) {
        const bar = bars[i];
        const date = new Date(bar.t).toISOString().split('T')[0];
        const price = bar.c;

        // Skip if price out of range
        if (price < 5 || price > 80) continue;

        // Calculate 20-day average volume
        const avgVol = bars.slice(i - 20, i).reduce((s, b) => s + (b.v || 0), 0) / 20;
        const volMult = avgVol > 0 ? bar.v / avgVol : 0;

        // Volume spike gate — 1.5x minimum
        if (volMult < 1.5) continue;

        // SPY trend gate
        const spyData = spyByDate[date];
        if (!spyData) continue;
        const trend = spyData.trend;

        // Moving averages
        const ma10 = bars.slice(i - 10, i).reduce((s, b) => s + b.c, 0) / 10;
        const ma20 = bars.slice(i - 20, i).reduce((s, b) => s + b.c, 0) / 20;

        // Direction alignment
        const isAligned = trend === 'BULLISH' ? price > ma10 : price < ma10;
        if (!isAligned) continue;

        tickerStats[sym].signals++;

        // Simulate the trade
        // Strike: nearest OTM
        const type = trend === 'BULLISH' ? 'CALL' : 'PUT';
        const strike = type === 'CALL'
          ? Math.ceil(price / 5) * 5  // nearest $5 above for call
          : Math.floor(price / 5) * 5; // nearest $5 below for put

        // Estimate premium using simplified Black-Scholes approximation
        // Using 30% annualized vol estimate for small caps
        const daysToExpiry = 37; // 37 days target expiry
        const vol = 0.35; // 35% annualized vol estimate for small caps
        const timeFactor = Math.sqrt(daysToExpiry / 365);
        const otmDistance = Math.abs(price - strike) / price;
        const basePremium = price * vol * timeFactor * (1 - otmDistance * 2);
        const estPremium = Math.max(0.50, Math.min(basePremium, price * 0.15)).toFixed(2);
        const targetPremium = (parseFloat(estPremium) * 2).toFixed(2);
        const stopPremium = (parseFloat(estPremium) * 0.5).toFixed(2);

        // Fast forward to see outcome
        // Look at next 37 days of price action
        const futureBars = bars.slice(i + 1, i + 1 + daysToExpiry);
        if (futureBars.length < 10) continue;

        tickerStats[sym].trades++;

        // Determine target and stop price levels
        const targetPrice = type === 'CALL' ? price * 1.12 : price * 0.88; // ~12% move needed
        const stopPrice = type === 'CALL' ? price * 0.94 : price * 1.06;   // ~6% against = stop

        let outcome = 'EXPIRED';
        let exitDay = daysToExpiry;
        let pnlPct = -100; // default: expired worthless

        for (let j = 0; j < futureBars.length; j++) {
          const futBar = futureBars[j];

          if (type === 'CALL') {
            if (futBar.h >= targetPrice) {
              outcome = 'WIN';
              exitDay = j + 1;
              pnlPct = 100;
              break;
            }
            if (futBar.l <= stopPrice) {
              outcome = 'LOSS';
              exitDay = j + 1;
              pnlPct = -50;
              break;
            }
          } else {
            if (futBar.l <= targetPrice) {
              outcome = 'WIN';
              exitDay = j + 1;
              pnlPct = 100;
              break;
            }
            if (futBar.h >= stopPrice) {
              outcome = 'LOSS';
              exitDay = j + 1;
              pnlPct = -50;
              break;
            }
          }
        }

        if (outcome === 'EXPIRED') {
          // Check where price ended vs strike
          const finalPrice = futureBars[futureBars.length - 1].c;
          const inMoney = type === 'CALL' ? finalPrice > strike : finalPrice < strike;
          pnlPct = inMoney ? 20 : -100; // small gain if barely ITM, full loss if OTM
          outcome = inMoney ? 'PARTIAL' : 'EXPIRED';
        }

        if (outcome === 'WIN') {
          tickerStats[sym].wins++;
          tickerStats[sym].totalPnl += 100;
        } else if (outcome === 'LOSS') {
          tickerStats[sym].losses++;
          tickerStats[sym].totalPnl -= 50;
        } else if (outcome === 'PARTIAL') {
          tickerStats[sym].totalPnl += 20;
        } else {
          tickerStats[sym].losses++;
          tickerStats[sym].totalPnl -= 100;
        }

        allTrades.push({
          sym,
          date,
          price: price.toFixed(2),
          type,
          strike,
          trend,
          vol_mult: volMult.toFixed(1),
          est_premium: estPremium,
          outcome,
          exit_day: exitDay,
          pnl_pct: pnlPct,
          target_price: targetPrice.toFixed(2),
          stop_price: stopPrice.toFixed(2),
        });
      }
    }

    // Sort trades by date
    allTrades.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Overall stats
    const totalTrades = allTrades.length;
    const wins = allTrades.filter(t => t.outcome === 'WIN').length;
    const losses = allTrades.filter(t => t.outcome === 'LOSS' || t.outcome === 'EXPIRED').length;
    const partials = allTrades.filter(t => t.outcome === 'PARTIAL').length;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0';
    const totalPnlPct = allTrades.reduce((s, t) => s + t.pnl_pct, 0);

    // Monthly breakdown
    const byMonth = {};
    allTrades.forEach(t => {
      const month = t.date.slice(0, 7);
      if (!byMonth[month]) byMonth[month] = { trades: 0, wins: 0, pnl: 0 };
      byMonth[month].trades++;
      if (t.outcome === 'WIN') byMonth[month].wins++;
      byMonth[month].pnl += t.pnl_pct;
    });

    // Sector/ticker performance
    const tickerPerf = Object.entries(tickerStats)
      .filter(([, s]) => s.trades > 0)
      .map(([sym, s]) => ({
        sym,
        trades: s.trades,
        wins: s.wins,
        win_rate: s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0',
        total_pnl: s.totalPnl,
      }))
      .sort((a, b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));

    // Simulate $1000 account growth
    let accountBalance = 1000;
    const equityCurve = [{ date: fromStr, balance: 1000 }];
    allTrades.forEach(t => {
      const riskAmt = accountBalance * 0.05; // 5% rule
      const gain = riskAmt * (t.pnl_pct / 100);
      accountBalance = Math.max(0, accountBalance + gain);
      equityCurve.push({ date: t.date, balance: parseFloat(accountBalance.toFixed(2)) });
    });

    // Ask Claude for insights on the backtest results
    const claudePrompt = `You are Plain English Trading's analysis engine. Here are backtesting results for the last ${monthsBack} months:

Total trades: ${totalTrades}
Win rate: ${winRate}%
Wins: ${wins} | Losses: ${losses} | Partial: ${partials}
Starting $1000 → ending $${accountBalance.toFixed(0)}
Best performing tickers: ${tickerPerf.slice(0,3).map(t=>`${t.sym} (${t.win_rate}% win rate)`).join(', ')}
Worst performing: ${tickerPerf.slice(-2).map(t=>`${t.sym} (${t.win_rate}% win rate)`).join(', ')}

Give a 3-sentence plain English summary of what these results mean. Be honest — if the results are bad, say so. Tell the user what to watch out for and what looks promising. Keep it simple.`;

    const cRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: 'You are Plain English Trading. Be direct and honest about backtest results. Plain English only.',
        messages: [{ role: 'user', content: claudePrompt }]
      })
    });
    const cData = await cRes.json();
    const insight = (cData.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || 'Analysis complete.';

    return res.status(200).json({
      summary: {
        months_tested: monthsBack,
        from: fromStr,
        to: toStr,
        total_trades: totalTrades,
        wins,
        losses,
        partials,
        win_rate: winRate,
        total_pnl_pct: totalPnlPct.toFixed(1),
        starting_balance: 1000,
        ending_balance: parseFloat(accountBalance.toFixed(2)),
        return_pct: (((accountBalance - 1000) / 1000) * 100).toFixed(1),
      },
      insight,
      ticker_performance: tickerPerf,
      monthly_breakdown: Object.entries(byMonth).map(([month, d]) => ({
        month,
        trades: d.trades,
        wins: d.wins,
        win_rate: d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(1) : '0',
        pnl: d.pnl.toFixed(1),
      })).sort((a, b) => a.month.localeCompare(b.month)),
      equity_curve: equityCurve.filter((_, i) => i % 3 === 0 || i === equityCurve.length - 1),
      recent_trades: allTrades.slice(-30),
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
