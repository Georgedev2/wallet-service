import { randomBytes } from 'crypto';

/** Public transaction reference, e.g. "FND-9F2C4A1B7E3D5C60". 64 random bits. */
export function generateReference(prefix: 'FND' | 'TRF'): string {
  return `${prefix}-${randomBytes(8).toString('hex').toUpperCase()}`;
}
