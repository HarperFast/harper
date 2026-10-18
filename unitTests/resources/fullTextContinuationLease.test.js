require('../testUtils');
const assert = require('node:assert');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { waitFor } = require('../waitFor');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { FullTextContinuationToken } = require('#src/resources/indexes/fullTextContinuationToken');
const { FullTextContinuationLeases } = require('#src/resources/indexes/fullTextContinuationLease');

const queryHash = 'b'.repeat(64);
const query = { text: 'widget' };
const initial = { boundary: undefined, batchSize: 17, consumed: 0 };

describe('retained full-text reader leases with the native addon', () => {
	let writer, reader, path, leases, id, released, maximum;
	beforeEach(async () => {
		const binding = await loadFullTextNativeBinding();
		const info = await binding.runtimeInfo();
		maximum = info.limits.maxSearchPageSize;
		path = await mkdtemp(join(__dirname, '../envDir/', String(process.pid), 'continuation-lease-'));
		const options = {
			path,
			indexId: 'lease-test',
			generation: '1',
			fields: [{ name: 'title' }],
			analyzer: 'english@2',
			limits: {
				indexingThreads: 1,
				searchThreads: Math.max(2, info.queryClassIsolationMinimumSearchThreads),
				writerMemoryBytes: 30000000,
				maxQueuedCommands: 16,
				maxQueuedBytes: 8388608,
				maxBatchBytes: 8388608,
			},
		};
		writer = await binding.openNativeFullTextIndex(options);
		await writer.applyMutationBatch({
			upserts: Array.from({ length: 100 }, (_, n) => ({ id: String(n), version: '1', fields: { title: 'widget' } })),
		});
		await writer.commit();
		reader = await binding.openNativeFullTextReader(options);
		const tokens = new FullTextContinuationToken(randomBytes(32).toString('base64url'), 'lease-process', 0, maximum);
		leases = new FullTextContinuationLeases(tokens, maximum, info.limits.maxSearchBudgetMilliseconds);
		id = randomBytes(16).toString('hex');
		released = 0;
	});
	afterEach(async () => {
		if (leases && reader) await leases.revokeReader(reader);
		await reader?.close();
		await writer?.close();
		if (path) await rm(path, { recursive: true, force: true });
	});
	function register(ttl = 60000) {
		leases.register(
			{ id, expires: process.hrtime.bigint() + BigInt(ttl) * 1000000n, expiresAt: Date.now() + ttl },
			queryHash,
			query,
			reader,
			() => {
				released++;
			}
		);
	}
	const deadline = () => process.hrtime.bigint() + 5000000000n;

	it('replays an immutable partially consumed batch against the original publication', async () => {
		register();
		const original = await leases.read(id, queryHash, initial, deadline());
		const position = { ...initial, consumed: 5 };
		const token = leases.seal(id, queryHash, position);
		await writer.applyMutationBatch({
			upserts: [{ id: 'new', version: '2', fields: { title: 'widget widget widget' } }],
		});
		await writer.commit();
		assert.deepStrictEqual(leases.resume(token, queryHash).position, position);
		const replay = await leases.read(id, queryHash, position, deadline());
		assert.deepStrictEqual(replay, original);
		assert.strictEqual(replay.total, 100);
		assert.strictEqual(released, 0);
		await leases.close(token, queryHash);
		assert.strictEqual(released, 1);
		assert.throws(
			() => leases.resume(token, queryHash),
			(error) => error.statusCode === 410
		);
	});

	it('revokes before waiting for native work and releases the reader only after it settles', async () => {
		register();
		const token = leases.seal(id, queryHash, initial);
		const reading = leases.read(id, queryHash, initial, deadline());
		const draining = leases.revokeReader(reader);
		assert.strictEqual(released, 0);
		assert.throws(
			() => leases.resume(token, queryHash),
			(error) => error.statusCode === 410
		);
		await assert.rejects(reading, (error) => error.statusCode === 410);
		await draining;
		assert.strictEqual(released, 1);
		await leases.revokeReader(reader);
		assert.strictEqual(released, 1);
	});

	it('releases an idle expired lease without a later search or a reset', async () => {
		register(100);
		const token = leases.seal(id, queryHash, initial);
		await waitFor(() => released === 1, 2000);
		assert.throws(
			() => leases.resume(token, queryHash),
			(error) => error.statusCode === 410
		);
	});
});
