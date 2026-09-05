// crypto-news-bot: Forex Factory economic calendar -> AI analysis -> ntfy push notification
// Personal use script. Sends TWO notifications per relevant event:
//   1) "Upcoming" — when the event is within WINDOW_HOURS of releasing (forecast/previous + AI take)
//   2) "Actual out" — once the real number is published (actual vs forecast + AI reaction)
// Designed to run on a schedule (e.g. every 3 hours via GitHub Actions).

import fs from "node:fs";

const FF_FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const STATE_FILE = "state.json";

// Currencies/regions whose data reliably moves crypto (via USD liquidity / risk sentiment).
// Edit this list to taste.
const RELEVANT_CURRENCIES = ["USD", "CNY", "EUR"];

// Only alert on Medium/High impact. Low-impact prints are noise.
const RELEVANT_IMPACT = ["Medium", "High"];

// How far ahead to look for "upcoming" events, in hours. Keep this matched to your cron
// frequency (e.g. every 3 hours -> 3 here) so each event's "upcoming" alert fires once.
const WINDOW_HOURS = 3;

// How long to keep an event's ID in state.json after it happened, in hours. Just keeps the
// file from growing forever — has no effect on notification behavior.
const STATE_RETENTION_HOURS = 48;

const NTFY_TOPIC = process.env.NTFY_TOPIC; // the random topic name you picked in the ntfy app
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function eventId(e) {
  return `${e.country}|${e.title}|${e.date}`;
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      before: parsed.before || {},
      after: parsed.after || {},
    };
  } catch {
    // No file yet, or unreadable — start fresh. Normal on the very first run.
    return { before: {}, after: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function pruneState(state) {
  const cutoff = Date.now() - STATE_RETENTION_HOURS * 60 * 60 * 1000;
  for (const bucket of [state.before, state.after]) {
    for (const [id, dateStr] of Object.entries(bucket)) {
      if (new Date(dateStr).getTime() < cutoff) delete bucket[id];
    }
  }
}

async function fetchCalendar() {
  const res = await fetch(FF_FEED_URL);
  if (!res.ok) throw new Error(`Failed to fetch calendar: ${res.status}`);
  return res.json();
}

function isRelevant(e) {
  return RELEVANT_CURRENCIES.includes(e.country) && RELEVANT_IMPACT.includes(e.impact);
}

function hasActual(e) {
  return e.actual !== undefined && e.actual !== null && String(e.actual).trim() !== "";
}

async function callGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
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

async function getPreEventAnalysis(event) {
  return callGemini(`You are a crypto market analyst. In 2-3 short sentences, explain how this upcoming
economic event typically affects crypto prices (BTC/majors) and why. Be concrete about direction/mechanism
(e.g. "higher than forecast CPI -> hawkish Fed expectations -> risk-off -> BTC downside pressure"). No
disclaimers, no fluff.

Event: ${event.title}
Country: ${event.country}
Impact: ${event.impact}
Forecast: ${event.forecast || "N/A"}
Previous: ${event.previous || "N/A"}`);
}

async function getPostEventAnalysis(event) {
  return callGemini(`You are a crypto market analyst. This economic event was JUST released. In 2-3 short
sentences, react to the actual result versus forecast/previous and explain the likely directional impact
on crypto (BTC/majors) right now. Be concrete about mechanism. No disclaimers, no fluff.

Event: ${event.title}
Country: ${event.country}
Impact: ${event.impact}
Actual: ${event.actual}
Forecast: ${event.forecast || "N/A"}
Previous: ${event.previous || "N/A"}`);
}

function formatTimeSL(dateStr) {
  // Converts the event's absolute UTC instant to Sri Lanka time (UTC+5:30, no DST).
  // Built manually (not via toLocaleString) to guarantee plain ASCII output — locale
  // formatting can silently insert Unicode spacing characters that break HTTP headers.
  const d = new Date(dateStr);
  const totalMinutesUTC = d.getUTCHours() * 60 + d.getUTCMinutes();
  const SL_OFFSET_MINUTES = 5 * 60 + 30;
  const wrapped = (((totalMinutesUTC + SL_OFFSET_MINUTES) % 1440) + 1440) % 1440;
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

  const state = loadState();
  pruneState(state);

  const allEvents = (await fetchCalendar()).filter(isRelevant);
  const now = new Date();
  const windowEnd = new Date(now.getTime() + WINDOW_HOURS * 60 * 60 * 1000);

  const upcoming = allEvents.filter((e) => {
    const t = new Date(e.date);
    return t >= now && t < windowEnd && !state.before[eventId(e)];
  });

  const justReleased = allEvents.filter((e) => {
    const t = new Date(e.date);
    return t <= now && hasActual(e) && !state.after[eventId(e)];
  });

  let sentCount = 0;

  for (const event of upcoming) {
    const analysis = await getPreEventAnalysis(event);
    const meta = impactMeta(event.impact);
    const title = `UPCOMING: ${event.title} (${event.country}) - ${formatTimeSL(event.date)}`;
    const message = `${meta.emoji} Impact: ${event.impact}\nForecast: ${event.forecast || "N/A"} | Previous: ${event.previous || "N/A"}\n\n${analysis}`;

    await sendNtfyMessage({ title, message, priority: meta.priority, tags: meta.tags });
    state.before[eventId(event)] = event.date;
    saveState(state); // save immediately so progress isn't lost if a later event fails
    sentCount++;
  }

  for (const event of justReleased) {
    const analysis = await getPostEventAnalysis(event);
    const meta = impactMeta(event.impact);
    const title = `ACTUAL OUT: ${event.title} (${event.country})`;
    const message = `${meta.emoji} Actual: ${event.actual} | Forecast: ${event.forecast || "N/A"} | Previous: ${event.previous || "N/A"}\n\n${analysis}`;

    await sendNtfyMessage({ title, message, priority: meta.priority, tags: meta.tags });
    state.after[eventId(event)] = event.date;
    saveState(state);
    sentCount++;
  }

  if (sentCount === 0) {
    console.log("Nothing new to notify this run (no upcoming events in window, no fresh actuals).");
  } else {
    console.log(`Sent ${sentCount} push notification(s) via ntfy (${upcoming.length} upcoming, ${justReleased.length} actual).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
