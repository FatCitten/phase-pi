import { createHash } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

export function nowIso() {
  return new Date().toISOString();
}
