require('../../testUtils');
const assert = require('node:assert');
const { setupTestDBPath, ensureSystemTables } = require('../../testUtils');
const {
	ModelCallAnalyticsWriter,
	getModelCallsTable,
	MODEL_CALL_ATTRIBUTES,
} = require('#src/resources/models/analyticsTable');
const { transaction } = require('#src/resources/transaction');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { ACTION_32_BIT } = require('#src/resources/auditStore');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

describe('Model-call analytics persistence', () => {
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
			database: 'test',
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
