const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
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
});
