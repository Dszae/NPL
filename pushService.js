const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

// Load VAPID credentials strictly from environment variables or persistent local config (.vapid.json)
// NEVER hardcode secrets or private keys into source control!
const VAPID_KEY_FILE = path.join(__dirname, '.vapid.json');

let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  if (fs.existsSync(VAPID_KEY_FILE)) {
    try {
      vapidKeys = JSON.parse(fs.readFileSync(VAPID_KEY_FILE, 'utf-8'));
    } catch (e) {
      console.warn('[PushService] Could not parse .vapid.json:', e.message);
    }
  }
}

// If still not configured, dynamically generate a fresh key pair at runtime
if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  vapidKeys = webpush.generateVAPIDKeys();
  try {
    fs.writeFileSync(VAPID_KEY_FILE, JSON.stringify(vapidKeys, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[PushService] Could not write .vapid.json:', err.message);
  }
}

const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:dsz.ae18@gmail.com';

webpush.setVapidDetails(VAPID_EMAIL, vapidKeys.publicKey, vapidKeys.privateKey);

const SUB_FILE = path.join(__dirname, 'subscriptions.json');

class PushService {
  constructor() {
    this.subscriptions = this.loadSubscriptions();
  }

  loadSubscriptions() {
    try {
      if (fs.existsSync(SUB_FILE)) {
        const raw = fs.readFileSync(SUB_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return list;
      }
    } catch (err) {
      console.warn('[PushService] Error reading subscriptions file:', err.message);
    }
    return [];
  }

  saveSubscriptions() {
    try {
      fs.writeFileSync(SUB_FILE, JSON.stringify(this.subscriptions, null, 2), 'utf-8');
    } catch (err) {
      console.error('[PushService] Failed saving subscriptions:', err.message);
    }
  }

  getPublicKey() {
    return vapidKeys.publicKey;
  }

  addSubscription(sub) {
    if (!sub || !sub.endpoint) return;
    const existingIdx = this.subscriptions.findIndex((s) => s.endpoint === sub.endpoint);
    if (existingIdx !== -1) {
      this.subscriptions[existingIdx] = sub;
    } else {
      this.subscriptions.push(sub);
      console.log(`[PushService] New push subscriber added (Total: ${this.subscriptions.length})`);
    }
    this.saveSubscriptions();
  }

  removeSubscription(endpoint) {
    const prevLen = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.subscriptions.length !== prevLen) {
      console.log(`[PushService] Subscriber removed (Total: ${this.subscriptions.length})`);
      this.saveSubscriptions();
    }
  }

  async sendToAll(eventData) {
    if (this.subscriptions.length === 0) return;

    const payload = JSON.stringify({
      title: eventData.title || '🏏 Sportivo Cricket Alert',
      message: eventData.message || 'Match score update!',
      type: eventData.type || 'INFO',
      score: eventData.score || '',
      overs: eventData.overs || '',
      ball: eventData.ball || '',
      tag: 'sportivo-alert-' + (eventData.ball || Date.now()),
      url: 'https://sportivo-npl.vercel.app/',
    });

    console.log(`[PushService] Broadcasting Web Push to ${this.subscriptions.length} registered device(s)...`);

    const badEndpoints = [];

    await Promise.allSettled(
      this.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload, {
            TTL: 60, // 60 seconds delivery window
            urgency: 'high',
          });
        } catch (err) {
          // If subscription has expired or unsubscribed (HTTP 410 or 404)
          if (err.statusCode === 410 || err.statusCode === 404) {
            badEndpoints.push(sub.endpoint);
          } else {
            console.warn('[PushService] Send error to device:', err.message);
          }
        }
      })
    );

    // Prune dead subscriptions
    if (badEndpoints.length > 0) {
      this.subscriptions = this.subscriptions.filter((s) => !badEndpoints.includes(s.endpoint));
      this.saveSubscriptions();
      console.log(`[PushService] Pruned ${badEndpoints.length} expired subscriptions.`);
    }
  }
}

module.exports = new PushService();

