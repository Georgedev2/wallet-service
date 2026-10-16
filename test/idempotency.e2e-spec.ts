import { MoneyKit, newKey } from './money-kit';

/** The same Idempotency-Key sent many times at once must move money exactly once. */
describe('Idempotency under concurrency (e2e)', () => {
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

  async function rowCounts(initiatorId: string, idemKey: string) {
    const { rows } = await kit.pool.query<{ transactions: number; entries: number }>(
      `SELECT count(DISTINCT t.id)::int AS transactions, count(l.id)::int AS entries
         FROM transactions t LEFT JOIN ledger_entries l ON l.transaction_id = t.id
        WHERE t.initiated_by = $1 AND t.idempotency_key = $2`,
      [initiatorId, idemKey],
    );
    return rows[0];
  }

  it('20 parallel identical transfers with one key: one transfer, the same reference for all', async () => {
    const a = await kit.createUser('10000');
    const b = await kit.createUser();
    const idemKey = newKey();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => kit.transfer(a, b, '700', idemKey)),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    const replays = responses.filter((r) => r.status === 200);
    expect(replays).toHaveLength(19);
    expect(replays.every((r) => r.body.data.replayed === true)).toBe(true);
    const references = new Set(responses.map((r) => r.body.data.reference));
    expect(references.size).toBe(1);

    expect(await rowCounts(a.userId, idemKey)).toEqual({ transactions: 1, entries: 2 });
    expect(await kit.balanceOf(a.walletId)).toBe('9300');
    expect(await kit.balanceOf(b.walletId)).toBe('700');
  });

  it('20 parallel identical fundings with one key: one credit', async () => {
    const a = await kit.createUser();
    const idemKey = newKey();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => kit.fund(a.walletId, '5000', idemKey)),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(19);
    expect(new Set(responses.map((r) => r.body.data.reference)).size).toBe(1);
    expect(await kit.balanceOf(a.walletId)).toBe('5000');
  });

  it('one key sent in parallel to different recipients: one transfer, the rest 409', async () => {
    // Different destinations lock different rows, so these don't queue behind each
    // other; the unique (initiated_by, idempotency_key) index has to decide.
    const a = await kit.createUser('10000');
    const recipients = await Promise.all(Array.from({ length: 5 }, () => kit.createUser()));
    const idemKey = newKey();

    const responses = await Promise.all(recipients.map((r) => kit.transfer(a, r, '100', idemKey)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    const conflicts = responses.filter((r) => r.status === 409);
    expect(conflicts).toHaveLength(4);
    expect(conflicts.every((r) => r.body.error.code === 'IDEMPOTENCY_KEY_REUSED')).toBe(true);
    expect(await rowCounts(a.userId, idemKey)).toEqual({ transactions: 1, entries: 2 });
    expect(await kit.balanceOf(a.walletId)).toBe('9900');
  });
});
