require('../testUtils');
const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { persistOriginClosedFloor } = require('#src/resources/auditStore');
const { DerivedIndexRuntime, readDerivedIndexReadiness } = require('#src/resources/derivedIndexRuntime');
const {
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

// What one HTTP worker's search path does: a reader per owner epoch, counted where the native reader opens.
function queryIndex(Table, id, shared) {
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
				return { queryClassIsolationMinimumSearchThreads: 1, limits: queryLimits() };
			},
			async openNativeFullTextReader() {
				shared.readerOpens++;
				return {
					get committedPayload() {
						return shared.payload;
					},
					async search() {
						return { total: 0, totalRelation: 'exact', hits: [] };
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
		waitForCoverage: async () => {},
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
		// The publication an idle pass leaves: the cursor plus the committed positions it covers.
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
			// indexed, then the idle pass's coverage published, then released once idle
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

			assert.strictEqual(readDerivedIndexReadiness(auditStore, id).ownerEpoch, epoch, 'the owner epoch changed');
			assert.strictEqual(shared.readerOpens, 1, 'the full-text reader was reopened');
			assert.strictEqual(shared.inspections, inspections, 'an ownership session started with no log entry to read');

			await Product.put('written', { title: 'written' });
			await waitFor(() => shared.applied.length === 2, { timeout: 10_000 });
		} finally {
			await index.close();
			await Promise.all(runtimes.map((runtime) => runtime.stop()));
		}
	});
});
