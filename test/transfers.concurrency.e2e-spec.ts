import { MoneyKit } from './money-kit';

/** Parallel transfers against the real database: no overspend, no deadlocks. */
describe('Transfers under concurrency (e2e)', () => {
  let kit: MoneyKit;

  beforeAll(async () => {
    kit = await MoneyKit.start();
  });

  afterEach(async () => {
    await kit.expectReconciled();
  });

  afterAll(async () => {
    await kit.stop();
  });

  it('never overspends: 50 parallel transfers of 100 from a balance of 1000', async () => {
    const a = await kit.createUser('1000');
    const b = await kit.createUser();

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => kit.transfer(a, b, '100')),
    );

    const succeeded = responses.filter((r) => r.status === 201);
    const rejected = responses.filter(
      (r) => r.status === 422 && r.body.error?.code === 'INSUFFICIENT_FUNDS',
    );
    expect(succeeded).toHaveLength(10);
    expect(rejected).toHaveLength(40);
    expect(await kit.balanceOf(a.walletId)).toBe('0');
    expect(await kit.balanceOf(b.walletId)).toBe('1000');
  });

  it('does not deadlock: 100 parallel transfers alternating A→B and B→A', async () => {
    const a = await kit.createUser('10000');
    const b = await kit.createUser('10000');

    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        i % 2 === 0 ? kit.transfer(a, b, '100') : kit.transfer(b, a, '100'),
      ),
    );

    // A deadlock or lock timeout would surface as 503 TRY_AGAIN, anything else as 500.
    const failures = responses
      .filter((r) => r.status !== 201)
      .map((r) => ({ status: r.status, body: r.body }));
    expect(failures).toEqual([]);
    // 50 each way, so both end where they started.
    expect(await kit.balanceOf(a.walletId)).toBe('10000');
    expect(await kit.balanceOf(b.walletId)).toBe('10000');
  });
});
