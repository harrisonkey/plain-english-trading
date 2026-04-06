export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLY = process.env.POLYGON_API_KEY;
  const CLAUDE = process.env.ANTHROPIC_API_KEY;
  if (!POLY || !CLAUDE) return res.status(500).json({ error: `Missing keys. POLY:${!!POLY} CLAUDE:${!!CLAUDE}` });

  const monthsBack = Math.min(12, Math.max(1, parseInt((req.body||{}).months||6)));
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setMonth(fromDate.getMonth() - monthsBack);
  const fromStr = fromDate.toISOString().split('T')[0];
  const toStr = toDate.toISOString().split('T')[0];

  const TICKERS = [
    'RKLB','IONQ','SOUN','ASTS','LUNR',
    'KTOS','AVAV','RCAT','ACHR','JOBY',
    'OXY','MRO','CIVI','MTDR','CHRD',
    'ARDX','PRAX','VKTX','BEAM','CRSP',
    'MP','UUUU','UWMC','RKT','SMCI',
  ];

  try {
    const allTrades = [];
    const tickerStats = {};

    const fetched = await Promise.allSettled(
      TICKERS.map(sym =>
        fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=500&apiKey=${POLY}`)
          .then(r => r.json())
          .then(d => ({ sym, bars: d.results || [] }))
          .catch(e => ({ sym, bars: [], err: e.message }))
      )
    );

    for (const result of fetched) {
      if (result.status !== 'fulfilled') continue;
      const { sym, bars } = result.value;
      if (!bars || bars.length < 25) continue;

      tickerStats[sym] = { trades: 0, wins: 0, losses: 0, pnl: 0 };

      for (let i = 22; i < bars.length - 40; i += 3) {
        const price = bars[i].c;
        if (!price || price < 3 || price > 150) continue;

        const ma10 = bars.slice(i - 10, i).reduce((s, b) => s + b.c, 0) / 10;
        const ma20 = bars.slice(i - 20, i).reduce((s, b) => s + b.c, 0) / 20;

        const bullish = price > ma10 && ma10 > ma20;
        const bearish = price < ma10 && ma10 < ma20;
        if (!bullish && !bearish) continue;

        const type = bullish ? 'CALL' : 'PUT';
        const date = new Date(bars[i].t).toISOString().split('T')[0];
        const strike = type === 'CALL' ? Math.ceil(price/5)*5 : Math.floor(price/5)*5;
        const target = type === 'CALL' ? price * 1.12 : price * 0.88;
        const stop   = type === 'CALL' ? price * 0.94 : price * 1.06;

        const future = bars.slice(i + 1, i + 38);
        let outcome = 'EXPIRED';
        let pnl = -100;

        for (const fb of future) {
          if (type === 'CALL') {
            if (fb.h >= target) { outcome = 'WIN';  pnl =  100; break; }
            if (fb.l <= stop)   { outcome = 'LOSS'; pnl = -50;  break; }
          } else {
            if (fb.l <= target) { outcome = 'WIN';  pnl =  100; break; }
            if (fb.h >= stop)   { outcome = 'LOSS'; pnl = -50;  break; }
          }
        }

        if (outcome === 'EXPIRED' && future.length > 0) {
          const last = future[future.length - 1].c;
          if (type === 'CALL' ? last > strike : last < strike) {
            outcome = 'PARTIAL'; pnl = 15;
          }
        }

        tickerStats[sym].trades++;
        if      (outcome === 'WIN')     { tickerStats[sym].wins++;   tickerStats[sym].pnl += 100; }
        else if (outcome === 'LOSS')    { tickerStats[sym].losses++; tickerStats[sym].pnl -= 50;  }
        else if (outcome === 'PARTIAL') {                            tickerStats[sym].pnl += 15;  }
        else                            { tickerStats[sym].losses++; tickerStats[sym].pnl -= 100; }

        allTrades.push({ sym, date, price: price.toFixed(2), type, strike, outcome, pnl });
      }
    }

    allTrades.sort((a, b) => a.date.localeCompare(b.date));

    const total   = allTrades.length;
    const wins    = allTrades.filter(t => t.outcome === 'WIN').length;
    const losses  = allTrades.filter(t => t.outcome === 'LOSS' || t.outcome === 'EXPIRED').length;
    const parts   = allTrades.filter(t => t.outcome === 'PARTIAL').length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0';

    let balance = 1000;
    const curve = [{ date: fromStr, balance: 1000 }];
    for (const t of allTrades) {
      balance = Math.max(0, balance + balance * 0.05 * (t.pnl / 100));
      curve.push({ date: t.date, balance: parseFloat(balance.toFixed(2)) });
    }

    const monthly = {};
    for (const t of allTrades) {
      const m = t.date.slice(0, 7);
      if (!monthly[m]) monthly[m] = { trades: 0, wins: 0 };
      monthly[m].trades++;
      if (t.outcome === 'WIN') monthly[m].wins++;
    }

    const tickerPerf = Object.entries(tickerStats)
      .filter(([, s]) => s.trades > 0)
      .map(([sym, s]) => ({
        sym, trades: s.trades, wins: s.wins,
        win_rate: ((s.wins / s.trades) * 100).toFixed(1),
        total_pnl: s.pnl,
      }))
      .sort((a, b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));

    const prompt = `Backtest: ${monthsBack}mo, ${total} trades, ${winRate}% WR, $1000→$${balance.toFixed(0)}. Best: ${tickerPerf.slice(0,3).map(t=>`${t.sym} ${t.win_rate}%`).join(', ')}. 2 honest sentences.`;
    const cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 150, system: 'Plain English Trading. Honest and direct.', messages: [{ role: 'user', content: prompt }] })
    });
    const cj = await cr.json();
    const insight = (cj.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('') || 'Done.';

    return res.status(200).json({
      summary: { months_tested: monthsBack, from: fromStr, to: toStr, total_trades: total, wins, losses, partials: parts, win_rate: winRate, starting_balance: 1000, ending_balance: parseFloat(balance.toFixed(2)), return_pct: (((balance-1000)/1000)*100).toFixed(1) },
      insight, ticker_performance: tickerPerf,
      monthly_breakdown: Object.entries(monthly).map(([month,d])=>({ month, trades:d.trades, wins:d.wins, win_rate:((d.wins/d.trades)*100).toFixed(1) })).sort((a,b)=>a.month.localeCompare(b.month)),
      equity_curve: curve.filter((_,i)=>i%5===0||i===curve.length-1),
      recent_trades: allTrades.slice(-30),
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
