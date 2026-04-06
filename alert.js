// api/alert.js — Check open positions against live prices, return sell/stop alerts
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLY = process.env.POLYGON_API_KEY;
  if (!POLY) return res.status(500).json({ error: 'Missing POLYGON_API_KEY' });

  const { positions } = req.body || {};
  if (!positions || !positions.length) return res.status(200).json({ alerts: [], checked: 0 });

  try {
    const today  = new Date();
    const from   = new Date(today); from.setDate(from.getDate() - 3);
    const toStr  = today.toISOString().split('T')[0];
    const fromStr = from.toISOString().split('T')[0];

    const alerts = [];

    await Promise.allSettled(
      positions.map(async (pos) => {
        try {
          const r = await fetch(
            `https://api.polygon.io/v2/aggs/ticker/${pos.sym}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=2&apiKey=${POLY}`
          );
          const d = await r.json();
          const bars = d.results || [];
          if (!bars.length) return;

          const currentPrice = bars[0].c;
          const prevPrice    = bars[1]?.c || currentPrice;
          const pct          = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;

          // For calls: target = +12%, stop = -6% from entry
          // For puts:  target = -12%, stop = +6% from entry
          const isCall = pos.type === 'CALL';
          const hitTarget = isCall ? currentPrice >= pos.stock_target : currentPrice <= pos.stock_target;
          const hitStop   = isCall ? currentPrice <= pos.stock_stop   : currentPrice >= pos.stock_stop;
          const nearTarget = isCall ? currentPrice >= pos.stock_target * 0.97 : currentPrice <= pos.stock_target * 1.03;
          const nearStop   = isCall ? currentPrice <= pos.stock_stop  * 1.03  : currentPrice >= pos.stock_stop   * 0.97;

          if (hitTarget) {
            alerts.push({ sym: pos.sym, type: 'SELL_TARGET', urgency: 'HIGH', message: `🎯 ${pos.sym} HIT TARGET — Sell now! Stock at $${currentPrice.toFixed(2)}, target was $${pos.stock_target}. Your option should have doubled. Take the profit.`, current_price: currentPrice, entry_price: pos.entry_price, pct_change: pct.toFixed(1) });
          } else if (hitStop) {
            alerts.push({ sym: pos.sym, type: 'STOP_LOSS', urgency: 'HIGH', message: `🛑 ${pos.sym} HIT STOP LOSS — Exit now! Stock at $${currentPrice.toFixed(2)}, stop was $${pos.stock_stop}. Cut the loss before it gets worse.`, current_price: currentPrice, entry_price: pos.entry_price, pct_change: pct.toFixed(1) });
          } else if (nearTarget) {
            alerts.push({ sym: pos.sym, type: 'NEAR_TARGET', urgency: 'MEDIUM', message: `📈 ${pos.sym} near target — Stock at $${currentPrice.toFixed(2)}, target $${pos.stock_target}. Watch closely. Consider selling half now to lock in gains.`, current_price: currentPrice, entry_price: pos.entry_price, pct_change: pct.toFixed(1) });
          } else if (nearStop) {
            alerts.push({ sym: pos.sym, type: 'NEAR_STOP', urgency: 'MEDIUM', message: `⚠️ ${pos.sym} approaching stop — Stock at $${currentPrice.toFixed(2)}, stop at $${pos.stock_stop}. Be ready to exit.`, current_price: currentPrice, entry_price: pos.entry_price, pct_change: pct.toFixed(1) });
          } else {
            alerts.push({ sym: pos.sym, type: 'OK', urgency: 'LOW', message: `✅ ${pos.sym} — Stock at $${currentPrice.toFixed(2)} (${pct>=0?'+':''}${pct.toFixed(1)}% from your entry). Holding. Target: $${pos.stock_target} | Stop: $${pos.stock_stop}`, current_price: currentPrice, entry_price: pos.entry_price, pct_change: pct.toFixed(1) });
          }
        } catch(e) {}
      })
    );

    alerts.sort((a,b) => { const order = {HIGH:0,MEDIUM:1,LOW:2}; return (order[a.urgency]||2)-(order[b.urgency]||2); });

    return res.status(200).json({ alerts, checked: positions.length, timestamp: new Date().toISOString() });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
