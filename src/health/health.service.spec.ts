import { Pool } from 'pg';
import { DomainError } from '../common/errors/domain.error';
import { HealthService } from './health.service';

describe('HealthService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports 503 DB_UNAVAILABLE when the database never answers', async () => {
    jest.useFakeTimers();
    // A connection that hangs (e.g. a stalled network) rather than failing fast.
    const hangingPool = { query: () => new Promise(() => undefined) } as unknown as Pool;
    const result = new HealthService(hangingPool).check();

    jest.advanceTimersByTime(2000);

    await expect(result).rejects.toMatchObject({ code: 'DB_UNAVAILABLE', httpStatus: 503 });
    await expect(result).rejects.toBeInstanceOf(DomainError);
  });
});
