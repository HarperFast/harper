// Worker half of originClosedFloor.test.js; the mocha glob loads this file too, hence the guard.
const { parentPort, workerData, threadId } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { Transaction } = require('@harperfast/rocksdb-js');

// gate (main -> here): Int32 the worker waits on before it lets a native commit proceed.
// epoch (main -> here): the number of floors main has published; a writer reads it before each commit.
const { mode, gate, epoch, tableName, writes } = workerData ?? {};
if (mode) run().catch((error) => parentPort.postMessage({ type: 'error', message: error.stack }));

async function run() {
	setupTestDBPath();
	setMainIsWorker(true);
	const Tbl = table({
		table: tableName,
		database: 'test',
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
	});
	parentPort.postMessage({ type: 'ready', threadId });
	if (mode === 'hold') {
		// Reserve a key, then stall the native commit until main opens the gate, as a commit-lane
		// write stall would. The reservation must hold the floor for the whole stall.
		const nativeCommit = Transaction.prototype.commit;
		Transaction.prototype.commit = function () {
			parentPort.postMessage({ type: 'reserved', key: this.getTimestamp() });
			Atomics.wait(gate, 0, 0);
			Transaction.prototype.commit = nativeCommit;
			return nativeCommit.call(this);
		};
		await transaction({}, () => Tbl.put({ id: 'held', n: 1 }));
		parentPort.postMessage({ type: 'committed' });
	} else if (mode === 'writer') {
		const results = [];
		const nativeCommit = Transaction.prototype.commit;
		let epochBefore = 0;
		Transaction.prototype.commit = function () {
			epochBefore = Atomics.load(epoch, 0);
			return nativeCommit.call(this);
		};
		for (let n = 0; n < writes; n++) {
			const hold = n % 7;
			await transaction({}, async () => {
				await Tbl.put({ id: `w${threadId}-${n}`, n });
				if (hold) await new Promise((resolve) => setTimeout(resolve, hold));
			});
			const entry = Tbl.primaryStore.getEntry(`w${threadId}-${n}`);
			results.push({ key: entry.version, epochBefore });
		}
		Transaction.prototype.commit = nativeCommit;
		parentPort.postMessage({ type: 'done', results });
	} else if (mode === 'exit') {
		Transaction.prototype.commit = function () {
			parentPort.postMessage({ type: 'reserved', key: this.getTimestamp(), threadId });
			process.exit(0);
		};
		await transaction({}, () => Tbl.put({ id: 'dying', n: 1 }));
	} else if (mode === 'park') {
		Transaction.prototype.commit = function () {
			parentPort.postMessage({ type: 'reserved', key: this.getTimestamp(), threadId });
			Atomics.wait(gate, 0, 0);
		};
		await transaction({}, () => Tbl.put({ id: 'parked', n: 1 }));
	}
}
