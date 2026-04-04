# Plain English Trading — Deploy Guide
## From zero to live in 25 minutes

---

## What you're building
A production options coaching platform with:
- Real-time Polygon.io market data
- AI analysis via Claude — specific strike, expiry, premium for every setup
- Small cap unusual volume detection with 5 hard filters
- Live position tracking via Tradier brokerage API (read-only)
- Trade journal with win/loss tracking and track record
- Screenshot analysis
- Mobile-friendly, works on any device

---

## Step 1 — Get your API keys (10 minutes)

### A) Polygon.io — market data ($29/month)
1. Go to **polygon.io**
2. Sign up for an account
3. Click Upgrade → choose **Starter plan** ($29/month)
4. Go to Dashboard → API Keys
5. Copy your API key — looks like: `abc123xyz456...`

### B) Anthropic — Claude AI (pay per use, ~$3-5/month)
1. Go to **console.anthropic.com**
2. Sign up or log in
3. Click API Keys → Create new key
4. Copy your key — looks like: `sk-ant-api03-...`

---

## Step 2 — Create GitHub account and upload code (5 minutes)

1. Go to **github.com** → Sign up (free)
2. Click the **+** button → New repository
3. Name it: `plain-english-trading`
4. Set to **Public**
5. Click Create repository
6. Click **uploading an existing file**
7. Upload ALL files from this folder:
   - The `api/` folder (with scan.js, analyze.js, positions.js, screenshot.js)
   - The `public/` folder (with index.html)
   - `vercel.json`
   - `README.md`
8. Click Commit changes

---

## Step 3 — Deploy to Vercel (5 minutes)

1. Go to **vercel.com** → Sign up with your GitHub account
2. Click **Add New Project**
3. Find and select your `plain-english-trading` repository
4. Click **Deploy** (takes about 2 minutes)
5. You now have a live URL like: `https://plain-english-trading-xyz.vercel.app`

---

## Step 4 — Add your API keys to Vercel (3 minutes)

This is the most important step — without this the app has no data.

1. In Vercel, click your project
2. Click **Settings** → **Environment Variables**
3. Add the first variable:
   - Name: `POLYGON_API_KEY`
   - Value: (paste your Polygon key from Step 1A)
   - Click Save
4. Add the second variable:
   - Name: `ANTHROPIC_API_KEY`
   - Value: (paste your Anthropic key from Step 1B)
   - Click Save
5. Go to **Deployments** → click the three dots on the latest deployment → **Redeploy**
6. Wait 2 minutes — done

---

## Step 5 — Connect your Tradier brokerage (optional, 5 minutes)

This is for live position tracking. Skip if you just want the scanner.

1. Go to **tradier.com** → Create a free brokerage account
2. Fund with any amount (even $100 to start)
3. Click your name → Account → API Access
4. Generate a new API token (read-only is fine)
5. Copy your Account ID from the dashboard
6. In your Plain English Trading app → click **My Positions** tab
7. Paste your Tradier token and account ID → Connect

Your live positions now appear automatically with P&L, status, and sell alerts.

---

## How to use it

### Daily scan
1. Open the app every morning
2. Click **Find Today's Plays**
3. Wait 10-15 seconds for real data to load
4. Tap any BUY setup to expand it
5. Read "What to do right now" — it tells you exactly what to buy
6. Check position sizing — it calculates how many contracts for your balance
7. Place the trade on your broker
8. Add it to your journal

### Analyze any ticker
1. Click **Any Ticker** tab
2. Type any stock symbol
3. Get a full breakdown with real Polygon data in 5-10 seconds

### Track your positions
1. With Tradier connected: positions appear automatically
2. Red alert = sell now (stop or target hit)
3. Without Tradier: use the Journal tab to track manually

### The two rules — follow these always
- **Sell when premium doubles** (+100%) — take profit, don't get greedy
- **Sell when premium halves** (-50%) — cut the loss, no exceptions

---

## Costs
| Item | Cost |
|------|------|
| Vercel hosting | Free |
| Polygon.io Starter | $29/month |
| Anthropic Claude API | ~$3-5/month |
| Tradier brokerage | Free account |
| **Total** | **~$32-34/month** |

---

## File structure
```
plain-english-trading/
├── api/
│   ├── scan.js         ← Daily market scan (Polygon + Claude)
│   ├── analyze.js      ← Single ticker deep analysis
│   ├── positions.js    ← Tradier brokerage position tracking
│   └── screenshot.js   ← Screenshot analysis
├── public/
│   └── index.html      ← Full frontend app
├── vercel.json         ← Deployment configuration
└── README.md           ← This file
```

---

## Troubleshooting

**"Missing API keys" error**
→ Make sure both environment variables are added in Vercel Settings → Environment Variables and you've redeployed

**"No setups passed filters today"**
→ This is correct behavior — filters are strict. Try the Any Ticker tab.

**Scan takes a long time**
→ Normal. Polygon fetches data for 35+ tickers simultaneously. Takes 10-20 seconds.

**Tradier connection fails**
→ Make sure you're using the API token (not your password) and the correct account ID from your Tradier dashboard

**App shows "Deploy to Vercel for live data"**
→ You're opening the HTML file locally. Upload to Vercel first — the API calls only work when deployed.
