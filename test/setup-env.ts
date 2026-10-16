import { existsSync, readFileSync } from 'fs';
import { parseEnv } from 'util';

// e2e tests must never touch the dev database.
// process.loadEnvFile writes to the real process.env, which Jest's per-file
// sandbox doesn't see, so parse the file and assign the values here instead.
if (existsSync('.env')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
    process.env[key] ??= value;
  }
}
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set to run e2e tests');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
