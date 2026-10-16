import { generateReference } from './reference';
import { requestHash } from './request-hash';

describe('requestHash', () => {
  it('is stable for the same parts', () => {
    expect(requestHash(['w1', '100', null])).toBe(requestHash(['w1', '100', null]));
  });

  it.each([
    ['a different amount', ['w1', '200', null]],
    ['a different wallet', ['w2', '100', null]],
    ['a narration instead of null', ['w1', '100', 'rent']],
    ['the same values in another order', ['100', 'w1', null]],
  ])('changes for %s', (_label, parts) => {
    expect(requestHash(parts)).not.toBe(requestHash(['w1', '100', null]));
  });

  it('cannot be fooled by moving a separator between fields', () => {
    expect(requestHash(['a', 'b|c'])).not.toBe(requestHash(['a|b', 'c']));
  });
});

describe('generateReference', () => {
  it('has the prefix and 16 hex characters', () => {
    expect(generateReference('FND')).toMatch(/^FND-[0-9A-F]{16}$/);
    expect(generateReference('TRF')).toMatch(/^TRF-[0-9A-F]{16}$/);
  });

  it('is unique', () => {
    const refs = new Set(Array.from({ length: 1000 }, () => generateReference('FND')));
    expect(refs.size).toBe(1000);
  });
});
