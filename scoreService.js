const EventEmitter = require('events');

class ScoreService extends EventEmitter {
  constructor() {
    super();
    this.currentScore = null;
    this.recentEvents = [];
    this.sseClients = new Set();
    this.cachedMatchUrl = null;
    this.lastUrlCheck = 0;
    this.knownBallIds = new Set();
    this.initialized = false;
    this.pollingInterval = null;
  }

  async discoverMatchUrl() {
    const now = Date.now();
    if (this.cachedMatchUrl && now - this.lastUrlCheck < 300000) {
      return this.cachedMatchUrl;
    }

    try {
      const listUrl = 'https://crex.com/fixtures/match-list';
      const res = await fetch(listUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const text = await res.text();
        const matchRegex = /"https:\/\/crex\.com\/cricket-live-score\/([^"]*(?:nepal|npl|pka|spr|ktg|cwr|btr|jkb|kry|lbl)[^"]*)"/gi;
        const matches = [];
        let m;
        while ((m = matchRegex.exec(text)) !== null) {
          matches.push(m[1]);
        }
        if (matches.length > 0) {
          this.cachedMatchUrl = `https://crex.com/cricket-live-score/${matches[0]}`;
          this.lastUrlCheck = now;
          console.log(`[ScoreService] Discovered live NPL match: ${this.cachedMatchUrl}`);
          return this.cachedMatchUrl;
        }
      }
    } catch (err) {
      console.warn('[ScoreService] Match discovery failed:', err.message);
    }

    // Fallback to active fixture
    return this.cachedMatchUrl || 'https://crex.com/cricket-live-score/pka-vs-spr-4th-t20-nepal-premier-league-2026-match-updates-14EV';
  }

