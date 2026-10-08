import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { config } from '../config.ts';

const PREFIX = 'enc:v1:';
let key: Buffer | null = null;

function getKey(): Buffer {
  if (!config.encryptionKey || config.encryptionKey.startsWith('troque-por')) {
    throw new Error('Defina ENCRYPTION_KEY no arquivo .env antes de cadastrar contas.');
  }
  return (key ??= scryptSync(config.encryptionKey, 'coldmail-engine', 32));
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join(':');
}

export function decrypt(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const [iv, tag, data] = stored
    .slice(PREFIX.length)
    .split(':')
    .map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
