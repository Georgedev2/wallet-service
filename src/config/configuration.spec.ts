import { validateEnv } from './configuration';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('applies defaults to a minimal valid env', () => {
    const env = validateEnv(valid);
    expect(env).toMatchObject({ PORT: 3600, DATABASE_SSL: false, JWT_EXPIRES_IN: '15m' });
  });

  it('parses DATABASE_SSL=true as a boolean', () => {
    expect(validateEnv({ ...valid, DATABASE_SSL: 'true' }).DATABASE_SSL).toBe(true);
  });

  it.each(['DATABASE_URL', 'JWT_SECRET'])('fails when %s is missing', (key) => {
    const env: NodeJS.ProcessEnv = { ...valid };
    delete env[key];
    expect(() => validateEnv(env)).toThrow(`"${key}" is required`);
  });

  it('fails when JWT_SECRET is too short', () => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'short' })).toThrow('JWT_SECRET');
  });

  it('fails when only one of ADMIN_EMAIL / ADMIN_PASSWORD is set', () => {
    expect(() => validateEnv({ ...valid, ADMIN_EMAIL: 'a@b.co' })).toThrow('ADMIN_PASSWORD');
  });

  it('defaults to no CORS origins and 100 requests per minute', () => {
    expect(validateEnv(valid)).toMatchObject({ CORS_ORIGINS: [], RATE_LIMIT_PER_MINUTE: 100 });
  });

  it('parses CORS_ORIGINS into a trimmed list', () => {
    const env = validateEnv({
      ...valid,
      CORS_ORIGINS: ' https://a.example.com , http://localhost:5173,',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://a.example.com', 'http://localhost:5173']);
  });

  it.each(['https://a.example.com/', 'a.example.com', 'https://a.example.com/path'])(
    'rejects %s as a CORS origin',
    (origin) => {
      expect(() => validateEnv({ ...valid, CORS_ORIGINS: origin })).toThrow('is not an origin');
    },
  );
});
