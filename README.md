# Crypto News Bot (Personal Use)

Sends you a push notification for each AI-analyzed, crypto-relevant economic event (from Forex
Factory's free calendar feed), straight to your phone via **ntfy**. Runs free forever on GitHub
Actions — no server, no Telegram, no account needed for notifications.

## What it does
1. Fetches this week's economic calendar (free, no API key needed).
2. Filters to Medium/High impact events for USD/CNY/EUR happening **today**.
3. Sends each event to Gemini for a short "why this moves crypto" analysis.
4. Pushes one notification per event straight to your phone via ntfy.

## Setup (10-15 minutes)

### 1. Install ntfy on your phone
1. Search "ntfy" in the Play Store / App Store and install it. It's free, no account/sign-up.
2. Open the app, tap **+** (Subscribe to topic).
3. Type a random, hard-to-guess topic name — e.g. `tharu-crypto-8f2k9x`. Anyone who knows this
   exact name could subscribe too, so make it random rather than something guessable.
4. Tap Subscribe. That's your setup done on the phone side.

### 2. Get a free Gemini API key
1. Go to https://aistudio.google.com/apikey (same Google AI Studio you already use).
2. Create an API key — free tier is plenty for one daily digest.

### 3. Put this code on GitHub
1. Create a new **private** GitHub repo (github.com → "+" → New repository).
2. Upload these files, keeping the folder structure exactly as-is:
   - `index.js`
   - `package.json`
   - `README.md`
   - `.github/workflows/daily-run.yml`

### 4. Add your secrets
In your repo: **Settings → Secrets and variables → Actions → New repository secret**.
Add both:
- `NTFY_TOPIC` — the random topic name you picked in step 1 (e.g. `tharu-crypto-8f2k9x`)
- `GEMINI_API_KEY` — the key from step 2

### 5. Test it
Go to the **Actions** tab → "Daily Crypto News Digest" → **Run workflow** (green button).
Wait ~30 seconds, check for a green checkmark, then check your phone for push notifications.

It will then run automatically every day at 06:30 Sri Lanka time — your phone/laptop can be off,
since it runs on GitHub's own servers. Edit the `cron` line in `.github/workflows/daily-run.yml`
to change the schedule (e.g. every 6 hours instead of once daily).

## Customizing
- `RELEVANT_CURRENCIES` in `index.js` — add/remove currencies (e.g. `"GBP"`, `"JPY"`).
- `RELEVANT_IMPACT` — set to `["High"]` only for fewer, bigger-only alerts.
- Notification urgency — High-impact events send as "urgent" priority pushes (make sound/vibrate
  even if your phone is on silent, depending on your ntfy notification settings); Medium-impact
  are normal priority.
- Language — add "Respond in Sinhala-English mix" to the prompt inside `getAiAnalysis()` in
  `index.js` if you want the AI analysis in Sinhala-English instead of English.
- Schedule frequency — edit the cron expression in the workflow file.

## Notes
- 100% free: GitHub Actions free tier, Forex Factory's free feed, Gemini free tier, ntfy is free.
- No Telegram, no WhatsApp, no phone number, no email — just the ntfy topic name.
- Keep your topic name private-ish (random string) — anyone with the exact name can subscribe to
  the same notifications, though this isn't a security-sensitive use case either way.
