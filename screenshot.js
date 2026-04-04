// api/screenshot.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const CLAUDE = process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });

  const { image_base64, media_type = 'image/png' } = req.body || {};
  if (!image_base64) return res.status(400).json({ error: 'Image required' });

  try {
    const dateStr = new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    const cRes = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':CLAUDE,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({
        model:'claude-sonnet-4-20250514',
        max_tokens:1200,
        system:'You are Plain English Trading. Analyze trading screenshots and give simple, specific options recommendations. Respond ONLY with raw JSON.',
        messages:[{role:'user',content:[
          {type:'image',source:{type:'base64',media_type,data:image_base64}},
          {type:'text',text:`Today is ${dateStr}. Analyze this screenshot and give a Plain English Trading recommendation.

Return ONLY raw JSON:
{
  "sym": "detected ticker or UNKNOWN",
  "name": "company name",
  "price": "detected price or unknown",
  "what_i_see": "One sentence describing what's in the screenshot",
  "verdict": "BUY",
  "confidence": "HIGH",
  "type": "CALL",
  "strike": 45,
  "expiry": "May 16 2026",
  "est_premium": 1.80,
  "cost_per_contract": 180,
  "sell_at_premium": 3.60,
  "stop_at_premium": 0.90,
  "what_to_do": "Plain English exact instructions",
  "why_plain_english": "Two sentences why this setup looks good or bad",
  "green_flags": ["flag 1","flag 2"],
  "red_flags": ["warning 1","warning 2"],
  "risk": 50,
  "skip": false,
  "skip_reason": null
}`}
        ]}]
      })
    });
    const cData = await cRes.json();
    const raw = (cData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const clean = raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    let analysis;
    try { analysis=JSON.parse(clean); }
    catch(e) { const m=clean.match(/\{[\s\S]*\}/); analysis=m?JSON.parse(m[0]):{verdict:'SKIP',skip:true,skip_reason:'Could not read screenshot clearly'}; }
    return res.status(200).json({ ...analysis, timestamp:new Date().toISOString() });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
