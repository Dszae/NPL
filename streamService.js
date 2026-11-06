const NodeCache = require('node-cache');

/**
 * StreamService - High-Availability Live Video Stream Registry & Health Prober
 * Dynamically ingests, validates, caches, and selects active live feeds.
 */
class StreamService {
  constructor() {
    this.cache = new NodeCache({ stdTTL: 900, checkperiod: 120, useClones: false }); // 15 mins TTL
    this.directoryUrl = process.env.STREAM_DIRECTORY_URL || 'https://yonotv.pages.dev/LINK';
  }

  normalizeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    let normalized = url.trim();

    const srcMatch = normalized.match(/[?&]src=([^&"']+)/i);
    if (srcMatch && srcMatch[1]) {
      normalized = decodeURIComponent(srcMatch[1]);
    }

    if (normalized.includes('_DVR.m3u8')) {
      normalized = normalized.replace('_DVR.m3u8', '.m3u8');
    }

    return normalized;
  }

  async isStreamAlive(url) {
    if (!url) return false;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      const res = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
        },
      });

      clearTimeout(timeoutId);
      return res.ok || res.status === 200 || res.status === 206;
    } catch {
      return false;
    }
  }

  async ingestCandidateFeeds() {
    const feeds = [];

    // 1. NetTV Unencrypted 1080p DASH Cluster (Zero-Delay Real-Time Live Edge)
    feeds.push({
      id: 'NETTV-DASH-EDGE3',
      name: 'NetTV Edge 03 (1080p Zero Lag)',
      url: 'https://ott-edge-mtdc03.nettv.com.np/npl/live_match/index.mpd',
      type: 'dash',
      isEmbed: false,
      priority: 1,
    });

    feeds.push({
      id: 'NETTV-DASH-EDGE1',
      name: 'NetTV Edge 01 (1080p Direct)',
      url: 'https://ott-edge-mtdc01.nettv.com.np/npl/live_match/index.mpd',
      type: 'dash',
      isEmbed: false,
      priority: 2,
    });

    feeds.push({
      id: 'NETTV-DASH-EDGE2',
      name: 'NetTV Edge 02 (1080p Direct)',
      url: 'https://ott-edge-mtdc02.nettv.com.np/npl/live_match/index.mpd',
      type: 'dash',
      isEmbed: false,
      priority: 3,
    });

    feeds.push({
      id: 'NETTV-DASH-EDGE4',
      name: 'NetTV Edge 04 (1080p Direct)',
      url: 'https://ott-edge-mtdc04.nettv.com.np/npl/live_match/index.mpd',
      type: 'dash',
      isEmbed: false,
      priority: 4,
    });

    feeds.push({
      id: 'NETTV-DASH-LB',
      name: 'NetTV Master Load Balancer',
      url: 'https://ott-lb.nettv.com.np/npl/live_match/index.mpd',
      type: 'dash',
      isEmbed: false,
      priority: 5,
    });

    // 2. Secondary Web Embed Mirrors (Strictly fallback if all direct nodes offline)
    feeds.push({
      id: 'FC2-NPL',
      name: 'FanCode NPL Event 2',
      url: 'https://yonotv.pages.dev/LINK?id=FC2',
      type: 'embed',
      isEmbed: true,
      priority: 50,
    });

    feeds.push({
      id: 'FC3-NPL',
      name: 'FanCode NPL Event 3',
      url: 'https://yonotv.pages.dev/LINK?id=FC3',
      type: 'embed',
      isEmbed: true,
      priority: 51,
    });

    feeds.push({
      id: 'NP4-NEPALCRIC',
      name: 'Nepal Cricket TU Ground Feed',
      url: 'https://yonotv.pages.dev/LINK?id=NP4',
      type: 'embed',
      isEmbed: true,
      priority: 99,
    });

    try {
      const res = await fetch(this.directoryUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const text = await res.text();
        const channelsMatch = text.match(/const channels = \{([\s\S]*?)\};/);

        if (channelsMatch && channelsMatch[1]) {
          const body = channelsMatch[1];
          const lineRegex = /([A-Za-z0-9_-]+)\s*:\s*["']([^"']+)["']/g;
          let m;

          while ((m = lineRegex.exec(body)) !== null) {
            const key = m[1].toUpperCase();
            let rawUrl = m[2];

            if (key === 'NP4' || key === 'NEP1' || key === 'NPL' || key === 'FC2' || key === 'FC3') {
              const streamUrl = this.normalizeUrl(rawUrl);
              const isDirectMedia = streamUrl.includes('.m3u8') || streamUrl.includes('.mpd');

              feeds.push({
                id: `FEED-${key}`,
                name: key.includes('NP') ? 'Nepal Cricket Stream' : `Channel ${key}`,
                url: isDirectMedia ? streamUrl : rawUrl,
                isEmbed: !isDirectMedia || rawUrl.includes('plyrr') || rawUrl.includes('pages.dev'),
                priority: isDirectMedia ? 10 : 99,
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn('[StreamService] Directory ingestion notice:', err.message);
    }

    return feeds;
  }

  async getAutoStream() {
    const cacheKey = 'stream:auto:active';
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    console.log('[StreamService] Probing dedicated NPL feeds...');
    const candidates = await this.ingestCandidateFeeds();
    candidates.sort((a, b) => a.priority - b.priority);

    for (const feed of candidates) {
      const alive = await this.isStreamAlive(feed.url);
      if (alive) {
        console.log(`[StreamService] Active NPL feed selected [${feed.id}]: ${feed.url}`);
        const payload = {
          id: feed.id,
          name: feed.name,
          url: feed.url,
          type: feed.type || (feed.url.includes('.mpd') ? 'dash' : (feed.isEmbed ? 'embed' : 'hls')),
          isEmbed: feed.isEmbed,
        };
        this.cache.set(cacheKey, payload, 900);
        return { ...payload, cached: false };
      }
    }

    const fallback = {
      id: 'NETTV-DASH-EDGE3',
      name: 'NetTV Edge 03 (1080p Zero Lag)',
      url: 'https://ott-edge-mtdc03.nettv.com.np/npl/live_match/index.mpd',
      type: 'dash',
      isEmbed: false,
      cached: false,
    };
    return fallback;
  }

  async getAllActiveStreams() {
    const candidates = await this.ingestCandidateFeeds();
    const verified = [];

    await Promise.allSettled(
      candidates.map(async (feed) => {
        const alive = await this.isStreamAlive(feed.url);
        if (alive) {
          verified.push({
            id: feed.id,
            name: feed.name,
            url: feed.url,
            type: feed.type || (feed.url.includes('.mpd') ? 'dash' : (feed.isEmbed ? 'embed' : 'hls')),
            isEmbed: feed.isEmbed,
            status: 'online',
          });
        }
      })
    );

    return verified;
  }
}

module.exports = new StreamService();

