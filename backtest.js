// backtest.js — Simplified backtesting engine for Polygon Starter plan
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLY = process.env.POLYGON_API_KEY;
  const CLAUDE = process.env.ANTHROPIC_API_KEY;
  if (!POLY || !CLAUDE) return res.status(500).json({ error: 'Missing API keys' });

  const { months = 6 } = req.body || req.query;
  const monthsBack = Math.min(12, Math.max(1, parseInt(months) || 6));

  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsBack);
  const fromStr = startDate.toISOString().split('T')[0];
  const toStr = endDate.toISOString().split('T')[0];

  const TICKERS = [
    'OXY','MRO','CIVI','SOUN','IONQ','RKLB','ARDX','PRAX',
    'KTOS','AVAV','MP','UUUU','UWMC','RKT','SMCI','AEHR',
    'ASTS','LUNR','CHRD','VKTX','PFSI','MTDR','ACHR','BEAM','RCAT'
  ];

  try {
    const spyR = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=500&apiKey=${POLY}`
    );
    const spyD = await spyR.json();
    const spyBars = spyD.results || [];

    if (!spyBars.length) {
      return res.status(200).json({
        summary: { months_tested: monthsBack, from: fromStr, to: toStr, total_trades: 0, wins: 0, losses: 0, partials: 0, win_rate: '0', total_pnl_pct: '0', starting_balance: 1000, ending_balance: 1000, return_pct: '0' },
        insight: 'Could not fetch SPY data from Polygon. Check your API key.',
        ticker_performance: [], monthly_breakdown: [], equity_curve: [], recent_trades: [],
        timestamp: new Date().toISOString()
      });
    }

    const spyByDate = {};
    spyBars.forEach((b, i) => {
      const date = new Date(b.t).toISOString().split('T')[0];
      const slice = spyBars.slice(Math.max(0, i - 19), i + 1);
      const ma20 = slice.reduce((s, x) => s + x.c, 0) / slice.length;
      spyByDate[date] = { price: b.c, ma20, trend: b.c > ma20 ? 'BULLISH' : 'BEARISH' };
    });

    const fetches = await Promise.allSettled(
      TICKERS.map(sym =>
        fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=500&apiKey=${POLY}`)
          .then(r => r.json())
          .then(d => ({ sym, bars: d.results || [] }))
          .catch(() => ({ sym, bars: [] }))
      )
    );

    const allTrades = [];
    const tickerStats = {};

    for (const f of fetches) {
      if (f.status !== 'fulfilled') continue;
      const { sym, bars } = f.value;
      if (!bars || bars.length < 25) continue;

      tickerStats[sym] = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };

      for (let i = 22; i < bars.length - 40; i += 3) {
        const bar = bars[i];
        if (!bar) continue;
        const price = bar.c;
        if (!price || price < 3 || price > 150) continue;

        const date = new Date(bar.t).toISOString().split('T')[0];
        const spyInfo = spyByDate[date];
        const trend = spyInfo ? spyInfo.trend : 'BULLISH';

        const ma10 = bars.slice(i - 10, i).reduce((s, b) => s + b.c, 0) / 10;
        const ma20 = bars.slice(i - 20, i).reduce((s, b) => s + b.c, 0) / 20;

        const bullMomentum = price > ma10 && ma10 > ma20;
        const bearMomentum = price < ma10 && ma10 < ma20;
        if (!bullMomentum && !bearMomentum) continue;

        const type = trend === 'BULLISH' && bullMomentum ? 'CALL' :
                     trend === 'BEARISH' && bearMomentum ? 'PUT' : null;
        if (!type) continue;

        tickerStats[sym].trades++;

        const strike = type === 'CALL'
          ? Math.ceil(price / 5) * 5
          : Math.floor(price / 5) * 5;

        const vol = 0.40;
        const dte = 37;
        const timeFactor = Math.sqrt(dte / 365);
        const otmDist = Math.abs(price - strike) / price;
        const rawPrem = price * vol * timeFactor * Math.max(0.1, 1 - otmDist * 3);
        const estPremium = Math.max(0.30, Math.min(rawPrem, price * 0.12));

        const targetStock = type === 'CALL' ? price * 1.12 : price * 0.88;
        const stopStock = type === 'CALL' ? price * 0.94 : price * 1.06;

        const future = bars.slice(i + 1, i + 38);
        let outcome = 'EXPIRED';
        let exitDay = 37;
        let pnlPct = -100;

        for (let j = 0; j < future.length; j++) {
          const fb = future[j];
          if (!fb) break;
          if (type === 'CALL') {
            if (fb.h >= targetStock) { outcome = 'WIN'; exitDay = j + 1; pnlPct = 100; break; }
            if (fb.l <= stopStock) { outcome = 'LOSS'; exitDay = j + 1; pnlPct = -50; break; }
          } else {
            if (fb.l <= targetStock) { outcome = 'WIN'; exitDay = j + 1; pnlPct = 100; break; }
            if (fb.h >= stopStock) { outcome = 'LOSS'; exitDay = j + 1; pnlPct = -50; break; }
          }
        }

        if (outcome === 'EXPIRED') {
          const finalBar = future[future.length - 1];
          if (finalBar) {
            const inMoney = type === 'CALL' ? finalBar.c > strike : finalBar.c < strike;
            pnlPct = inMoney ? 15 : -100;
            outcome = inMoney ? 'PARTIAL' : 'EXPIRED';
          }
        }

        if (outcome === 'WIN') { tickerStats[sym].wins++; tickerStats[sym].totalPnl += 100; }
        else if (outcome === 'LOSS') { tickerStats[sym].losses++; tickerStats[sym].totalPnl -= 50; }
        else if (outcome === 'PARTIAL') { tickerStats[sym].totalPnl += 15; }
        else { tickerStats[sym].losses++; tickerStats[sym].totalPnl -= 100; }

        const volMult = bar.v && bars[i-1] && bars[i-1].v ? (bar.v / bars[i-1].v).toFixed(1) : 'N/A';

        allTrades.push({
          sym, date, price: price.toFixed(2), type, strike,
          trend, vol_mult: volMult, est_premium: estPremium.toFixed(2),
          outcome, exit_day: exitDay, pnl_pct: pnlPct,
          target_price: targetStock.toFixed(2), stop_price: stopStock.toFixed(2),
        });
      }
    }

    allTrades.sort((a, b) => new Date(a.date) - new Date(b.date));

    const totalTrades = allTrades.length;
    const wins = allTrades.filter(t => t.outcome === 'WIN').length;
    const losses = allTrades.filter(t => t.outcome === 'LOSS' || t.outcome === 'EXPIRED').length;
    const partials = allTrades.filter(t => t.outcome === 'PARTIAL').length;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0';

    let balance = 1000;
    const equityCurve = [{ date: fromStr, balance: 1000 }];
    allTrades.forEach(t => {
      const risk = balance * 0.05;
      balance = Math.max(0, balance + risk * (t.pnl_pct / 100));
      equityCurve.push({ date: t.date, balance: parseFloat(balance.toFixed(2)) });
    });

    const byMonth = {};
    allTrades.forEach(t => {
      const m = t.date.slice(0, 7);
      if (!byMonth[m]) byMonth[m] = { trades: 0, wins: 0, pnl: 0 };
      byMonth[m].trades++;
      if (t.outcome === 'WIN') byMonth[m].wins++;
      byMonth[m].pnl += t.pnl_pct;
    });

    const tickerPerf = Object.entries(tickerStats)
      .filter(([, s]) => s.trades > 0)
      .map(([sym, s]) => ({
        sym, trades: s.trades, wins: s.wins,
        win_rate: s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0',
        total_pnl: s.totalPnl,
      }))
      .sort((a, b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));

    const prompt = `Backtest results for Plain English Trading over ${monthsBack} months: Total trades: ${totalTrades}, Win rate: ${winRate}%, Wins: ${wins}, Losses: ${losses}. $1000 grew to $${balance.toFixed(0)}. Top tickers: ${tickerPerf.slice(0,3).map(t=>`${t.sym} ${t.win_rate}%`).join(', ')}. Give a 2-3 sentence honest plain English summary of whether this strategy looks promising.`;

    const cRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 200,
        system: 'You are Plain English Trading. Be honest and direct.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const cData = await cRes.json();
    const insight = (cData.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || 'Analysis complete.';

    return res.status(200).json({
      summary: {
        months_tested: monthsBack, from: fromStr, to: toStr,
        total_trades: totalTrades, wins, losses, partials, win_rate: winRate,
        total_pnl_pct: allTrades.reduce((s,t)=>s+t.pnl_pct,0).toFixed(1),
        starting_balance: 1000, ending_balance: parseFloat(balance.toFixed(2)),
        return_pct: (((balance - 1000) / 1000) * 100).toFixed(1),
      },
      insight,
      ticker_performance: tickerPerf,
      monthly_breakdown: Object.entries(byMonth).map(([month, d]) => ({
        month, trades: d.trades, wins: d.wins,
        win_rate: d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(1) : '0',
        pnl: d.pnl.toFixed(1),
      })).sort((a, b) => a.month.localeCompare(b.month)),
      equity_curve: equityCurve.filter((_, i) => i % 5 === 0 || i === equityCurve.length - 1),
      recent_trades: allTrades.slice(-30),
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
