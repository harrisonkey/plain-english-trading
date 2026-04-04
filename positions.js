// api/positions.js — Read-only brokerage position tracking via Tradier
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tradier_token, account_id } = req.body || req.query;

  // If no Tradier token — return empty (brokerage linking is optional)
  if (!tradier_token || !account_id) {
    return res.status(200).json({ connected: false, positions: [], message: 'No brokerage connected' });
  }

  try {
    // Fetch positions from Tradier (read-only)
    const posR = await fetch(`https://api.tradier.com/v1/accounts/${account_id}/positions`, {
      headers: { 'Authorization': `Bearer ${tradier_token}`, 'Accept': 'application/json' }
    });
    const posData = await posR.json();

    // Fetch account balances
    const balR = await fetch(`https://api.tradier.com/v1/accounts/${account_id}/balances`, {
      headers: { 'Authorization': `Bearer ${tradier_token}`, 'Accept': 'application/json' }
    });
    const balData = await balR.json();

    const rawPositions = posData.positions?.position || [];
    const positions = Array.isArray(rawPositions) ? rawPositions : [rawPositions];
    const balance = balData.balances || {};

    // Format positions cleanly
    const formatted = positions
      .filter(p => p && p.symbol)
      .map(p => {
        const costBasis = p.cost_basis || 0;
        const quantity = p.quantity || 0;
        const currentValue = (p.quantity || 0) * (p.last_price || 0) * 100; // options are x100
        const pnl = currentValue - costBasis;
        const pnlPct = costBasis > 0 ? ((pnl / costBasis) * 100).toFixed(1) : '0';
        const isOption = p.symbol.length > 10; // options symbols are long

        // Parse option details from symbol if it's an option
        let optionDetails = null;
        if (isOption) {
          // OCC option symbol format: TICKER + YYMMDD + C/P + strike*1000
          try {
            const sym = p.symbol;
            const dateStr = sym.slice(-15, -9);
            const type = sym.slice(-9, -8) === 'C' ? 'CALL' : 'PUT';
            const strike = parseInt(sym.slice(-8)) / 1000;
            const year = '20' + dateStr.slice(0,2);
            const month = dateStr.slice(2,4);
            const day = dateStr.slice(4,6);
            const expiry = new Date(`${year}-${month}-${day}`);
            const daysLeft = Math.ceil((expiry - new Date()) / (1000*60*60*24));
            optionDetails = { type, strike, expiry: expiry.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}), daysLeft };
          } catch(e) {}
        }

        // Status based on P&L
        let status = 'HOLD';
        const pnlNum = parseFloat(pnlPct);
        if (pnlNum >= 100) status = 'SELL NOW — TARGET HIT';
        else if (pnlNum <= -50) status = 'SELL NOW — STOP HIT';
        else if (pnlNum >= 60) status = 'APPROACHING TARGET — Watch closely';
        else if (pnlNum <= -30) status = 'APPROACHING STOP — Be ready to exit';
        else if (optionDetails?.daysLeft <= 14) status = 'EXPIRY APPROACHING — Consider exiting';

        return {
          symbol: p.symbol,
          quantity,
          cost_basis: costBasis,
          current_value: currentValue,
          pnl: pnl.toFixed(2),
          pnl_pct: pnlPct,
          last_price: p.last_price,
          is_option: isOption,
          option_details: optionDetails,
          status,
          alert: status.includes('SELL NOW'),
        };
      });

    return res.status(200).json({
      connected: true,
      positions: formatted,
      account: {
        total_equity: balance.total_equity || 0,
        cash: balance.cash?.cash_available || 0,
        option_buying_power: balance.option_short_value || 0,
      },
      timestamp: new Date().toISOString(),
    });

  } catch(err) {
    console.error(err);
    return res.status(500).json({ error: err.message, connected: false, positions: [] });
  }
}
