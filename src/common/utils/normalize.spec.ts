import { DomainError } from '../errors/domain.error';
import {
  normalizeBvn,
  normalizeEmail,
  normalizeIdentity,
  normalizeNin,
  normalizePhone,
} from './normalize';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Alice.Smith@Example.COM \t')).toBe('alice.smith@example.com');
  });
});

describe('normalizePhone', () => {
  it.each([
    ['local with leading 0', '08031234567', '+2348031234567'],
    ['local with spaces', '0803 123 4567', '+2348031234567'],
    ['local with dashes and brackets', '(0803) 123-4567', '+2348031234567'],
    ['234 without plus', '2348031234567', '+2348031234567'],
    ['already E.164', '+2348031234567', '+2348031234567'],
    ['E.164 with spaces', ' +234 803 123 4567 ', '+2348031234567'],
    ['other country, E.164', '+447911123456', '+447911123456'],
  ])('normalises %s', (_label, input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['letters', 'phone'],
    ['too short local', '0803123456'],
    ['too long local', '080312345678'],
    ['no plus, not 234', '447911123456'],
    ['plus then zero', '+0803123456'],
    ['too long E.164', '+1234567890123456'],
  ])('rejects %s (%p) with INVALID_PHONE', (_label, input) => {
    expect(() => normalizePhone(input)).toThrow(
      expect.objectContaining({ code: 'INVALID_PHONE', httpStatus: 400 }),
    );
  });
});

describe.each([
  ['normalizeBvn', normalizeBvn, 'INVALID_BVN'],
  ['normalizeNin', normalizeNin, 'INVALID_NIN'],
])('%s', (_name, normalize, code) => {
  it.each([
    ['plain', '22345678901'],
    ['dashes', '2234-5678-901'],
    ['spaces', ' 223 4567 8901 '],
  ])('keeps only the digits (%s)', (_label, input) => {
    expect(normalize(input)).toBe('22345678901');
  });

  it.each([
    ['empty', ''],
    ['10 digits', '2234567890'],
    ['12 digits', '223456789012'],
    ['letters', '2234567890a'],
    ['dots', '223.4567.8901'],
  ])(`rejects %s (%p) with ${code}`, (_label, input) => {
    expect(() => normalize(input)).toThrow(expect.objectContaining({ code }));
  });
});

describe('normalizeIdentity', () => {
  it.each([
    ['email', ' Bob@Example.com ', 'bob@example.com'],
    ['phone', '08031234567', '+2348031234567'],
    ['bvn', '2234-5678-901', '22345678901'],
    ['nin', '1234 5678 901', '12345678901'],
  ] as const)('normalises a %s', (type, input, expected) => {
    expect(normalizeIdentity(type, input)).toBe(expected);
  });

  it('rejects an invalid email with INVALID_EMAIL', () => {
    expect(() => normalizeIdentity('email', 'not-an-email')).toThrow(DomainError);
    expect(() => normalizeIdentity('email', 'not-an-email')).toThrow(
      expect.objectContaining({ code: 'INVALID_EMAIL' }),
    );
  });
});
