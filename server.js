const path = require("path");
const express = require("express");
const cors = require("cors");
const NodeCache = require("node-cache");
const scoreService = require("./scoreService");
const pushService = require("./pushService");

let extractor = null;
try {
  extractor = require("./extract");
} catch (err) {
  console.log("Extractor module not loaded:", err.message);
}

const app = express();
const port = process.env.PORT || 3000;

const cache = new NodeCache({
  stdTTL: 1800,
  checkperiod: 120,
  useClones: false,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


const NPL_CANDIDATES = [
  "NPL1",
  "NPL2",
  "NPL3",
  "NPL4",
  "NPL5",
  "NPL6",
  "NPL7",
  "NPL8",
  "NPL9",
  "NPL10",
];

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * Auto-discovery endpoint: Silently tests NPL1 through NPL10 in background
 * until it finds an active stream, then caches it for 30 minutes and returns it.
 */
app.get("/api/stream/auto", async (req, res) => {
  const cacheKey = "stream:auto";
  const cached = cache.get(cacheKey);

  if (cached) {
    return res.json({
      id: cached.id,
      url: cached.url,
      cached: true,
    });
  }

  console.log("Auto-scanning NPL1 through NPL10 for active video feed...");

  for (const id of NPL_CANDIDATES) {
    try {
      const streamUrl = await getAuthorizedStreamUrl(id);

      if (
        streamUrl &&
        typeof streamUrl === "string" &&
        streamUrl.startsWith("https://") &&
        streamUrl.includes(".m3u8")
      ) {
        // Verify stream URL actually responds with HTTP 200
        const check = await fetch(streamUrl, {
          method: "HEAD",
          signal: AbortSignal.timeout(3000),
        }).catch(() => null);

        if (check && (check.ok || check.status === 200 || check.status === 206)) {
          console.log(`Active live stream confirmed on ${id}: ${streamUrl}`);
          const payload = { id, url: streamUrl };
          cache.set(cacheKey, payload, 1800); // 30 mins
          return res.json({ ...payload, cached: false });
        }
      }
    } catch (err) {
      console.log(`Candidate ${id} resolution skipped:`, err.message);
    }
  }

  return res.status(404).json({
    error: "No live matches found right now.",
  });
});

app.get("/api/stream", async (req, res) => {
  const { id } = req.query;

  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({
      error: "A valid match ID is required.",
    });
  }

  const cacheKey = `stream:${id}`;
  const cachedUrl = cache.get(cacheKey);

  if (cachedUrl) {
    return res.json({
      id,
      url: cachedUrl,
      cached: true,
    });
  }

  try {
    const streamUrl = await getAuthorizedStreamUrl(id);

    if (!streamUrl) {
      return res.status(404).json({
        error: "No authorized stream is currently available.",
      });
    }

    const parsedUrl = new URL(streamUrl);

    if (
      parsedUrl.protocol !== "https:" ||
      !parsedUrl.pathname.toLowerCase().endsWith(".m3u8")
    ) {
      return res.status(502).json({
        error: "The provider returned an invalid HLS URL.",
      });
    }

    cache.set(cacheKey, streamUrl);

    return res.json({
      id,
      url: streamUrl,
      cached: false,
    });
  } catch (error) {
    console.error("Stream lookup failed:", error.message);

    return res.status(502).json({
      error: "Unable to retrieve the authorized stream.",
    });
  }
});

async function getAuthorizedStreamUrl(matchId) {
  const providerApiUrl = process.env.STREAM_PROVIDER_API_URL;
  const providerApiKey = process.env.STREAM_PROVIDER_API_KEY;

  if (providerApiUrl) {
    const endpoint = new URL(providerApiUrl);
    endpoint.searchParams.set("id", matchId);

    const response = await fetch(endpoint, {
      headers: providerApiKey
        ? { Authorization: `Bearer ${providerApiKey}` }
        : {},
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Provider returned HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.url || null;
  }

  if (extractor && typeof extractor.getLiveStreamUrl === "function") {
    return await extractor.getLiveStreamUrl(matchId);
  }

  throw new Error("Streaming provider integration is not configured.");
}

/**
 * Server-Sent Events (SSE) stream for real-time score updates and 4s, 6s, wicket alerts
 */
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  scoreService.addSSEClient(res);

  req.on("close", () => {
    scoreService.removeSSEClient(res);
  });
});

/**
 * REST endpoint for live score & recent events history
 */
app.get("/api/score/live", (req, res) => {
  res.json({
    score: scoreService.currentScore,
    events: scoreService.recentEvents,
  });
});

/**
 * Web Push Endpoints
 */
app.get("/api/push/public-key", (req, res) => {
  res.json({ publicKey: pushService.getPublicKey() });
});

app.post("/api/push/subscribe", (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription payload" });
  }
  pushService.addSubscription(subscription);
  res.status(201).json({ success: true, message: "Subscribed to Web Push" });
});

app.post("/api/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) {
    pushService.removeSubscription(endpoint);
  }
  res.json({ success: true });
});

/**
 * Test endpoint to manually trigger a 4, 6, or Wicket notification
 */
app.post("/api/test-notification", (req, res) => {
  const type = (req.query.type || "FOUR").toUpperCase();
  let title = "🏏 FOUR! (4 Runs)";
  let message = "Test: Beautiful boundary through the covers!";
  if (type === "SIX") {
    title = "🚀 MAXIMUM SIX! (6 Runs)";
    message = "Test: Towering maximum over long on!";
  } else if (type === "WICKET") {
    title = "💥 WICKET FALLEN!";
    message = "Test: Out! Clean bowled by the bowler!";
  }

  const ev = {
    id: Date.now(),
    type,
    title,
    message,
    score: scoreService.currentScore ? scoreService.currentScore.score : "78-3",
    overs: scoreService.currentScore ? scoreService.currentScore.overs : "10.4",
    time: new Date().toLocaleTimeString("en-US", { hour12: false }),
  };

  scoreService.broadcast({ type: "notification", data: ev });
  pushService.sendToAll(ev).catch((err) => console.warn('[PushService] test error:', err.message));
  res.json({ success: true, event: ev });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Sportivo NPL Server running on port ${port}`);
  scoreService.start();
});
