import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { store } from './store.js';

const VAPID_FILE = path.join(process.cwd(), 'data', 'vapid-keys.json');
const vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));

webpush.setVapidDetails(
  'mailto:cansyland@gmail.com',
  vapid.publicKey,
  vapid.privateKey
);

export const VAPID_PUBLIC_KEY = vapid.publicKey;

export async function sendPush(payload) {
  const sub = store.getPushSubscription();
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      // Subscription expired/revoked on Apple's push service.
      store.setPushSubscription(null);
    } else {
      console.error('push failed:', err.statusCode, err.body || err.message);
    }
  }
}
