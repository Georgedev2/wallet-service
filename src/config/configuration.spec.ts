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
});
