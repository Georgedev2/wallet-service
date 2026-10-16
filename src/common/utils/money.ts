import { DomainError } from '../errors/domain.error';

// Positive integer, no leading zeros, at most 16 digits (fits BIGINT with room to spare).
const AMOUNT_PATTERN = /^[1-9]\d{0,15}$/;

/** Parses an API amount (a string of kobo digits, e.g. "150000") into bigint. */
export function parseAmount(value: string): bigint {
  if (typeof value !== 'string' || !AMOUNT_PATTERN.test(value)) {
    throw new DomainError(
      'INVALID_AMOUNT',
      'Amount must be a positive whole number of kobo, as a string of up to 16 digits',
      400,
    );
  }
  return BigInt(value);
}

/** Formats kobo as naira with two decimals: 150000n -> "1500.00". */
export function formatKobo(kobo: bigint): string {
  const sign = kobo < 0n ? '-' : '';
  const abs = kobo < 0n ? -kobo : kobo;
  const naira = abs / 100n;
  const remainder = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${naira}.${remainder}`;
}
