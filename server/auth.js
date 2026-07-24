import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN_FILE = path.join(process.cwd(), 'data', 'device-token.secret');
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
export const DEVICE_TOKEN = TOKEN;

// Small in-memory brute-force guard. This box is reachable from the whole
// internet and the token is the only gate in front of shell-equivalent
// access, so wrong tokens get penalized instead of just rejected.
const failures = new Map(); // ip -> { count, bannedUntil }
const MAX_FAILURES = 5;
const BAN_MS = 15 * 60 * 1000;

export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isBanned(ip) {
  const rec = failures.get(ip);
  return !!(rec && rec.bannedUntil && rec.bannedUntil > Date.now());
}

export function recordFailure(ip) {
  const rec = failures.get(ip) || { count: 0, bannedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) {
    rec.bannedUntil = Date.now() + BAN_MS;
    rec.count = 0;
  }
  failures.set(ip, rec);
}

export function recordSuccess(ip) {
  failures.delete(ip);
}

export function checkToken(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  return timingSafeEqual(candidate, TOKEN);
}

export function requireAuth(req, res, next) {
  const ip = req.ip;
  if (isBanned(ip)) {
    return res.status(429).json({ error: 'too many attempts' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!checkToken(token)) {
    recordFailure(ip);
    // Never log the token itself — length/prefix is enough to tell
    // "missing header" apart from "wrong value" without exposing the secret.
    console.error(
      `[auth] rejected ${req.method} ${req.path} from ${ip}: ` +
      `${token ? `len=${token.length} prefix=${token.slice(0, 4)}…` : 'no token'} (expected len=${TOKEN.length})`
    );
    return res.status(401).json({ error: 'unauthorized' });
  }
  recordSuccess(ip);
  next();
}
