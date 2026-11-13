require('../testUtils');
const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const { toBufferKey } = require('ordered-binary');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { persistOriginClosedFloor } = require('#src/resources/auditStore');
const {
	READINESS_BYTES,
	DerivedIndexRuntime,
	readDerivedIndexCoverage,
	readDerivedIndexReadiness,
} = require('#src/resources/derivedIndexRuntime');
const {
	FULL_TEXT_QUIET_TOKEN,
	FullTextDerivedIndexBackend,
	decodeFullTextCursorPayload,
	encodeFullTextCursorPayload,
} = require('#src/resources/indexes/fullTextDerivedIndex');
const { FullTextQueryIndex } = require('#src/resources/indexes/fullTextQueryIndex');

const IDLE_GRACE_MILLISECONDS = 50;

// A native lifecycle that keeps its publication in memory; the backend above it is the real one.
function fullTextLifecycle(shared) {
	return {
		inspect() {
			shared.inspections++;
			return { state: 'checkpointed', committedPayload: shared.payload };
		},
		async open() {
			return {
				committedPayload: shared.payload,
				async applyMutationBatch(batch) {
					await shared.applyGate?.promise;
					shared.applied.push(...batch.upserts.map((upsert) => upsert.id));
					return { processed: batch.upserts.length + batch.deletes.length, rejected: [], encodedBytes: 1, frames: 1 };
				},
				async publish(payload) {
					shared.payload = payload;
					this.committedPayload = payload;
					return 1n;
				},
				async close() {
					return {};
				},
			};
		},
		async reset() {
			throw new Error('an idle index must not be reset');
		},
	};
}

function queryLimits() {
	return {
		maxConfiguredQueryTerms: 1024,
		maxConfiguredQueryClauses: 4096,
		maxRecordIdBytes: 4096,
		maxRecordVersionBytes: 4096,
		maxCandidateIds: 1024,
		maxCandidateBytes: 1024 * 1024,
		maxSearchWindow: 100,
		maxSearchPageSize: 100,
		maxAutocompleteResults: 100,
		maxSearchResponseBytes: 8 * 1024 * 1024,
		maxSearchBudgetMilliseconds: 30_000,
		maxTraceRecords: 10,
		maxTraceSourceBytes: Number.MAX_SAFE_INTEGER,
	};
}

function queryIndex(Table, id, shared, { queryApiVersion, hits = () => [], waitForCoverage = async () => {} } = {}) {
	const index = new FullTextQueryIndex({
		Table: { tableId: Table.tableId, primaryStore: Table.primaryStore, _readTxnForContext: () => undefined },
		definition: {
			name: 'titleSearch',
			fields: [{ name: 'title', weight: 1 }],
			analyzer: 'english@2',
			stopWords: true,
			positions: true,
			surfaceTerms: false,
			synonyms: [],
		},
		auditStore: Table.auditStore,
		readinessId: id,
		indexId: id,
		storePath: '/unused',
		storeName: 'unused',
		sourceGeneration: 'generation',
		limits: {},
		binding: {
			async runtimeInfo() {
				return { queryApiVersion, queryClassIsolationMinimumSearchThreads: 1, limits: queryLimits() };
			},
			async openNativeFullTextReader() {
				shared.readerOpens++;
				return {
					get committedPayload() {
						return shared.payload;
					},
					async search() {
						const current = hits();
						return { total: current.length, totalRelation: 'exact', hits: current };
					},
					async searchPage() {
						return { total: 0, totalRelation: 'exact', hits: [] };
					},
					async reload() {},
					async close() {},
				};
			},
		},
	});
	index.attachDerivedHost({
		readiness: () => readDerivedIndexReadiness(Table.auditStore, id),
		requestRebuild: () => false,
		waitForCoverage,
	});
	return index;
}

