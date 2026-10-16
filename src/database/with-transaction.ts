import { Pool, PoolClient } from 'pg';

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // If ROLLBACK itself fails the connection is unusable; passing the error to
  // release() destroys it instead of returning it to the pool.
  let brokenConnection: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      brokenConnection =
        rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(brokenConnection);
  }
}
