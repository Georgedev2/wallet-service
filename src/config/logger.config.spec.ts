import { createServer } from 'http';
import { Options, pinoHttp } from 'pino-http';
import * as request from 'supertest';
import { buildLoggerParams } from './logger.config';

const BVN = '22212345678';
const PASSWORD = 'Sup3r-secret-pw';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';

/** Runs one request through pino-http with the production options and returns the log lines. */
async function logsFor(handler: (log: ReturnType<typeof pinoHttp>['logger']) => void) {
  const lines: string[] = [];
  const options = buildLoggerParams('production').pinoHttp as Options;
  const middleware = pinoHttp(options, { write: (line: string) => lines.push(line) });
  const server = createServer((req, res) => {
    middleware(req, res);
    handler(req.log);
    res.setHeader('Set-Cookie', `session=${TOKEN}`);
    res.end(JSON.stringify({ accessToken: TOKEN, user: { bvn: BVN } }));
  });

  await request(server)
    .post('/users')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Cookie', `session=${TOKEN}`)
    .send({ email: 'a@example.com', password: PASSWORD, bvn: BVN });
  return lines.join('');
}

describe('logger redaction', () => {
  it('keeps tokens, cookies and request bodies out of the request log', async () => {
    const out = await logsFor(() => undefined);

    expect(out).toContain('"url":"/users"');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(BVN);
  });

  it('redacts passwords, BVNs and tokens passed to a log call', async () => {
    const out = await logsFor((log) => {
      log.info({ password: PASSWORD, bvn: BVN, accessToken: TOKEN }, 'top level');
      log.info({ user: { password: PASSWORD, bvn: BVN }, data: { accessToken: TOKEN } }, 'nested');
    });

    expect(out).toContain('top level');
    expect(out).toContain('nested');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(BVN);
  });
});
