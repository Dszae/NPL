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

    // 1. High-Performance 1080p DASH Feeds (Hardware-accelerated ClearKey Decryption)
    feeds.push({
      id: 'DASH-NEP',
      name: 'Willow / ACC Cricket (1080p)',
      url: 'https://a96aivottlinear-a.akamaihd.net/OTTB/pdx-nitro/live/clients/dash/enc/3qvpw810gz/out/v1/e4b320f9ef924fe59188752dcf9c7fbf/cenc.mpd',
      keyId: '5d52529b6ff19eca2315013244513b68',
      key: 'ba5c7dfad287aab538463d9da6811a8c',
      embedFallbackUrl: 'https://yonotv.pages.dev/wtvplyrrr?manifest=https://a96aivottlinear-a.akamaihd.net/OTTB/pdx-nitro/live/clients/dash/enc/3qvpw810gz/out/v1/e4b320f9ef924fe59188752dcf9c7fbf/cenc.mpd&keyid=5d52529b6ff19eca2315013244513b68&key=ba5c7dfad287aab538463d9da6811a8c',
      type: 'dash',
      isEmbed: false,
      priority: 10,
    });

    feeds.push({
      id: 'DASH-FC2',
      name: 'FanCode (BAN vs WI 1080p)',
      url: 'https://otte.cache.aiv-cdn.net/iad-nitro/live/clients/dash/enc/avqlywnuzx/out/v1/aefca6420f944a9482e117f315de535f/cenc.mpd',
      keyId: '1994b1df7dfd2e8a8d7b9bf3fb900285',
      key: '22a1444b3da18e139191665b3d652835',
      embedFallbackUrl: 'https://yonotv.pages.dev/wtvplyrrr?manifest=https://otte.cache.aiv-cdn.net/iad-nitro/live/clients/dash/enc/avqlywnuzx/out/v1/aefca6420f944a9482e117f315de535f/cenc.mpd&keyid=1994b1df7dfd2e8a8d7b9bf3fb900285&key=22a1444b3da18e139191665b3d652835',
      type: 'dash',
      isEmbed: false,
      priority: 20,
    });

    feeds.push({
      id: 'DASH-FC',
      name: 'FanCode NPL Event 1 (1080p)',
      url: 'https://otte.cache.aiv-cdn.net/iad-nitro/live/clients/dash/enc/b3b3fkmrbl/out/v1/1084d5c9a97a4c5b9f9554c88f486646/cenc.mpd',
      keyId: '82dfca238e8c4b430a3269db71965db9',
      key: 'a00b28caf4ac628e77a553d440c0ddca',
      embedFallbackUrl: 'https://yonotv.pages.dev/wtvplyrrr?manifest=https://otte.cache.aiv-cdn.net/iad-nitro/live/clients/dash/enc/b3b3fkmrbl/out/v1/1084d5c9a97a4c5b9f9554c88f486646/cenc.mpd&keyid=82dfca238e8c4b430a3269db71965db9&key=a00b28caf4ac628e77a553d440c0ddca',
      type: 'dash',
      isEmbed: false,
      priority: 4,
    });

    // 2. High-Availability Shaka & Cloud Embed Fallbacks
    feeds.push({
      id: 'EMBED-SHAKA-MIRROR',
      name: 'FanCode Player Mirror (Embed)',
      url: 'https://yonotv.pages.dev/wtvplyrrr?manifest=https://a96aivottlinear-a.akamaihd.net/OTTB/pdx-nitro/live/clients/dash/enc/3qvpw810gz/out/v1/e4b320f9ef924fe59188752dcf9c7fbf/cenc.mpd&keyid=5d52529b6ff19eca2315013244513b68&key=ba5c7dfad287aab538463d9da6811a8c',
      type: 'embed',
      isEmbed: true,
      priority: 10,
    });

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

            if (key.startsWith('NEP') || key.startsWith('FC')) {
              // Parse potential DASH manifests with ClearKey params
              try {
                const u = new URL(rawUrl);
                const manifest = u.searchParams.get('manifest');
                const keyid = u.searchParams.get('keyid');
                const k = u.searchParams.get('key');
                if (manifest && keyid && k) {
                  feeds.push({
                    id: `DYNAMIC-${key}`,
                    name: `NPL Live Edge (${key})`,
                    url: manifest,
                    keyId: keyid,
                    key: k,
                    embedFallbackUrl: rawUrl,
                    type: 'dash',
                    isEmbed: false,
                    priority: 5,
                  });
                }
              } catch (_) {}
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
          keyId: feed.keyId || null,
          key: feed.key || null,
          embedFallbackUrl: feed.embedFallbackUrl || null,
          type: feed.type || (feed.url.includes('.mpd') ? 'dash' : (feed.isEmbed ? 'embed' : 'hls')),
          isEmbed: feed.isEmbed,
        };
        this.cache.set(cacheKey, payload, 900);
        return { ...payload, cached: false };
      }
    }

    const fallback = {
      id: 'DASH-NEP',
      name: 'NPL Live 1080p HD (Primary)',
      url: 'https://a96aivottlinear-a.akamaihd.net/OTTB/pdx-nitro/live/clients/dash/enc/3qvpw810gz/out/v1/e4b320f9ef924fe59188752dcf9c7fbf/cenc.mpd',
      keyId: '5d52529b6ff19eca2315013244513b68',
      key: 'ba5c7dfad287aab538463d9da6811a8c',
      embedFallbackUrl: 'https://yonotv.pages.dev/wtvplyrrr?manifest=https://a96aivottlinear-a.akamaihd.net/OTTB/pdx-nitro/live/clients/dash/enc/3qvpw810gz/out/v1/e4b320f9ef924fe59188752dcf9c7fbf/cenc.mpd&keyid=5d52529b6ff19eca2315013244513b68&key=ba5c7dfad287aab538463d9da6811a8c',
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