  async poll() {
    try {
      const matchUrl = await this.discoverMatchUrl();
      const res = await fetch(matchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) return;

      const text = await res.text();
      const match = text.match(/<script id="app-root-state"[^>]*>([\s\S]*?)<\/script>/i);
      if (!match) return;

      const cleanJson = match[1]
        .replace(/&q;/g, '"')
        .replace(/&s;/g, "'")
        .replace(/&l;/g, '<')
        .replace(/&g;/g, '>');

      const data = JSON.parse(cleanJson);
      const sv3 = data['https://api.goscorer.com/api/v3/getSV3'];
      if (!sv3) return;

      const team1 = sv3.team1 || 'Team 1';
      const team2 = sv3.team2 || 'Team 2';
      const score = sv3.score1 || '0/0';
      const overs = sv3.over1 || '0.0';
      const crr = sv3.crr || '0.00';
      const rrr = sv3.rrr || null;
      const target = sv3.target || null;
      const batsman1 = sv3.pname1 ? `${sv3.pname1} ${sv3.runs1 || 0}* (${sv3.balls1 || 0})` : '';
      const batsman2 = sv3.pname2 ? `${sv3.pname2} ${sv3.runs2 || 0}* (${sv3.balls2 || 0})` : '';
      const bowler = sv3.pname3 ? `${sv3.pname3}` : '';

      // Parse recent overs balls
      const recentOvers = [];
      const incomingEvents = [];

      if (sv3.rb && Array.isArray(sv3.rb)) {
        for (const overObj of sv3.rb) {
          const ballsInOver = [];
          if (overObj.b && Array.isArray(overObj.b)) {
            for (const b of overObj.b) {
              const resCode = String(b.u || '').trim();
              const ballId = `${overObj.o}.${b.d}:${resCode}`;
              const isFour = resCode === '4';
              const isSix = resCode === '6';
              const isWicket = resCode.toLowerCase() === 'w';
              const isWide = resCode.toLowerCase().includes('wd');
              const isNoBall = resCode.toLowerCase().includes('nb');

              ballsInOver.push({
                over: overObj.o,
                ball: b.d,
                result: resCode,
                isFour,
                isSix,
                isWicket,
                isWide,
                isNoBall,
              });

              if (!this.knownBallIds.has(ballId)) {
                this.knownBallIds.add(ballId);

                // If already initialized, dispatch notification event
                if (this.initialized && (isFour || isSix || isWicket)) {
                  let eventType = 'FOUR';
                  let title = '🏏 FOUR! (4 Runs)';
                  let message = `${team1} hit a boundary! Score: ${score} (${overs} ov)`;

                  if (isSix) {
                    eventType = 'SIX';
                    title = '🚀 MAXIMUM SIX! (6 Runs)';
                    message = `${team1} cleared the ropes! Score: ${score} (${overs} ov)`;
                  } else if (isWicket) {
                    eventType = 'WICKET';
                    title = '💥 WICKET FALLEN!';
                    message = `Out! ${team1} loses a wicket! Score: ${score} (${overs} ov)`;
                  }

                  const ev = {
                    id: Date.now() + Math.random(),
                    type: eventType,
                    title,
                    message,
                    score,
                    overs,
                    ball: `${overObj.o}.${b.d}`,
                    time: new Date().toLocaleTimeString('en-US', { hour12: false }),
                  };

                  incomingEvents.push(ev);
                  this.recentEvents.unshift(ev);
                  if (this.recentEvents.length > 25) this.recentEvents.pop();

                  console.log(`[ALERT] ${title} - ${message}`);
                  this.broadcast({ type: 'notification', data: ev });
                }
              }
            }
          }
          recentOvers.push({ over: overObj.o, score: overObj.ts, balls: ballsInOver });
        }
      }

      // Extract live commentary stream
      let commentary = [];
      const ballFeedsKey = Object.keys(data).find((k) => k.includes('getBallFeeds'));
      if (ballFeedsKey && Array.isArray(data[ballFeedsKey])) {
        commentary = data[ballFeedsKey]
          .map((item) => ({
            id: item.id || Date.now() + Math.random(),
            over: item.o || '',
            type: item.type || 'b',
            text: (item.c || '').replace(/<[^>]+>/g, '').trim(),
            score: item.tsl || item.s || '',
            player: item.player || item.n || '',
            isWicket: item.type === 'w',
            time: item.tsl || '',
          }))
          .filter((item) => item.text || item.over)
          .slice(0, 20);
      }

      this.currentScore = {
        team1,
        team2,
        score,
        overs,
        crr,
        rrr,
        target,
        batsman1,
        batsman2,
        bowler,
        recentOvers,
        commentary,
        lastWicket: sv3.lastWicket || '',
        matchStatus: sv3.statusText || sv3.comment1 || 'Match in Progress',
        lastUpdated: Date.now(),
      };

      if (!this.initialized) {
        this.initialized = true;
        console.log(`[ScoreService] Tracking started. Current score: ${team1} ${score} (${overs} ov)`);
      }

      // Broadcast score tick
      this.broadcast({ type: 'score', data: this.currentScore });
    } catch (err) {
      console.warn('[ScoreService] Polling cycle error:', err.message);
    }
  }

  broadcast(messageObj) {
    const payload = `data: ${JSON.stringify(messageObj)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  addSSEClient(res) {
    this.sseClients.add(res);

    // Immediately send current score if available
    if (this.currentScore) {
      res.write(`data: ${JSON.stringify({ type: 'score', data: this.currentScore })}\n\n`);
    }

    // Send recent events
    if (this.recentEvents.length > 0) {
      res.write(`data: ${JSON.stringify({ type: 'history', data: this.recentEvents.slice(0, 5) })}\n\n`);
    }
  }

  removeSSEClient(res) {
    this.sseClients.delete(res);
  }

  start() {
    if (this.pollingInterval) return;
    this.poll();
    this.pollingInterval = setInterval(() => this.poll(), 3500);
    console.log('[ScoreService] Background polling active (every 3.5s).');
  }

  stop() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }
}

module.exports = new ScoreService();

