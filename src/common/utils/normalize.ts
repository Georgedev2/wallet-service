import { isEmail } from 'class-validator';
import { DomainError } from '../errors/domain.error';

export const IDENTITY_TYPES = ['email', 'phone', 'bvn', 'nin'] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const ELEVEN_DIGITS = /^\d{11}$/;

/** Trims and lowercases. Doesn't validate; callers check the format. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Normalises a phone number to E.164, assuming Nigeria (+234) for local numbers:
 * "0803 123 4567" and "2348031234567" both become "+2348031234567".
 */
export function normalizePhone(raw: string): string {
  let phone = raw.trim().replace(/[\s\-().]/g, '');
  if (/^0\d{10}$/.test(phone)) {
    phone = `+234${phone.slice(1)}`;
  } else if (/^234\d{10}$/.test(phone)) {
    phone = `+${phone}`;
  }
  if (!E164_PATTERN.test(phone)) {
    throw new DomainError(
      'INVALID_PHONE',
      'Phone must be a Nigerian number like 08031234567, or international format with country code like +2348031234567',
      400,
    );
  }
  return phone;
}

/** BVN: 11 digits. Spaces and dashes are dropped ("2234-5678-901"). */
export function normalizeBvn(raw: string): string {
  return elevenDigitId(raw, 'INVALID_BVN', 'BVN');
}

/** NIN: 11 digits. Spaces and dashes are dropped. */
export function normalizeNin(raw: string): string {
  return elevenDigitId(raw, 'INVALID_NIN', 'NIN');
}

/** Normalises and validates a value of the given identity type. */
export function normalizeIdentity(type: IdentityType, raw: string): string {
  switch (type) {
    case 'email': {
      const email = normalizeEmail(raw);
      if (!isEmail(email)) {
        throw new DomainError('INVALID_EMAIL', 'Email must be a valid email address', 400);
      }
      return email;
    }
    case 'phone':
      return normalizePhone(raw);
    case 'bvn':
      return normalizeBvn(raw);
    case 'nin':
      return normalizeNin(raw);
  }
}

function elevenDigitId(raw: string, code: string, label: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  if (!ELEVEN_DIGITS.test(digits)) {
    throw new DomainError(code, `${label} must be 11 digits`, 400);
  }
  return digits;
}
