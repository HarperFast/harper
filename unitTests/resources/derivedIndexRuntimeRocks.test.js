require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor');
const { LOCAL_ONLY } = require('#src/resources/auditStore');
const { DERIVED_INDEX_ACCEPTED, DerivedIndexRuntime } = require('#src/resources/derivedIndexRuntime');
const { decodeFullTextCursorPayload } = require('#src/resources/indexes/fullTextDerivedIndex');
const {
	createNativeFullTextDerivedIndexBackend,
	NativeFullTextDerivedIndexLifecycle,
} = require('#src/resources/indexes/nativeFullTextDerivedIndexLifecycle');

describe('DerivedIndexRuntime with an audited RocksDB table', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	let runtime;
	let testPath;
	before(function () {
		testPath = setupTestDBPath();
		setMainIsWorker(true);
	});

	after(function () {
		runtime?.stop();
	});

	it('tails committed writes and projects the current primary state', async () => {
		const Product = table({
			database: 'derived-index-runtime-rocks',
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }, { name: 'privateInventory' }],
		});
		await Product.put('unregistered-eviction', { title: 'not indexed' });
		let entry = Product.primaryStore.getEntry('unregistered-eviction');
		await Product.evict('unregistered-eviction', entry.value, entry.version);
		assert.strictEqual(
			[...Product.auditStore.getRange({ start: 1 })].some(
				(record) => record.type === 'evict' && record.recordId === 'unregistered-eviction'
			),
			false
		);

		await Product.put('anchor', { title: 'anchor' });
		const anchor = [...Product.auditStore.getRange({ start: 1 })]
			.filter((entry) => entry.tableId === Product.tableId && entry.recordId === 'anchor')
			.at(-1).txnLogKey;

		const backend = {
			id: 'products',
			cursor: { format: 1, logs: { local: anchor } },
			deliveries: [],
			attach() {},
			flush() {},
			shutdown() {},
			getDurableCursor() {
				return this.cursor;
			},
			deliver(batch) {
				this.deliveries.push(batch);
				this.cursor = batch.through;
				return DERIVED_INDEX_ACCEPTED;
			},
			onStateChange(wake) {
				this.wake = wake;
				return () => (this.wake = undefined);
			},
		};
		runtime = new DerivedIndexRuntime(Product.auditStore, (tableId, recordId) => {
			if (tableId !== Product.tableId) throw new Error(`unknown table ${tableId}`);
			const entry = Product.primaryStore.getEntry(recordId);
			return entry?.value ? { version: entry.version, value: entry.value } : undefined;
		});
		const unregister = runtime.register({
			backend,
			projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
		});

		await Product.put('p1', { title: 'first', privateInventory: 12 });
		await waitFor(() => mutationsFor(backend, 'p1').length >= 1);
		assert.deepStrictEqual(mutationsFor(backend, 'p1').at(-1).state.projection, { title: 'first' });
		assert.strictEqual('privateInventory' in mutationsFor(backend, 'p1').at(-1).state.projection, false);

		await Product.patch('p1', { title: 'second' });
		await waitFor(() => mutationsFor(backend, 'p1').length >= 2);
		assert.deepStrictEqual(mutationsFor(backend, 'p1').at(-1).state, {
			kind: 'record',
			version: Product.primaryStore.getEntry('p1').version,
			projection: { title: 'second' },
		});

		await Product.delete('p1');
		await waitFor(() => mutationsFor(backend, 'p1').some((mutation) => mutation.state.kind === 'absent'));
		assert.strictEqual(mutationsFor(backend, 'p1').at(-1).state.kind, 'absent');

		await Product.put('evicted', { title: 'resident' });
		await waitFor(() => mutationsFor(backend, 'evicted').length > 0);
		entry = Product.primaryStore.getEntry('evicted');
		await Product.evict('evicted', entry.value, entry.version);
		await waitFor(() => mutationsFor(backend, 'evicted').at(-1)?.state.kind === 'absent');
		const markers = [...Product.auditStore.getRange({ start: 1 })].filter(
			(record) => record.type === 'evict' && record.recordId === 'evicted'
		);
		assert.strictEqual(markers.length, 1);
		assert.strictEqual(markers[0].extendedType & LOCAL_ONLY, LOCAL_ONLY);
		const history = [];
		for await (const record of Product.getHistory()) history.push(record);
		assert.strictEqual(
			history.some((record) => record.type === 'evict'),
			false
		);

		await unregister();
		await Product.put('after-unregister', { title: 'not indexed' });
		entry = Product.primaryStore.getEntry('after-unregister');
		await Product.evict('after-unregister', entry.value, entry.version);
		assert.strictEqual(
			[...Product.auditStore.getRange({ start: 1 })].some(
				(record) => record.type === 'evict' && record.recordId === 'after-unregister'
			),
			false
		);
		await runtime.stop();
		runtime = undefined;
	});

	it('anchors a retention-emptied peer log by floor, condemns a crossed floor, and re-anchors on the next commit', async function () {
		this.timeout(60_000);
		const Product = table({
			database: 'derived-index-floor-rocks',
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		const auditStore = Product.auditStore;
		const rootStore = auditStore.rootStore;
		const remoteNodeId = auditStore.ensureLogExists('remote');
		const remote = rootStore.useLog('remote');
		let peerTime = Date.now() - 10_000;
		const writeRemote = async (id) => {
			const context = { source: {}, sourceApply: true, timestamp: ++peerTime };
			await transaction(context, async () => {
				const resource = await Product.getResource(id, context);
				return resource._writeUpdate(id, { title: id }, true, {
					isNotification: true,
					nodeId: remoteNodeId,
					version: peerTime,
				});
			});
		};
		// rocksdb-js 2.12 purges a flushed log's last file too. flushSync publishes the flushed position
		// from RocksDB's flush callback, so the purge is retried until the peer log really has no files.
		// A local write after the flush keeps the local log's current file (unflushed tail) and with it
		// the local anchor, so only the peer log changes under the cursor.
		let filler = 0;
		const emptyRemote = async () => {
			rootStore.flushSync();
			await Product.put(`filler-${++filler}`, { title: 'filler' });
			await waitFor(
				() => {
					rootStore.purgeLogs({ before: Date.now() + 60_000 });
					return remote.getStats().fileCount === 0;
				},
				{ timeout: 20_000 }
			);
			return remote.getStats();
		};
		const backend = {
			id: 'floor-products',
			cursor: undefined,
			deliveries: [],
			resets: 0,
			attach() {},
			flush() {},
			shutdown() {},
			reset() {
				this.resets++;
				this.cursor = undefined;
			},
			getDurableCursor() {
				return this.cursor;
			},
			deliver(batch) {
				this.deliveries.push(batch);
				if (batch.through) this.cursor = batch.through;
				return DERIVED_INDEX_ACCEPTED;
			},
			onStateChange(wake) {
				this.wake = wake;
				return () => (this.wake = undefined);
			},
		};
		runtime = new DerivedIndexRuntime(
			auditStore,
			(tableId, recordId) => {
				const entry = Product.primaryStore.getEntry(recordId);
				return entry?.value ? { version: entry.version, value: entry.value } : undefined;
			},
			{
				scanRecords: () =>
					Product.primaryStore.getRange({ versions: true }).map((entry) => ({
						recordId: entry.key,
						version: entry.version,
						value: entry.value,
					})),
			}
		);
		const register = () =>
			runtime.register({
				backend,
				projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
				options: { maxFlushAgeMilliseconds: 10, maxRebuildAttempts: 2, rebuildBackoffMilliseconds: 10 },
			});
		// Shared readiness outlives a registration, so a new generation is observed through work it
		// delivers: once a rebuild (if any) has installed its boundary, a local write must replay through.
		let probe = 0;
		const settled = async (resets) => {
			await waitFor(() => backend.resets === resets && backend.cursor !== undefined, { timeout: 20_000 });
			const id = `probe-${++probe}`;
			await Product.put(id, { title: id });
			await waitFor(() => mutationsFor(backend, id).length === 1, { timeout: 20_000 });
			await waitFor(() => runtime.getReadiness(backend.id).state === 'ready', { timeout: 20_000 });
		};
		const scannedRecordIds = () => new Set(backend.deliveries.flatMap((batch) => batch.records.map((r) => r.recordId)));

		// A peer commit is purged with its whole log before any index reads it; no reader holds a mapping
		// of the purged segment, so the emptied log is exactly what a restarted process would see.
		await writeRemote('r1');
		const emptied = await emptyRemote();
		assert.ok(
			emptied.currentSequenceNumber > 1,
			`an emptied log reports a writer sequence past 1, got ${emptied.currentSequenceNumber}`
		);
		let unregister = register();
		await settled(1);
		assert.ok(scannedRecordIds().has('r1'), 'the seeding scan indexed the record whose log entry was purged');
		assert.strictEqual(backend.cursor.logs.remote, undefined);
		assert.strictEqual(backend.cursor.floors.remote, emptied.currentSequenceNumber);
		await unregister();

		backend.cursor = { format: 1, logs: { ...backend.cursor.logs } };
		unregister = register();
		await settled(2);
		assert.strictEqual(backend.cursor.floors.remote, emptied.currentSequenceNumber);
		await unregister();

		unregister = register();
		await settled(2);
		assert.strictEqual(backend.cursor.floors.remote, emptied.currentSequenceNumber);
		await unregister();

		await writeRemote('r3');
		const crossed = await emptyRemote();
		assert.ok(crossed.currentSequenceNumber > emptied.currentSequenceNumber, 'the writer moved past the floor');
		unregister = register();
		await settled(3);
		assert.strictEqual(backend.cursor.floors.remote, crossed.currentSequenceNumber);
		assert.ok(scannedRecordIds().has('r3'), 'the rebuild scan indexed the record whose log entry was purged');

		await writeRemote('r4');
		await waitFor(() => backend.cursor.logs.remote > 0, { timeout: 20_000 });
		assert.strictEqual(backend.cursor.floors, undefined);
		assert.strictEqual(backend.resets, 3);
		assert.strictEqual(mutationsFor(backend, 'r4').length, 1);
		await unregister();
		await runtime.stop();
		runtime = undefined;
	});

	describe('a timestamp-anchored log that retention empties while idle', () => {
		// Persists coverage inside the durable cursor and carries it into newer cursors, as both native
		// backends do (hnswDerivedIndex.ts publishCoverage and its cursor write).
		const coverageBackend = (id) => ({
			id,
			cursor: undefined,
			deliveries: [],
			resets: 0,
			shutdowns: 0,
			attach() {},
			flush() {},
			shutdown() {
				this.shutdowns++;
			},
			reset() {
				this.resets++;
				this.cursor = undefined;
			},
			getDurableCursor() {
				return this.cursor;
			},
			publishCoverage(positions) {
				this.cursor = { ...this.cursor, coverage: positions };
			},
			deliver(batch) {
				this.deliveries.push(batch);
				if (batch.through)
					this.cursor = this.cursor?.coverage ? { ...batch.through, coverage: this.cursor.coverage } : batch.through;
				return DERIVED_INDEX_ACCEPTED;
			},
			onStateChange(wake) {
				this.wake = wake;
				return () => (this.wake = undefined);
			},
		});
		// A peer log, the cluster case. A purged file stays readable in-process while its WeakRef'd mapping
		// lives (rocksdb-js readableExtent), so emptying also collects it: the anchor is then gone, as after a
		// restart or a long idle period.
		const setup = (database, id, backend = coverageBackend(id), registerOptions = {}) => {
			const Product = table({
				database,
				table: 'Product',
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
			});
			const auditStore = Product.auditStore;
			const rootStore = auditStore.rootStore;
			const remoteNodeId = auditStore.ensureLogExists('remote');
			const remote = rootStore.useLog('remote');
			let peerTime = Date.now() - 10_000;
			const writeRemote = async (recordId) => {
				const context = { source: {}, sourceApply: true, timestamp: ++peerTime };
				await transaction(context, async () => {
					const resource = await Product.getResource(recordId, context);
					return resource._writeUpdate(recordId, { title: recordId }, true, {
						isNotification: true,
						nodeId: remoteNodeId,
						version: peerTime,
					});
				});
			};
			runtime = new DerivedIndexRuntime(
				auditStore,
				(tableId, recordId) => {
					const entry = Product.primaryStore.getEntry(recordId);
					return entry?.value ? { version: entry.version, value: entry.value } : undefined;
				},
				{
					idleGraceMilliseconds: 50,
					scanRecords: () =>
						Product.primaryStore.getRange({ versions: true }).map((entry) => ({
							recordId: entry.key,
							version: entry.version,
							value: entry.value,
						})),
				}
			);
			const register = (registered = backend) =>
				runtime.register({
					backend: registered,
					projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
					options: {
						maxFlushAgeMilliseconds: 10,
						maxRebuildAttempts: 2,
						rebuildBackoffMilliseconds: 10,
						...registerOptions,
					},
				});
			// Caught up: the durable cursor anchors the peer log and its persisted coverage is the committed tail.
			const caughtUp = (registered = backend) =>
				waitFor(
					() => {
						const cursor = registered.getDurableCursor();
						const coverage = cursor?.coverage?.remote;
						const committed = remote.getStats().lastCommittedPosition;
						return (
							cursor.logs.remote !== undefined &&
							coverage?.sequence === committed.sequence &&
							coverage?.offset === committed.offset &&
							runtime.getReadiness(id).state === 'ready'
						);
					},
					{ timeout: 20_000 }
				);
			// flushSync publishes the flushed position from RocksDB's flush callback, so the purge is retried.
			// A local write after the flush keeps the local log's unflushed tail, and with it the local anchor.
			let filler = 0;
			const emptyRemote = async () => {
				rootStore.flushSync();
				await Product.put(`filler-${++filler}`, { title: 'filler' });
				await waitFor(
					() => {
						rootStore.purgeLogs({ before: Date.now() + 60_000 });
						return remote.getStats().fileCount === 0;
					},
					{ timeout: 20_000 }
				);
				for (let i = 0; i < 3; i++) {
					global.gc();
					await new Promise((resolve) => setImmediate(resolve));
				}
			};
			return { Product, remote, backend, register, caughtUp, emptyRemote, writeRemote };
		};

		it('resumes without a rebuild after a re-registration and after an idle hand-off', async function () {
			this.timeout(60_000);
			const { remote, backend, register, caughtUp, emptyRemote, writeRemote } = setup(
				'derived-index-idle-anchor-rocks',
				'idle-anchor-products'
			);
			let unregister = register();
			await waitFor(() => backend.resets === 1 && runtime.getReadiness(backend.id).state === 'ready', {
				timeout: 20_000,
			});
			await writeRemote('a');
			await waitFor(() => mutationsFor(backend, 'a').length === 1, { timeout: 20_000 });
			await caughtUp();
			await unregister();
			const coverage = backend.cursor.coverage.remote;

			await emptyRemote();
			assert.deepStrictEqual(remote.getStats().lastFlushedPosition, coverage, 'the witness is the covered tail');
			unregister = register();
			await waitFor(() => backend.cursor.logs.remote === undefined, { timeout: 20_000 });
			assert.strictEqual(backend.cursor.floors.remote, remote.getStats().currentSequenceNumber);
			await writeRemote('b');
			await waitFor(() => mutationsFor(backend, 'b').length === 1 && backend.cursor.logs.remote !== undefined, {
				timeout: 20_000,
			});
			assert.strictEqual(backend.cursor.floors, undefined, 'the next commit anchors the log again');
			assert.strictEqual(backend.resets, 1, 'a re-registration over the emptied log did not rebuild');

			// The runner releases once idle; the next peer write re-acquires it and installs the durable cursor.
			await caughtUp();
			const releases = backend.shutdowns;
			await waitFor(() => backend.shutdowns > releases, { timeout: 20_000 });
			const epoch = runtime.getReadiness(backend.id).ownerEpoch;
			await emptyRemote();
			await writeRemote('c');
			await waitFor(() => mutationsFor(backend, 'c').length === 1, { timeout: 20_000 });
			assert(runtime.getReadiness(backend.id).ownerEpoch > epoch, 'a new owner installed the cursor');
			assert.strictEqual(backend.resets, 1, 'an idle hand-off over the emptied log did not rebuild');
			assert.strictEqual(mutationsFor(backend, 'a').length, 1);
			assert.strictEqual(mutationsFor(backend, 'b').length, 1);
			await unregister();
			await runtime.stop();
			runtime = undefined;
		});

		it('rebuilds when a peer write past the covered position was flushed and purged', async function () {
			this.timeout(60_000);
			const { backend, register, caughtUp, emptyRemote, writeRemote } = setup(
				'derived-index-idle-anchor-lost-rocks',
				'idle-anchor-lost-products'
			);
			let unregister = register();
			await waitFor(() => backend.resets === 1 && runtime.getReadiness(backend.id).state === 'ready', {
				timeout: 20_000,
			});
			await writeRemote('a');
			await caughtUp();
			await unregister();

			await writeRemote('unseen');
			await emptyRemote();
			unregister = register();
			await waitFor(() => backend.resets === 2 && runtime.getReadiness(backend.id).state === 'ready', {
				timeout: 20_000,
			});
			assert(
				backend.deliveries.some(
					(batch) => batch.rebuild && batch.records.some((record) => record.recordId === 'unseen')
				),
				'the rebuild scan indexed the write whose log entry was purged'
			);
			await unregister();
			await runtime.stop();
			runtime = undefined;
		});

		it('resumes a reopened full-text publication without a rebuild', async function () {
			this.timeout(60_000);
			const binding = new FakeNativeFullTextModule();
			const lifecycleOptions = {
				storePath: path.join(testPath, 'fulltext-idle-anchor-indexes'),
				storeName: 'fulltext-idle-anchor-rocks.Product.title',
				indexId: 'fulltext-idle-anchor-products',
				sourceGeneration: 'product-table-generation',
				fields: [{ name: 'title' }],
				analyzer: 'english@2',
				limits: {
					indexingThreads: 1,
					searchThreads: 1,
					writerMemoryBytes: 32 * 1024 * 1024,
					maxQueuedCommands: 16,
					maxQueuedBytes: 64 * 1024 * 1024,
					maxBatchBytes: 8 * 1024 * 1024,
				},
				binding,
			};
			const open = () =>
				createNativeFullTextDerivedIndexBackend({ id: 'fulltext-idle-anchor-products', ...lifecycleOptions });
			const documentOf = (recordId) => {
				const documents = binding.states.get(binding.opens.at(-1).generation).documents;
				return documents.get(`${Product.tableId}.${Buffer.from(recordId).toString('base64url')}`);
			};
			let backend = await open();
			const { Product, remote, register, caughtUp, emptyRemote, writeRemote } = setup(
				'fulltext-idle-anchor-rocks',
				backend.id,
				backend,
				{ flushAfterMutations: 1 }
			);
			let unregister = register();
			await waitFor(() => runtime.getReadiness(backend.id).state === 'ready', { timeout: 20_000 });
			await writeRemote('a');
			await waitFor(() => documentOf('a'), { timeout: 20_000 });
			await caughtUp();
			await unregister();
			const resets = binding.resets;

			await emptyRemote();
			backend = await open();
			unregister = register(backend);
			await waitFor(() => backend.getDurableCursor()?.logs.remote === undefined, { timeout: 20_000 });
			await unregister();
			const reopened = new NativeFullTextDerivedIndexLifecycle(lifecycleOptions);
			await reopened.initialize();
			const published = decodeFullTextCursorPayload(reopened.inspect().committedPayload);
			assert.strictEqual(published.logs.remote, undefined);
			assert.strictEqual(published.floors.remote, remote.getStats().currentSequenceNumber);

			backend = await open();
			unregister = register(backend);
			await writeRemote('b');
			await waitFor(() => documentOf('b'), { timeout: 20_000 });
			assert(documentOf('a'), 'the document indexed before the purge is still there');
			assert.strictEqual(binding.resets, resets, 'no reopen over the emptied log rebuilt the index');
			await unregister();
			await runtime.stop();
			runtime = undefined;
		});
	});

	it('publishes a full-text cursor from the runtime batch without writing back to the source log', async () => {
		const Product = table({
			database: 'fulltext-derived-index-runtime-rocks',
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		await Product.put('anchor', { title: 'anchor' });
		const anchor = [...Product.auditStore.getRange({ start: 1 })]
			.filter((entry) => entry.tableId === Product.tableId && entry.recordId === 'anchor')
			.at(-1).txnLogKey;
		const binding = new FakeNativeFullTextModule();
		const lifecycleOptions = {
			storePath: path.join(testPath, 'fulltext-indexes'),
			storeName: 'fulltext-derived-index-runtime-rocks.Product.title',
			indexId: 'rocks-fulltext-products',
			sourceGeneration: 'product-table-generation',
			fields: [{ name: 'title' }],
			analyzer: 'english@2',
			limits: {
				indexingThreads: 1,
				searchThreads: 1,
				writerMemoryBytes: 32 * 1024 * 1024,
				maxQueuedCommands: 16,
				maxQueuedBytes: 64 * 1024 * 1024,
				maxBatchBytes: 8 * 1024 * 1024,
			},
			binding,
		};
		const backend = await createNativeFullTextDerivedIndexBackend({
			id: 'rocks-fulltext-products',
			...lifecycleOptions,
		});
		runtime = new DerivedIndexRuntime(
			Product.auditStore,
			(tableId, recordId) => {
				if (tableId !== Product.tableId) throw new Error(`unknown table ${tableId}`);
				const entry = Product.primaryStore.getEntry(recordId);
				return entry?.value ? { version: entry.version, value: entry.value } : undefined;
			},
			{
				scanRecords: () =>
					Product.primaryStore.getRange({ versions: true }).map((entry) => ({
						recordId: entry.key,
						version: entry.version,
						value: entry.value,
					})),
			}
		);
		let unregister = runtime.register({
			backend,
			projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
			options: { flushAfterMutations: 1, maxFlushAgeMilliseconds: 10 },
		});
		try {
			await waitFor(() => runtime.getReadiness(backend.id).state === 'ready', { timeout: 10_000 });
			const state = binding.states.get(binding.opens.at(-1).generation);
			assert(state, 'the seeded rebuild opened the native writer');
			const initialApplications = state.applications;
			const initialPublications = state.publications;
			const initialSourceLogEntries = [...Product.auditStore.getRange({ start: 1 })].length;
			await Product.put('p1', { title: 'first product' });
			const p1Cursor = [...Product.auditStore.getRange({ start: anchor })]
				.filter((entry) => entry.tableId === Product.tableId && entry.recordId === 'p1')
				.at(-1).txnLogKey;
			await waitFor(() => state.publications >= initialPublications + 1, { timeout: 10_000 });
			await new Promise((resolve) => setImmediate(resolve));

			await unregister();
			unregister = undefined;
			const reopened = new NativeFullTextDerivedIndexLifecycle(lifecycleOptions);
			await reopened.initialize();
			const inspection = reopened.inspect();
			assert.strictEqual(inspection.state, 'checkpointed');
			const documentId = `${Product.tableId}.${Buffer.from('p1').toString('base64url')}`;
			assert.deepStrictEqual(state.documents.get(documentId), {
				id: documentId,
				fields: { title: 'first product' },
			});
			const storedCursor = decodeFullTextCursorPayload(inspection.committedPayload);
			assert.strictEqual(storedCursor.logs.local, p1Cursor);
			assert(storedCursor.logs.local > anchor);
			assert.strictEqual(state.applications, initialApplications + 1);
			assert.strictEqual([...Product.auditStore.getRange({ start: 1 })].length, initialSourceLogEntries + 1);
		} finally {
			if (unregister) await unregister();
			await runtime.stop();
			runtime = undefined;
		}
	});

	it('rebuilds an incompatible native generation from the authoritative table', async () => {
		const Product = table({
			database: 'fulltext-derived-index-invalid-generation',
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		await Product.put('p1', { title: 'recover me' });
		const binding = new FakeNativeFullTextModule();
		const lifecycleOptions = {
			storePath: path.join(testPath, 'fulltext-indexes'),
			storeName: 'fulltext-derived-index-invalid-generation.Product.title',
			indexId: 'invalid-generation-products',
			sourceGeneration: 'product-table-generation',
			fields: [{ name: 'title' }],
			analyzer: 'english@2',
			limits: {
				indexingThreads: 1,
				searchThreads: 1,
				writerMemoryBytes: 32 * 1024 * 1024,
				maxQueuedCommands: 16,
				maxQueuedBytes: 64 * 1024 * 1024,
				maxBatchBytes: 8 * 1024 * 1024,
			},
			binding,
		};
		const seededLifecycle = new NativeFullTextDerivedIndexLifecycle(lifecycleOptions);
		await seededLifecycle.initialize();
		const seeded = await seededLifecycle.open();
		await seeded.close({ mode: 'rollback' });
		const selectedGeneration = binding.opens.at(-1).generation;
		binding.inspectError = 'E_SCHEMA_MISMATCH';

		const backend = await createNativeFullTextDerivedIndexBackend({
			id: 'invalid-generation-products',
			...lifecycleOptions,
		});
		runtime = new DerivedIndexRuntime(
			Product.auditStore,
			(_tableId, recordId) => {
				const entry = Product.primaryStore.getEntry(recordId);
				return entry?.value ? { version: entry.version, value: entry.value } : undefined;
			},
			{
				scanRecords: () =>
					Product.primaryStore.getRange({ versions: true }).map((entry) => ({
						recordId: entry.key,
						version: entry.version,
						value: entry.value,
					})),
			}
		);
		const unregister = runtime.register({
			backend,
			projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
			options: { flushAfterMutations: 1, maxFlushAgeMilliseconds: 10, rebuildBackoffMilliseconds: 1 },
		});
		try {
			await waitFor(() => runtime.getReadiness(backend.id).state === 'ready', { timeout: 10_000 });
			assert.strictEqual(binding.opens.at(-1).generation, selectedGeneration);
			assert.strictEqual(binding.resets, 1);
			const documentId = `${Product.tableId}.${Buffer.from('p1').toString('base64url')}`;
			assert.deepStrictEqual(binding.states.get(selectedGeneration).documents.get(documentId), {
				id: documentId,
				fields: { title: 'recover me' },
			});
		} finally {
			await unregister();
			await runtime.stop();
			runtime = undefined;
		}
	});

	it('produces the same full-text documents through replay and a fresh rebuild', async () => {
		const Product = table({
			database: 'fulltext-derived-index-replay-rebuild-parity',
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		await Product.put('p1', { title: 'first' });
		await Product.put('p2', { title: 'remove me' });
		const binding = new FakeNativeFullTextModule();
		const lifecycleOptions = {
			storePath: path.join(testPath, 'fulltext-indexes'),
			storeName: 'fulltext-derived-index-replay-rebuild-parity.Product.title',
			indexId: 'replay-rebuild-parity-products',
			sourceGeneration: 'product-table-generation',
			fields: [{ name: 'title' }],
			analyzer: 'english@2',
			limits: {
				indexingThreads: 1,
				searchThreads: 1,
				writerMemoryBytes: 32 * 1024 * 1024,
				maxQueuedCommands: 16,
				maxQueuedBytes: 64 * 1024 * 1024,
				maxBatchBytes: 8 * 1024 * 1024,
			},
			binding,
		};
		runtime = new DerivedIndexRuntime(
			Product.auditStore,
			(_tableId, recordId) => {
				const entry = Product.primaryStore.getEntry(recordId);
				return entry?.value ? { version: entry.version, value: entry.value } : undefined;
			},
			{
				scanRecords: () =>
					Product.primaryStore.getRange({ versions: true }).map((entry) => ({
						recordId: entry.key,
						version: entry.version,
						value: entry.value,
					})),
			}
		);
		let backend = await createNativeFullTextDerivedIndexBackend({
			id: 'replay-rebuild-parity-products',
			...lifecycleOptions,
		});
		let unregister = runtime.register({
			backend,
			projections: new Map([[Product.tableId, (record) => (record.title ? { title: record.title } : undefined)]]),
			options: { flushAfterMutations: 1, maxFlushAgeMilliseconds: 10, rebuildBackoffMilliseconds: 1 },
		});
		try {
			await waitFor(() => runtime.getReadiness(backend.id).state === 'ready', { timeout: 10_000 });
			await Product.patch('p1', { title: 'updated' });
			await Product.delete('p2');
			await Product.put('p3', { title: 'added' });
			await waitFor(
				() => {
					const documents = binding.states.get(binding.opens.at(-1).generation)?.documents;
					return documents?.size === 2 && [...documents.values()].some((document) => document.fields.title === 'added');
				},
				{ timeout: 10_000 }
			);
			const replayDocuments = normalizedDocuments(binding.states.get(binding.opens.at(-1).generation).documents);

			await unregister();
			unregister = undefined;
			binding.inspectError = 'E_SCHEMA_MISMATCH';
			backend = await createNativeFullTextDerivedIndexBackend({
				id: 'replay-rebuild-parity-products',
				...lifecycleOptions,
			});
			unregister = runtime.register({
				backend,
				projections: new Map([[Product.tableId, (record) => (record.title ? { title: record.title } : undefined)]]),
				options: { flushAfterMutations: 1, maxFlushAgeMilliseconds: 10, rebuildBackoffMilliseconds: 1 },
			});
			await waitFor(() => runtime.getReadiness(backend.id).state === 'ready', { timeout: 10_000 });
			const rebuiltDocuments = normalizedDocuments(binding.states.get(binding.opens.at(-1).generation).documents);
			assert.deepStrictEqual(rebuiltDocuments, replayDocuments);
		} finally {
			if (unregister) await unregister();
			await runtime.stop();
			runtime = undefined;
		}
	});
});

class FakeNativeFullTextModule {
	constructor() {
		this.NativeFullTextIndex = class {
			applyMutationBatch() {}
			publish() {}
			close() {}
			searchPage() {}
		};
		this.states = new Map();
		this.opens = [];
		this.resets = 0;
	}

	async runtimeInfo() {
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 9,
			queryClassIsolationMinimumSearchThreads: 2,
			lifecycleApiVersion: 1,
			mutationBatchApiVersion: 5,
			queryApiVersion: 4,
			storageBackends: ['native'],
			limits: {
				maxCommitPayloadBytes: 64 * 1024,
				maxRecordIdBytes: 4_096,
				maxRecordVersionBytes: 4_096,
				maxCandidateIds: 1_024,
				maxCandidateBytes: 1024 * 1024,
				maxSearchWindow: 10_000,
				maxSearchPageSize: 10_000,
				maxAutocompleteResults: 100,
				maxSearchResponseBytes: 8 * 1024 * 1024,
				maxSearchBudgetMilliseconds: 30_000,
				maxTraceRecords: 128,
				maxTraceSourceBytes: 1024 * 1024,
			},
		};
	}

	validateNativeFullTextIndexOptions() {}

	async reclaimRetiredNativeFullTextIndexes() {
		return { removed: 0, failed: 0 };
	}

	inspectNativeFullTextIndex(options) {
		if (this.inspectError) return { state: 'incompatible', code: this.inspectError };
		const state = this.states.get(options.generation);
		return state?.committedPayload
			? { state: 'checkpointed', committedPayload: state.committedPayload }
			: state
				? { state: 'cursorless' }
				: { state: 'missing' };
	}

	async resetNativeFullTextIndex() {
		this.resets++;
		this.inspectError = undefined;
		this.states.clear();
		return { state: 'missing' };
	}

	async openNativeFullTextIndex(options) {
		this.opens.push(options);
		let state = this.states.get(options.generation);
		if (!state) {
			state = { documents: new Map(), applications: 0, publications: 0, committedPayload: undefined };
			this.states.set(options.generation, state);
		}
		return {
			committedPayload: state.committedPayload,
			async applyMutationBatch(batch) {
				for (const document of batch.upserts)
					state.documents.set(document.id, { id: document.id, fields: { ...document.fields } });
				for (const id of batch.deletes) state.documents.delete(id);
				state.applications++;
				return {
					processed: batch.upserts.length + batch.deletes.length,
					rejected: [],
					encodedBytes: 1,
					frames: 1,
				};
			},
			async publish(payload) {
				state.committedPayload = payload;
				state.publications++;
				this.committedPayload = payload;
				return BigInt(state.publications);
			},
			async close() {
				return {};
			},
		};
	}

	async openNativeFullTextReader() {
		throw Object.assign(new Error('test reader is not configured'), { code: 'E_INDEX_NOT_READY' });
	}
}

function mutationsFor(backend, recordId) {
	return backend.deliveries.flatMap((batch) =>
		batch.transactions.flatMap((transaction) =>
			transaction.mutations.filter((mutation) => mutation.recordId === recordId)
		)
	);
}

function normalizedDocuments(documents) {
	return [...documents.values()]
		.map((document) => ({ id: document.id, fields: { ...document.fields } }))
		.sort((left, right) => left.id.localeCompare(right.id));
}
