require('../testUtils');
const assert = require('node:assert');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { waitFor } = require('../waitFor');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { FullTextContinuationToken } = require('#src/resources/indexes/fullTextContinuationToken');
const { FullTextContinuationLeases } = require('#src/resources/indexes/fullTextContinuationLease');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');

const queryHash = 'b'.repeat(64);
const query = { text: 'widget' };
const initial = { boundary: undefined, batchSize: 17, consumed: 0 };

describe('retained full-text reader leases with the native addon', () => {
	let writer, reader, path, leases, id, released, maximum;
	before(async function () {
		if (!(await supportsPublishedFullTextBinding())) this.skip();
	});
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
			surfaceTerms: true,
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
	function register(
		ttl = 60000,
		release = () => {
			released++;
		}
	) {
		leases.register(
			{ id, expires: process.hrtime.bigint() + BigInt(ttl) * 1000000n, expiresAt: Date.now() + ttl },
			queryHash,
			query,
			reader,
			release
		);
	}
	const deadline = () => process.hrtime.bigint() + 5000000000n;

	for (const expire of [false, true]) {
		it(`keeps a borrowed native reader alive while ${expire ? 'expiry' : 'revocation'} waits for tracing`, async function () {
			this.timeout(10000);
			const entered = Promise.withResolvers();
			const resume = Promise.withResolvers();
			let traced = false;
			register(expire ? 40 : 60000, () => {
				released++;
			});
			const token = leases.seal(id, queryHash, initial);
			const borrowed = leases.withReader(id, queryHash, async (activeReader) => {
				entered.resolve();
				await resume.promise;
				const trace = await activeReader.traceMatches({ text: 'widget', mode: 'all', fields: ['title'] }, [
					{ id: '0', fields: { title: 'widget' } },
				]);
				assert.strictEqual(trace.complete, true);
				traced = true;
			});
			const rejected = assert.rejects(borrowed, (error) => error.statusCode === 410);
			await entered.promise;
			let draining;
			try {
				if (expire)
					await waitFor(() => {
						try {
							leases.resume(token, queryHash);
							return false;
						} catch (error) {
							return error.statusCode === 410;
						}
					}, 2000);
				else draining = leases.revokeReader(reader);
				await new Promise(setImmediate);
				assert.strictEqual(released, 0);
			} finally {
				resume.resolve();
				await rejected;
				await draining;
			}
			await waitFor(() => released === 1, 2000);
			assert.strictEqual(traced, true);
		});
	}

	it('keeps concurrent revocations pending until asynchronous release is acknowledged', async function () {
		this.timeout(10000);
		const gate = Promise.withResolvers();
		let closed = 0;
		let first, second;
		register(60000, async () => {
			released++;
			await gate.promise;
		});
		const token = leases.seal(id, queryHash, initial);
		try {
			first = leases.close(token, queryHash).then(() => closed++);
			await waitFor(() => released === 1, 2000);
			second = leases.revoke(id).then(() => closed++);
			await new Promise(setImmediate);
			assert.strictEqual(closed, 0);
			assert.throws(
				() => leases.resume(token, queryHash),
				(error) => error.statusCode === 410
			);
		} finally {
			gate.resolve();
			await Promise.all([first, second]);
		}
		assert.strictEqual(released, 1);
		assert.strictEqual(closed, 2);
	});

	it('rejects close when asynchronous release fails after revocation', async function () {
		this.timeout(10000);
		const failure = new Error('admission release failed');
		const failedRelease = Promise.reject(failure);
		await assert.rejects(failedRelease, (error) => error === failure);
		register(60000, () => {
			released++;
			return failedRelease;
		});
		const token = leases.seal(id, queryHash, initial);
		await assert.rejects(leases.close(token, queryHash), (error) => error === failure);
		assert.throws(
			() => leases.resume(token, queryHash),
			(error) => error.statusCode === 410
		);
		await leases.revoke(id);
		assert.strictEqual(released, 1);
	});

	it('reports a synchronous release failure through the close promise', async function () {
		this.timeout(10000);
		const failure = new Error('release callback failed');
		register(60000, () => {
			released++;
			throw failure;
		});
		const token = leases.seal(id, queryHash, initial);
		let closing;
		assert.doesNotThrow(() => {
			closing = leases.close(token, queryHash);
		});
		await assert.rejects(closing, (error) => error === failure);
		assert.strictEqual(released, 1);
	});

	it('observes sibling releases before reporting a reader revocation failure', async function () {
		this.timeout(10000);
		const failure = new Error('one admission release failed');
		const failedRelease = Promise.reject(failure);
		await assert.rejects(failedRelease, (error) => error === failure);
		register(60000, () => {
			released++;
			return failedRelease;
		});
		id = randomBytes(16).toString('hex');
		const gate = Promise.withResolvers();
		register(60000, async () => {
			released++;
			await gate.promise;
		});
		let settled = false;
		let rejected;
		const draining = leases.revokeReader(reader).then(
			() => {
				settled = true;
			},
			(error) => {
				settled = true;
				rejected = error;
			}
		);
		try {
			await waitFor(() => released === 2, 2000);
			await new Promise(setImmediate);
			assert.strictEqual(settled, false);
		} finally {
			gate.resolve();
			await draining;
		}
		assert.strictEqual(rejected, failure);
		assert.strictEqual(released, 2);
	});

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

	it('preserves in-flight revocation while observing a failed asynchronous release', async function () {
		this.timeout(10000);
		const failure = new Error('release failed after native read');
		const failedRelease = Promise.reject(failure);
		await assert.rejects(failedRelease, (error) => error === failure);
		register(60000, () => {
			released++;
			return failedRelease;
		});
		const reading = leases.read(id, queryHash, initial, deadline());
		const draining = leases.revokeReader(reader);
		await Promise.all([
			assert.rejects(reading, (error) => error.statusCode === 410),
			assert.rejects(draining, (error) => error === failure),
		]);
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
