const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

describe('history reader benchmarks', function () {
	this.timeout(600_000);
	const rows = Number(process.env.HISTORY_BENCH_ROWS ?? 50_000);
	const patches = Number(process.env.HISTORY_BENCH_PATCHES ?? 2_880);
	const repetitions = Number(process.env.HISTORY_BENCH_REPETITIONS ?? 3);
	let sequence = 0;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	function newTable() {
		return table({
			database: 'history_reader_benchmark',
			table: `HistoryBenchmark${++sequence}`,
			schemaDefined: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'name' }],
		});
	}
	async function measure(T, id, expectedCount, expectedN = expectedCount - 1) {
		const elapsedMs = [];
		const cpuMs = [];
		const auditReads = [];
		for (let repetition = 0; repetition < repetitions; repetition++) {
			const originals = new Map();
			let reads = 0;
			for (const method of ['get', 'getSync', 'getRange', 'getBinary']) {
				const original = T.auditStore[method];
				originals.set(method, original);
				T.auditStore[method] = function (...args) {
					if (method === 'getRange' ? args[0]?.snapshot !== false : method === 'getBinary' || args[1] === T.tableId)
						reads++;
					return original.apply(this, args);
				};
			}
			try {
				const cpuStart = process.cpuUsage();
				const start = performance.now();
				const history = await T.getHistoryOfRecord(id);
				elapsedMs.push(performance.now() - start);
				const cpu = process.cpuUsage(cpuStart);
				cpuMs.push((cpu.user + cpu.system) / 1000);
				auditReads.push(reads);
				assert.strictEqual(history.length, expectedCount);
				assert.strictEqual(history.at(-1).value.n, expectedN);
			} finally {
				for (const [method, original] of originals) T.auditStore[method] = original;
			}
		}
		return { elapsedMs, cpuMs, auditReads };
	}
	it('lists the first, middle and last rows of a bulk frame plus 20 patches', async () => {
		const T = newTable();
		await transaction(async () => {
			for (let i = 0; i < rows; i++) await T.put({ id: `bulk-${i}`, n: i, name: 'initial' });
		});
		for (const row of [0, Math.floor(rows / 2), rows - 1])
			for (let n = 1; n <= 20; n++) await T.patch(`bulk-${row}`, { name: `patch-${n}` });
		for (const row of [0, Math.floor(rows / 2), rows - 1])
			console.log(
				'HISTORY_BENCH',
				JSON.stringify({
					kind: 'bulk',
					engine: process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb',
					rows,
					row,
					patches: 20,
					...(await measure(T, `bulk-${row}`, 21, row)),
				})
			);
	});
	it('lists a many-patch single-record history', async () => {
		const T = newTable();
		await T.put({ id: 'patched', n: 0, name: 'initial' });
		for (let n = 1; n <= patches; n++) await T.patch('patched', { n });
		console.log(
			'HISTORY_BENCH',
			JSON.stringify({
				kind: 'many-patch',
				engine: process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb',
				patches,
				...(await measure(T, 'patched', patches + 1)),
			})
		);
	});
	it('lists an evicted many-patch single-record history', async () => {
		const T = newTable();
		await T.put({ id: 'evicted', n: 0 });
		for (let n = 1; n <= patches; n++) await T.patch('evicted', { n });
		const entry = T.primaryStore.getEntry('evicted');
		await T.evict('evicted', entry.value, entry.version);
		await waitFor(() => T.primaryStore.getEntry('evicted') === undefined);
		console.log(
			'HISTORY_BENCH',
			JSON.stringify({
				kind: 'evicted-many-patch',
				engine: process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb',
				patches,
				...(await measure(T, 'evicted', patches + 1)),
			})
		);
	});

	it('measures full live, streaming and replay reads of a bulk patch frame', async () => {
		const frameRows = Number(process.env.HISTORY_BENCH_FRAME_ROWS ?? 1000);
		const T = newTable();
		await transaction(async () => {
			for (let i = 0; i < frameRows; i++) await T.put({ id: `frame-${i}`, n: 0 });
		});
		const startTime = Date.now() - 1;
		const events = [];
		const subscription = await T.subscribe({ isCollection: true, omitCurrent: true, includeSuperseded: true });
		subscription.on('data', (event) => {
			if (event.value) events.push(event);
		});
		async function measured(kind, work) {
			let reads = 0;
			const original = T.auditStore.getRange;
			T.auditStore.getRange = function (...args) {
				if (args[0]?.snapshot !== false) reads++;
				return original.apply(this, args);
			};
			const cpuStart = process.cpuUsage(),
				start = performance.now();
			try {
				await work();
				const cpu = process.cpuUsage(cpuStart);
				console.log(
					'HISTORY_BENCH',
					JSON.stringify({
						kind,
						engine: process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb',
						rows: frameRows,
						repetitions: 1,
						elapsedMs: performance.now() - start,
						cpuMs: (cpu.user + cpu.system) / 1000,
						rangeReads: reads,
					})
				);
			} finally {
				T.auditStore.getRange = original;
			}
		}
		try {
			await measured('bulk-patch-live-including-commit', async () => {
				await transaction(async () => {
					for (let i = 0; i < frameRows; i++) await T.patch(`frame-${i}`, { n: 1 });
				});
				await waitFor(() => events.length >= frameRows, { timeout: 120000 });
				assert.strictEqual(events.length, frameRows);
				assert(events.every((event) => event.value.n === 1));
			});
		} finally {
			subscription.end();
		}
		await measured('bulk-patch-stream', async () => {
			const history = await Array.fromAsync(T.getHistory());
			assert.strictEqual(history.length, frameRows * 2);
			assert.strictEqual(history.filter((entry) => entry.type === 'patch' && entry.value.n === 1).length, frameRows);
		});
		await measured('bulk-patch-replay', async () => {
			const events = [];
			const replay = await T.subscribe({ isCollection: true, startTime, includeSuperseded: true });
			replay.on('data', (event) => {
				if (event.value) events.push(event);
			});
			try {
				await waitFor(() => events.filter((event) => event.value.n === 1).length >= frameRows, { timeout: 120000 });
				assert.strictEqual(events.filter((event) => event.value.n === 1).length, frameRows);
			} finally {
				replay.end();
			}
		});
	});
});
