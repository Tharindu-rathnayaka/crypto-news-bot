// crypto-news-bot: Forex Factory economic calendar -> AI analysis -> ntfy push notification
// Personal use script. Runs once per invocation (designed for a daily cron via GitHub Actions).

const FF_FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

// Currencies/regions whose data reliably moves crypto (via USD liquidity / risk sentiment).
// Edit this list to taste.
const RELEVANT_CURRENCIES = ["USD", "CNY", "EUR"];

// Only alert on Medium/High impact. Low-impact prints are noise.
const RELEVANT_IMPACT = ["Medium", "High"];

// How far ahead to look for events, in hours. Keep this matched to your cron frequency
// (e.g. if the workflow runs every 3 hours, use 3 here) so each event is only picked up
// by one run and you don't get the same notification repeated on every run.
const WINDOW_HOURS = 3;

const NTFY_TOPIC = process.env.NTFY_TOPIC; // the random topic name you picked in the ntfy app
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function fetchCalendar() {
  const res = await fetch(FF_FEED_URL);
  if (!res.ok) throw new Error(`Failed to fetch calendar: ${res.status}`);
  return res.json();
}

function filterUpcomingRelevantEvents(events) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + WINDOW_HOURS * 60 * 60 * 1000);

  return events.filter((e) => {
    const eventTime = new Date(e.date);
    const isUpcoming = eventTime >= now && eventTime < windowEnd;
    const relevantCurrency = RELEVANT_CURRENCIES.includes(e.country);
    const relevantImpact = RELEVANT_IMPACT.includes(e.impact);
    return isUpcoming && relevantCurrency && relevantImpact;
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
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    // Log the full raw response so the real reason (bad key, quota, blocked model, etc.)
    // shows up in the GitHub Actions log instead of a silent generic fallback.
    console.error("Gemini API did not return text. Raw response:", JSON.stringify(data));
    return "AI analysis unavailable for this event.";
  }
  return text;
}

function formatTimeSL(dateStr) {
  // Converts the event's absolute UTC instant to Sri Lanka time (UTC+5:30, no DST).
  // Built manually (not via toLocaleString) to guarantee plain ASCII output — locale
  // formatting can silently insert Unicode spacing characters that break HTTP headers.
  const d = new Date(dateStr);
  const totalMinutesUTC = d.getUTCHours() * 60 + d.getUTCMinutes();
  const SL_OFFSET_MINUTES = 5 * 60 + 30;
  const wrapped = ((totalMinutesUTC + SL_OFFSET_MINUTES) % 1440 + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${ampm} SL`;
}

function toAsciiSafeHeader(str) {
  // HTTP headers must be plain ASCII (ByteString). Strip anything outside that range
  // so unexpected characters from the data feed can never crash the request again.
  return String(str).replace(/[^\x00-\xFF]/g, "");
}

async function sendNtfyMessage({ title, message, priority, tags }) {
  const url = `https://ntfy.sh/${NTFY_TOPIC}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: toAsciiSafeHeader(title),
      Priority: String(priority),
      Tags: toAsciiSafeHeader(tags),
    },
    body: message, // body can safely contain emoji / any UTF-8 text
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
  const upcomingEvents = filterUpcomingRelevantEvents(allEvents);

  if (upcomingEvents.length === 0) {
    console.log(`No relevant crypto-moving events in the next ${WINDOW_HOURS}h. Skipping notifications.`);
    return;
  }

  // One push notification per event — easier to read on a lock screen than one giant digest.
  for (const event of upcomingEvents) {
    const analysis = await getAiAnalysis(event);
    const meta = impactMeta(event.impact);

    // Note: ntfy headers (Title, Tags) must be plain ASCII — emoji go in the body instead,
    // where they render fine, since HTTP header values can't contain non-ASCII characters.
    const title = `${event.title} (${event.country}) - ${formatTimeSL(event.date)}`;
    const message = `${meta.emoji} Impact: ${event.impact}\nForecast: ${event.forecast || "N/A"} | Previous: ${event.previous || "N/A"}\n\n${analysis}`;

    await sendNtfyMessage({ title, message, priority: meta.priority, tags: meta.tags });
  }

  console.log(`Sent ${upcomingEvents.length} push notifications via ntfy.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
