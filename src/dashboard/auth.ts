import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Hash both credentials to fixed lengths before comparing; never echo credentials. */
export function authorizeDashboard(req: IncomingMessage, res: ServerResponse): boolean {
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;
  if (!username || !password) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Dashboard authentication unavailable' }));
    return false;
  }
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.authorization || '');
  const decoded = match ? Buffer.from(match[1], 'base64').toString('utf8') : '';
  const colon = decoded.indexOf(':');
  const userValid = timingSafeEqual(digest(decoded.slice(0, colon)), digest(username));
  const passwordValid = timingSafeEqual(digest(decoded.slice(colon + 1)), digest(password));
  if (match && colon >= 0 && userValid && passwordValid) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ColdMail Dashboard", charset="UTF-8"', 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Authentication required' }));
  return false;
}

export function validRequestOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // Local API clients do not send Origin.
  try {
    const source = new URL(origin);
    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    return source.origin === `${protocol}//${req.headers.host}`;
  } catch { return false; }
}
