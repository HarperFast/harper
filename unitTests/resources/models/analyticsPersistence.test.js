require('../../testUtils');
const assert = require('node:assert');
const { setupTestDBPath, ensureSystemTables } = require('../../testUtils');
const {
	ModelCallAnalyticsWriter,
	getModelCallsTable,
	MODEL_CALL_ATTRIBUTES,
} = require('#src/resources/models/analyticsTable');
const { contextStorage, transaction } = require('#src/resources/transaction');
const { waitFor } = require('../../waitFor');
const { Models } = require('#src/resources/models/Models');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { setGenerative, removeIfCurrent } = require('#src/resources/models/backendRegistry');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { ACTION_32_BIT } = require('#src/resources/auditStore');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

describe('Model-call analytics persistence', function () {
	this.timeout(10000);
	let writer, modelTable, writerTable;
	const ids = [];

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		await ensureSystemTables();
		modelTable = getModelCallsTable();
	});

	beforeEach(() => {
		writerTable = modelTable;
		writer = new ModelCallAnalyticsWriter({ flushIntervalMs: 60000, cleanupIntervalMs: 60000 });
	});

	afterEach(async () => {
		writer?.stop();
		await writer?.flush();
		for (const id of ids.splice(0)) await writerTable?.primaryStore.remove(id);
	});

	async function persistMixedRows() {
		const records = [
			{
				backend: 'unknown',
				method: 'generate',
				model: 'missing',
				latency_ms: 1,
				success: false,
				error_code: 'backend_not_found',
			},
			{
				backend: 'deterministic',
				method: 'generate',
				model: 'probe',
				latency_ms: 2,
				success: true,
				prompt_tokens: 1,
				completion_tokens: 1,
			},
			{ backend: 'deterministic', method: 'generateStream', model: 'probe', latency_ms: 3, success: true },
		].flatMap((record) => [record, { ...record }]);
		for (const record of records) ids.push(writer.write(record));
		await writer.flush();

		for (let index = 0; index < ids.length; index++) {
			const entry = writerTable.primaryStore.getEntry(ids[index], { uncachedRead: true });
			assert.ok(entry?.version > 0, 'telemetry must carry its table-write version');
			assert.deepStrictEqual({ ...entry.value }, { ...records[index], id: ids[index] });
			if (isRocksDB) {
				const bytes = writerTable.primaryStore.getBinarySync(ids[index]);
				assert.strictEqual(bytes.readUint32BE(8) >>> 24, ACTION_32_BIT);
			}
		}
	}

	it('persists every mixed-shape telemetry row with version metadata', persistMixedRows);

	it('defers the default-cap batch outside its request and drains it after stop', async () => {
		writer.stop();
		const contexts = [];
		writer = new ModelCallAnalyticsWriter({
			getTable: () => {
				contexts.push(contextStorage.getStore());
				return modelTable;
			},
		});
		contextStorage.run({ signal: AbortSignal.abort() }, () => {
			for (let n = 0; n < 1000; n++)
				ids.push(writer.write({ backend: 'test', method: 'generate', latency_ms: 1, success: true }));
		});
		assert.strictEqual(contexts.length, 0, 'threshold writes must not enter the table factory');
		writer.stop();
		await writer.flush();
		assert.deepStrictEqual(contexts, [undefined]);
		for (const id of ids) assert.ok(modelTable.primaryStore.getEntry(id, { uncachedRead: true })?.version > 0);
	});

	it('joins an active batch before writing rows admitted during that batch', async () => {
		writer.stop();
		let factories = 0;
		writer = new ModelCallAnalyticsWriter({
			getTable: () => {
				factories++;
				return modelTable;
			},
		});
		ids.push(writer.write({ backend: 'first', method: 'generate', latency_ms: 1, success: true }));
		const first = writer.flush();
		await Promise.resolve();
		assert.strictEqual(factories, 1);
		ids.push(writer.write({ backend: 'second', method: 'generate', latency_ms: 1, success: true }));
		const second = writer.flush();
		assert.strictEqual(factories, 1);
		await Promise.all([first, second]);
		assert.strictEqual(factories, 2);
		for (const id of ids) assert.ok(modelTable.primaryStore.getEntry(id, { uncachedRead: true }));
	});

	it('bounds overload to one batch and one waiting buffer, then re-arms automatically', async () => {
		writer.stop();
		writer = new ModelCallAnalyticsWriter({ maxBufferSize: 2 });
		for (let n = 0; n < 6; n++)
			ids.push(writer.write({ backend: 'test', method: 'generate', latency_ms: 1, success: true }));
		assert.strictEqual(writer.bufferSize, 2);
		await waitFor(() => modelTable.primaryStore.getEntry(ids[3], { uncachedRead: true }));
		await writer.flush();
		for (const id of ids.slice(0, 4)) assert.ok(modelTable.primaryStore.getEntry(id, { uncachedRead: true }));
		for (const id of ids.slice(4))
			assert.strictEqual(modelTable.primaryStore.getEntry(id, { uncachedRead: true }), undefined);
		const next = writer.write({ backend: 'after-overload', method: 'generate', latency_ms: 1, success: true });
		ids.push(next);
		await writer.flush();
		assert.strictEqual(modelTable.primaryStore.getEntry(next, { uncachedRead: true }).value.backend, 'after-overload');
	});

	it('finishes at its admission watermark while later calls keep filling the buffer', async () => {
		writer.stop();
		let factories = 0;
		let refill = true;
		writer = new ModelCallAnalyticsWriter({
			maxBufferSize: 2,
			getTable: () => {
				factories++;
				if (refill && factories < 4) {
					for (let n = 0; n < 2; n++)
						ids.push(writer.write({ backend: 'later', method: 'generate', latency_ms: 1, success: true }));
				}
				return modelTable;
			},
		});
		for (let n = 0; n < 2; n++)
			ids.push(writer.write({ backend: 'first', method: 'generate', latency_ms: 1, success: true }));
		await writer.flush();
		assert.strictEqual(factories, 1, 'later admissions must not extend this flush');
		refill = false;
		writer.stop();
		await writer.flush();
		assert.strictEqual(factories, 2);
		for (const id of ids) assert.ok(modelTable.primaryStore.getEntry(id, { uncachedRead: true }));
	});

	it('persists Models facade calls through a threshold-triggered real writer', async () => {
		writer.stop();
		writer = new ModelCallAnalyticsWriter({ maxBufferSize: 2 });
		const name = 'analytics-persistence-facade';
		const backend = new TestBackend();
		setGenerative(name, backend);
		try {
			const models = new Models(writer);
			for (let n = 0; n < 3; n++) await models.generate('hello', { model: name });
			await writer.flush();
			const rows = [...modelTable.primaryStore.getKeys()]
				.map((key) => ({ key, ...modelTable.primaryStore.getEntry(key, { uncachedRead: true }) }))
				.filter((entry) => entry.value?.model === name);
			ids.push(...rows.map((entry) => entry.key));
			assert.strictEqual(rows.length, 3);
			for (const row of rows) {
				assert.strictEqual(row.value.success, true);
				assert.strictEqual(row.value.method, 'generate');
				assert.ok(row.version > 0);
			}
		} finally {
			removeIfCurrent('generative', name, backend);
		}
	});

	it('keeps the classic 0x42 fixture independent of earlier production-table shapes', async () => {
		writer.stop();
		writerTable = table({
			database: 'model_analytics_shapes',
			table: 'FreshModelCalls',
			audit: false,
			trackDeletes: false,
			attributes: MODEL_CALL_ATTRIBUTES.map((attribute) => ({ ...attribute })),
		});
		writer = new ModelCallAnalyticsWriter({
			flushIntervalMs: 60000,
			cleanupIntervalMs: 60000,
			getTable: () => writerTable,
		});
		await persistMixedRows();
		if (isRocksDB)
			assert.strictEqual(
				writerTable.primaryStore.getBinarySync(ids[4])[12],
				0x42,
				'the stream shape exercises classic structure id 0x42'
			);
	});

	it('rejects a failed batch commit, rolls back its rows, and can flush a later batch', async () => {
		const target = table({
			database: 'model_analytics_commit_failure',
			table: 'AnalyticsCommitFailure',
			audit: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'latency_ms', type: 'Int' },
			],
		});
		writer.stop();
		writer = new ModelCallAnalyticsWriter({ flushIntervalMs: 60000, cleanupIntervalMs: 60000, getTable: () => target });
		const good = writer.write({ backend: 'test', method: 'generate', latency_ms: 1, success: true });
		const bad = writer.write({ backend: 'test', method: 'generate', latency_ms: 'invalid', success: true });
		await assert.rejects(writer.flush());
		assert.strictEqual(target.primaryStore.getEntry(good), undefined);
		assert.strictEqual(target.primaryStore.getEntry(bad), undefined);
		const next = writer.write({ backend: 'test', method: 'generate', latency_ms: 2, success: true });
		await writer.flush();
		assert.strictEqual(target.primaryStore.getEntry(next, { uncachedRead: true }).value.latency_ms, 2);
		await target.primaryStore.remove(next);
	});

	it('reports an automatic batch failure to its joiner and continues with the waiting batch', async () => {
		writer.stop();
		writerTable = table({
			database: 'model_analytics_failure_lifecycle',
			table: 'Calls',
			audit: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'latency_ms', type: 'Int' },
			],
		});
		writer = new ModelCallAnalyticsWriter({ maxBufferSize: 1, getTable: () => writerTable });
		const bad = writer.write({ backend: 'test', method: 'generate', latency_ms: 'invalid', success: true });
		const good = writer.write({ backend: 'test', method: 'generate', latency_ms: 2, success: true });
		ids.push(bad, good);
		await assert.rejects(writer.flush());
		await writer.flush();
		assert.strictEqual(writerTable.primaryStore.getEntry(bad), undefined);
		assert.strictEqual(writerTable.primaryStore.getEntry(good, { uncachedRead: true }).value.latency_ms, 2);
	});

	it('commits a flush independently of an ambient transaction that aborts', async () => {
		const id = writer.write({ backend: 'deterministic', method: 'generate', latency_ms: 1, success: false });
		ids.push(id);
		await assert.rejects(
			transaction({}, async () => {
				await writer.flush();
				throw new Error('abort the request');
			}),
			/abort the request/
		);
		const entry = modelTable.primaryStore.getEntry(id, { uncachedRead: true });
		assert.strictEqual(entry?.value?.backend, 'deterministic');
		assert.ok(entry.version > 0);
	});
});
