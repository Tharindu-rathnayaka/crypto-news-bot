// crypto-news-bot: Forex Factory economic calendar -> AI analysis -> ntfy push notification
// Personal use script. Runs once per invocation (designed for a daily cron via GitHub Actions).

const FF_FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

// Currencies/regions whose data reliably moves crypto (via USD liquidity / risk sentiment).
// Edit this list to taste.
const RELEVANT_CURRENCIES = ["USD", "CNY", "EUR"];

// Only alert on Medium/High impact. Low-impact prints are noise.
const RELEVANT_IMPACT = ["Medium", "High"];

const NTFY_TOPIC = process.env.NTFY_TOPIC; // the random topic name you picked in the ntfy app
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fetchCalendar() {
  const res = await fetch(FF_FEED_URL);
  if (!res.ok) throw new Error(`Failed to fetch calendar: ${res.status}`);
  return res.json();
}

function filterTodaysRelevantEvents(events) {
  const today = todayISO();
  return events.filter((e) => {
    const eventDate = (e.date || "").slice(0, 10);
    const isToday = eventDate === today;
    const relevantCurrency = RELEVANT_CURRENCIES.includes(e.country);
    const relevantImpact = RELEVANT_IMPACT.includes(e.impact);
    return isToday && relevantCurrency && relevantImpact;
  });
}

async function getAiAnalysis(event) {
  const prompt = `You are a crypto market analyst. In 2-3 short sentences, explain how this economic event
typically affects crypto prices (BTC/majors) and why. Be concrete about direction/mechanism (e.g. "higher than
forecast CPI -> hawkish Fed expectations -> risk-off -> BTC downside pressure"). No disclaimers, no fluff.

Event: ${event.title}
Country: ${event.country}
Impact: ${event.impact}
Forecast: ${event.forecast || "N/A"}
Previous: ${event.previous || "N/A"}
Time (event feed, ET): ${event.date}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );
  const data = await res.json();
  return (
    data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    "AI analysis unavailable for this event."
  );
}

function formatTimeET(dateStr) {
  // Feed times are ET (US Eastern). Just display as-is plus a note; adjust to your timezone if needed.
  const d = new Date(dateStr);
  return d.toLocaleString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

async function sendNtfyMessage({ title, message, priority, tags }) {
  const url = `https://ntfy.sh/${NTFY_TOPIC}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: title,
      Priority: String(priority),
      Tags: tags,
    },
    body: message,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ntfy send failed: ${err}`);
  }
}

function impactMeta(impact) {
  // ntfy priority: 1 (min) to 5 (urgent). High impact = urgent push, Medium = default.
  return impact === "High"
    ? { emoji: "🔴", priority: 5, tags: "rotating_light,chart_with_downwards_trend" }
    : { emoji: "🟠", priority: 3, tags: "warning" };
}

async function main() {
  if (!NTFY_TOPIC || !GEMINI_API_KEY) {
    throw new Error("Missing env vars. Need NTFY_TOPIC, GEMINI_API_KEY.");
  }

  const allEvents = await fetchCalendar();
  const todaysEvents = filterTodaysRelevantEvents(allEvents);

  if (todaysEvents.length === 0) {
    console.log("No relevant crypto-moving events today. Skipping notifications.");
    return;
  }

  // One push notification per event — easier to read on a lock screen than one giant digest.
  for (const event of todaysEvents) {
    const analysis = await getAiAnalysis(event);
    const meta = impactMeta(event.impact);

    const title = `${meta.emoji} ${event.title} (${event.country}) — ${formatTimeET(event.date)}`;
    const message = `Forecast: ${event.forecast || "N/A"} | Previous: ${event.previous || "N/A"}\n\n${analysis}`;

    await sendNtfyMessage({ title, message, priority: meta.priority, tags: meta.tags });
  }

  console.log(`Sent ${todaysEvents.length} push notifications via ntfy.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
