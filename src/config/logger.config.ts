import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { Params } from 'nestjs-pino';
import { Env } from './configuration';

const REQUEST_ID_HEADER = 'x-request-id';
// Reuse a caller's request id (e.g. from Render's proxy) only if it looks safe to log.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Secrets and PII that must never reach the logs: tokens, passwords, BVNs, raw bodies. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body',
  'res.body',
  'password',
  'bvn',
  'accessToken',
  '*.password',
  '*.bvn',
  '*.accessToken',
];

export function buildLoggerParams(nodeEnv: Env['NODE_ENV']): Params {
  return {
    pinoHttp: {
      level: nodeEnv === 'test' ? 'silent' : nodeEnv === 'production' ? 'info' : 'debug',
      // pino-pretty is a dev dependency; production logs stay as JSON.
      transport: nodeEnv === 'development' ? { target: 'pino-pretty' } : undefined,
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const incoming = req.headers[REQUEST_ID_HEADER];
        const id =
          typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
      // pino-http doesn't log bodies; these paths also catch any added later by a
      // custom serializer or a log call like logger.info({ user }).
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
  };
}
