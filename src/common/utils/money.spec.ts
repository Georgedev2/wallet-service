import { DomainError } from '../errors/domain.error';
import { formatKobo, parseAmount } from './money';

describe('parseAmount', () => {
  it.each([
    ['1', 1n],
    ['150000', 150000n],
    ['9999999999999999', 9999999999999999n], // 16 digits
  ])('parses %s', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-100'],
    ['explicit plus', '+100'],
    ['decimal', '100.50'],
    ['trailing dot', '100.'],
    ['leading zero', '0100'],
    ['scientific notation', '1e5'],
    ['17 digits', '10000000000000000'],
    ['whitespace', ' 100'],
    ['thousands separator', '1,000'],
    ['hex', '0x10'],
    ['letters', 'abc'],
  ])('rejects %s (%p)', (_label, input) => {
    expect(() => parseAmount(input)).toThrow(DomainError);
  });

  it('rejects non-strings that slip past the type system', () => {
    expect(() => parseAmount(150000 as unknown as string)).toThrow(DomainError);
  });

  it('throws a 400 INVALID_AMOUNT', () => {
    expect(() => parseAmount('0')).toThrow(
      expect.objectContaining({ code: 'INVALID_AMOUNT', httpStatus: 400 }),
    );
  });
});

describe('formatKobo', () => {
  it.each([
    [150000n, '1500.00'],
    [150050n, '1500.50'],
    [150005n, '1500.05'],
    [99n, '0.99'],
    [5n, '0.05'],
    [0n, '0.00'],
    [-150050n, '-1500.50'],
    [-5n, '-0.05'],
    [9999999999999999n, '99999999999999.99'],
  ])('formats %p as %s', (input, expected) => {
    expect(formatKobo(input)).toBe(expected);
  });
});
