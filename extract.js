const puppeteer = require('puppeteer');

/**
 * Parses all NPL live streams from yonotv
 */
async function parseNplStreams() {
  const targetUrl = 'https://yonotv.pages.dev/LINK';
  const streams = [];

  try {
    const res = await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const html = await res.text();
      const regex = /(NPL\w*)\s*:\s*["']([^"']+)["']/gi;
      let match;
      while ((match = regex.exec(html)) !== null) {
        const key = match[1];
        let url = match[2];
        const srcMatch = url.match(/src=([^&"']+)/i);
        if (srcMatch && srcMatch[1]) {
          url = decodeURIComponent(srcMatch[1]);
        }
        if (url.startsWith('http') && url.includes('.m3u8')) {
          const isRumble = url.includes('rumble');
          const isNetTv = url.includes('nettvstreamz');
          streams.push({
            key,
            url,
            provider: isRumble ? 'Rumble Cloud HD' : isNetTv ? 'NetTV Action Sports HD' : 'HLS Live Feed',
            isRumble,
            isNetTv,
          });
        }
      }
    }
  } catch (err) {
    console.error('Error fetching yonotv channel map:', err.message);
  }

  return streams;
}

/**
 * Extract live stream URL for a given match ID with Rumble & NetTV support
 */
async function getLiveStreamUrl(matchId) {
  console.log(`Resolving stream for match identifier: ${matchId}...`);

  // 1. Fast Channel Map Extraction
  const allStreams = await parseNplStreams();

  if (allStreams.length > 0) {
    // Check if there is an exact or related key match (e.g. NPL2 matches NPL2 or NPL22)
    const normalized = String(matchId || '').toUpperCase().trim();
    const numMatch = normalized.match(/\d+/);
    const num = numMatch ? numMatch[0] : null;

    let candidate = allStreams.find((s) => s.key.toUpperCase() === normalized);
    if (!candidate && num) {
      candidate = allStreams.find(
        (s) => s.key.toUpperCase() === `NPL${num}${num}` || s.key.toUpperCase() === `NPL${num}`
      );
    }

    // If specific match candidate found, return its stream
    if (candidate) {
      console.log(`Matched stream [${candidate.key}] (${candidate.provider}): ${candidate.url}`);
      return candidate.url;
    }

    // Otherwise, prefer Rumble or NetTV from active NPL feeds
    const rumbleStream = allStreams.find((s) => s.isRumble);
    if (rumbleStream) {
      console.log(`Active Rumble stream found [${rumbleStream.key}]: ${rumbleStream.url}`);
      return rumbleStream.url;
    }

    const netTvStream = allStreams.find((s) => s.isNetTv);
    if (netTvStream) {
      console.log(`Active NetTV stream found [${netTvStream.key}]: ${netTvStream.url}`);
      return netTvStream.url;
    }

    console.log(`Using first available NPL stream: ${allStreams[0].url}`);
    return allStreams[0].url;
  }

  // 2. Puppeteer Sniffing Fallback
  const targetUrl = `https://yonotv.pages.dev/LINK?id=${matchId}`;
  console.log(`Starting headless browser fallback for: ${targetUrl}...`);
  let browser = null;
  let m3u8Url = null;

  try {
    const launchOptions = {
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('.m3u8')) {
        m3u8Url = url;
      }
      request.continue();
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
  } catch (error) {
    console.error('Puppeteer load timed out or failed:', error.message);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return m3u8Url;
}

module.exports = { getLiveStreamUrl, parseNplStreams };

// Run standalone test if executed directly
if (require.main === module) {
  getLiveStreamUrl('NPL2').then((url) => {
    console.log('\nResult for NPL2:', url);
  });
}