describe('A derived index whose table receives no writes', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('keeps its owner epoch and its full-text reader across idle periods with audit-metadata commits', async function () {
		this.timeout(60_000);
		const Product = table({
			database: 'derived-index-idle-epoch',
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		const auditStore = Product.auditStore;
		await Product.put('anchor', { title: 'anchor' });
		const anchor = [...auditStore.getRange({ start: 1 })]
			.filter((entry) => entry.tableId === Product.tableId && entry.recordId === 'anchor')
			.at(-1).txnLogKey;
		const id = 'idle-epoch-products';
		const rootStore = auditStore.rootStore;
		const coverage = Object.fromEntries(
			rootStore.listLogs().map((name) => [name, rootStore.useLog(name).getStats().lastCommittedPosition])
		);
		const shared = {
			payload: encodeFullTextCursorPayload({ format: 1, logs: { local: anchor }, coverage }),
			inspections: 0,
			readerOpens: 0,
			applied: [],
		};
		// Two runtimes over one store stand in for two workers: one owns, the other parks on the lock.
		const runtimes = [0, 1].map(
			() =>
				new DerivedIndexRuntime(
					auditStore,
					(_tableId, recordId) => {
						const entry = Product.primaryStore.getEntry(recordId);
						return entry?.value ? { version: entry.version, value: entry.value } : undefined;
					},
					{ idleGraceMilliseconds: IDLE_GRACE_MILLISECONDS, lockRetryMilliseconds: 20 }
				)
		);
		for (const runtime of runtimes) {
			runtime.register({
				backend: new FullTextDerivedIndexBackend({ id, lifecycle: fullTextLifecycle(shared) }),
				projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
				options: { maxFlushAgeMilliseconds: 10 },
			});
		}
		const index = queryIndex(Product, id, shared);
		const search = () =>
			index.search({ attribute: 'title', comparator: 'matches', value: 'shoe', maxIndexLagMilliseconds: 60_000 }, {});
		try {
			await waitFor(() => readDerivedIndexReadiness(auditStore, id).state === 'ready', { timeout: 10_000 });
			await Product.put('first', { title: 'first' });
			await waitFor(
				() =>
					shared.applied.length === 1 &&
					decodeFullTextCursorPayload(shared.payload).coverage &&
					runtimes.every((runtime) => runtime.getStatus(id)?.state === 'idle'),
				{ timeout: 10_000 }
			);
			await sleep(IDLE_GRACE_MILLISECONDS * 2);
			assert.deepStrictEqual(await search(), []);
			const epoch = readDerivedIndexReadiness(auditStore, id).ownerEpoch;
			const inspections = shared.inspections;

			let floor = Date.now();
			for (let period = 0; period < 6; period++) {
				for (let commit = 0; commit < 3; commit++) {
					persistOriginClosedFloor(auditStore, ++floor);
					await sleep(IDLE_GRACE_MILLISECONDS / 2);
				}
				assert.deepStrictEqual(await search(), []);
			}

			assert.strictEqual(readDerivedIndexReadiness(auditStore, id).ownerEpoch, epoch, 'the owner epoch stays');
			assert.strictEqual(shared.readerOpens, 1, 'the full-text reader stays open');
			assert.strictEqual(shared.inspections, inspections, 'no ownership session starts without a log entry');

			await Product.put('written', { title: 'written' });
			await waitFor(() => shared.applied.length === 2, { timeout: 10_000 });
		} finally {
			await index.close();
			await Promise.all(runtimes.map((runtime) => runtime.stop()));
		}
	});
});

describe('An idle full-text index searched by a worker with no reader yet', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	const plainQuery = { attribute: 'title', comparator: 'matches', value: 'first' };
	const scoringQuery = {
		...plainQuery,
		fullTextQuery: { operator: 'boost', boost: 2, clause: { text: 'first', mode: 'any' } },
	};

	async function idleIndex(tableName) {
		const Product = table({
			database: 'derived-index-idle-coverage',
			table: tableName,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		const auditStore = Product.auditStore;
		await Product.put('anchor', { title: 'anchor' });
		const anchor = [...auditStore.getRange({ start: 1 })]
			.filter((entry) => entry.tableId === Product.tableId && entry.recordId === 'anchor')
			.at(-1).txnLogKey;
		const id = `idle-coverage-${tableName}`;
		const rootStore = auditStore.rootStore;
		const coverage = Object.fromEntries(
			rootStore.listLogs().map((name) => [name, rootStore.useLog(name).getStats().lastCommittedPosition])
		);
		const shared = {
			payload: encodeFullTextCursorPayload({ format: 1, logs: { local: anchor }, coverage }),
			inspections: 0,
			readerOpens: 0,
			applied: [],
		};
		const runtimes = [0, 1].map(
			() =>
				new DerivedIndexRuntime(
					auditStore,
					(_tableId, recordId) => {
						const entry = Product.primaryStore.getEntry(recordId);
						return entry?.value ? { version: entry.version, value: entry.value } : undefined;
					},
					{ idleGraceMilliseconds: IDLE_GRACE_MILLISECONDS, lockRetryMilliseconds: 20 }
				)
		);
		for (const runtime of runtimes) {
			runtime.register({
				backend: new FullTextDerivedIndexBackend({ id, lifecycle: fullTextLifecycle(shared) }),
				projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
				options: { maxFlushAgeMilliseconds: 10 },
			});
		}
		const lockKey = `derived-index:${id}:runner`;
		const ownerless = () => {
			if (!auditStore.tryLock(lockKey)) return false;
			auditStore.unlock(lockKey);
			return true;
		};
		await waitFor(() => readDerivedIndexReadiness(auditStore, id).state === 'ready', { timeout: 10_000 });
		await Product.put('first', { title: 'first' });
		await waitFor(() => shared.applied.length === 1 && decodeFullTextCursorPayload(shared.payload).coverage, {
			timeout: 10_000,
		});
		await waitFor(ownerless, { timeout: 10_000, message: 'the idle owner did not release' });
		const hits = () => {
			const entry = Product.primaryStore.getEntry('first');
			return [
				{
					id: `${Product.tableId}.${toBufferKey('first').toString('base64url')}`,
					version: String(entry.version),
					score: 1,
				},
			];
		};
		const indexes = [];
		return {
			Product,
			auditStore,
			id,
			shared,
			runtimes,
			epoch: () => readDerivedIndexReadiness(auditStore, id).ownerEpoch,
			coldIndex(options) {
				const index = queryIndex(Product, id, shared, { queryApiVersion: 8, hits, ...options });
				indexes.push(index);
				return index;
			},
			async close() {
				shared.applyGate?.resolve();
				await Promise.all(indexes.map((index) => index.close()));
				await Promise.all(runtimes.map((runtime) => runtime.stop()));
			},
		};
	}

	const keys = (results) => results.map((result) => result.key);
	const lagging = (error) => error.code === 'DERIVED_INDEX_LAGGING' && error.statusCode === 503;

	it('answers the first default search, scoring or not, after the owner-release quiet period', async function () {
		this.timeout(60_000);
		const fixture = await idleIndex('DefaultLag');
		try {
			const epoch = fixture.epoch();
			// Outlast the 3000 ms default lag tolerance, so the last owner's coverage clock no longer certifies.
			await sleep(3_200);
			assert.strictEqual(
				readDerivedIndexCoverage(fixture.auditStore, fixture.id, () => undefined, 3000).state,
				'unknown',
				'neither the clock nor a reader cursor certifies'
			);
			for (const query of [plainQuery, scoringQuery]) {
				const searched = fixture.coldIndex().search(query, {});
				assert.deepStrictEqual(keys(await searched), ['first']);
				assert.deepStrictEqual(searched.indexCoverage, {
					state: 'current',
					maxLagMilliseconds: 3000,
					lagUpperBoundMilliseconds: 0,
				});
			}
			assert.strictEqual(fixture.epoch(), epoch, 'a search takes no ownership');
			assert.strictEqual(fixture.shared.readerOpens, 2, 'each cold index opens its reader for its search');

			fixture.shared.applyGate = Promise.withResolvers();
			await fixture.Product.put('second', { title: 'second' });
			for (const query of [plainQuery, scoringQuery])
				await assert.rejects(fixture.coldIndex().search(query, {}), lagging);
		} finally {
			await fixture.close();
		}
	});

	it('answers strict and waiting first searches without taking ownership, and rejects once a write is pending', async function () {
		this.timeout(60_000);
		const fixture = await idleIndex('Strict');
		try {
			const epoch = fixture.epoch();
			const strict = { ...plainQuery, maxIndexLagMilliseconds: 0 };
			assert.deepStrictEqual(keys(await fixture.coldIndex().search(strict, {})), ['first']);
			assert.deepStrictEqual(
				keys(await fixture.coldIndex().search({ ...scoringQuery, maxIndexLagMilliseconds: 0 }, {})),
				['first']
			);
			const waiting = fixture.coldIndex({
				waitForCoverage: (since, timeout, signal) =>
					fixture.runtimes[0].waitForCoverage(fixture.id, since, timeout, signal),
			});
			assert.deepStrictEqual(keys(await waiting.search({ ...plainQuery, waitForIndexMilliseconds: 5_000 }, {})), [
				'first',
			]);
			assert.strictEqual(fixture.epoch(), epoch, 'a search takes no ownership');

			const warm = fixture.coldIndex();
			assert.deepStrictEqual(keys(await warm.search(strict, {})), ['first']);
			fixture.shared.applyGate = Promise.withResolvers();
			await fixture.Product.put('second', { title: 'second' });
			await assert.rejects(fixture.coldIndex().search(strict, {}), lagging);
			await assert.rejects(warm.search(strict, {}), lagging);
		} finally {
			await fixture.close();
		}
	});

	it('certifies through the idle mark only while it still describes the logs and the index', async function () {
		this.timeout(60_000);
		const fixture = await idleIndex('Negative');
		const { auditStore, id, Product } = fixture;
		const identity = { tableId: Product.tableId, token: () => FULL_TEXT_QUIET_TOKEN };
		const strictCoverage = (store = auditStore, quiet = identity) =>
			readDerivedIndexCoverage(store, id, () => undefined, 0, quiet).state;
		const withoutOptIn = () => readDerivedIndexCoverage(auditStore, id, () => undefined, 0).state;
		// These log states arise on a real store only in a race, so the stats are reported, not produced.
		const rootStore = auditStore.rootStore;
		const reporting = (stats, logs = () => rootStore.listLogs()) => ({
			rootStore: {
				getMonotonicTimestamp: () => rootStore.getMonotonicTimestamp(),
				listLogs: logs,
				useLog: (name) => ({
					getStats: () =>
						stats(name, rootStore.listLogs().includes(name) ? rootStore.useLog(name).getStats() : undefined),
				}),
			},
			getUserSharedBuffer: (...args) => auditStore.getUserSharedBuffer(...args),
		});
		const readiness = auditStore.getUserSharedBuffer(`derived-index:${id}:readiness`, new ArrayBuffer(READINESS_BYTES));
		// The rebuild-request and lag-exceeded words of the shared readiness layout.
		const demands = new Int32Array(readiness, 3 * 4, 2);
		const epochWord = new BigInt64Array(readiness, READINESS_BYTES - 16, 1);
		try {
			assert.strictEqual(strictCoverage(), 'current');
			assert.strictEqual(withoutOptIn(), 'unknown', 'a caller that does not opt in');
			assert.strictEqual(strictCoverage(auditStore, { ...identity, tableId: Product.tableId + 1 }), 'unknown');
			assert.strictEqual(
				strictCoverage(auditStore, { ...identity, token: () => FULL_TEXT_QUIET_TOKEN + 1 }),
				'unknown'
			);
			assert.strictEqual(
				strictCoverage(auditStore, {
					...identity,
					token: () => {
						throw new Error('token unavailable');
					},
				}),
				'unknown'
			);
			for (const word of [0, 1]) {
				Atomics.store(demands, word, 1);
				const demanded = strictCoverage();
				Atomics.store(demands, word, 0);
				assert.strictEqual(demanded, 'unknown', `readiness demand word ${word}`);
			}
			assert.strictEqual(strictCoverage(reporting((_name, stats) => stats)), 'current', 'an unaltered report');
			const uncommittedTail = reporting((_name, stats) => ({
				...stats,
				nextLogPosition: { ...stats.nextLogPosition, offset: stats.nextLogPosition.offset + 1 },
			}));
			assert.strictEqual(strictCoverage(uncommittedTail), 'unknown', 'a written head past the committed prefix');
			const anotherLog = reporting(
				(_name, stats) => stats ?? { nextLogPosition: { sequence: 0, offset: 0 } },
				() => [...rootStore.listLogs(), 'another-log']
			);
			assert.strictEqual(strictCoverage(anotherLog), 'unknown', 'a physical log the mark does not name');
			assert.strictEqual(strictCoverage(), 'current');

			let acquired = false;
			const successorDuringRead = reporting((_name, stats) => {
				if (!acquired) {
					acquired = true;
					Atomics.add(epochWord, 0, 1n);
				}
				return stats;
			});
			const raced = strictCoverage(successorDuringRead);
			Atomics.sub(epochWord, 0, 1n);
			assert.strictEqual(raced, 'unknown', 'an owner epoch minted while the positions are read');

			fixture.shared.applyGate = Promise.withResolvers();
			await Product.put('second', { title: 'second' });
			assert.strictEqual(strictCoverage(), 'unknown', 'a committed write the mark does not cover');
		} finally {
			await fixture.close();
		}
	});
});
