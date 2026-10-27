// Worker half of originClosedFloor.test.js; the mocha glob loads this file too, hence the guard.
const { parentPort, workerData, threadId } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();

const {
	mode,
	gate,
	epoch,
	tableName,
	writes,
	// a writer holds every seventh transaction open for a few ms; `paced: false` writes flat out
	paced = true,
	database = 'test',
	attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
	record = { id: 'parked-reserving', n: 1 },
} = workerData ?? {};
if (mode) run().catch((error) => parentPort.postMessage({ type: 'error', message: error.stack }));

async function run() {
	setupTestDBPath();
	setMainIsWorker(true);
	const Tbl = table({
		table: tableName,
		database,
		audit: true,
		attributes,
	});
	parentPort.postMessage({ type: 'ready', threadId });
	if (mode === 'hold') {
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
			const hold = paced ? n % 7 : 0;
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
	} else if (mode === 'exit-after-submit') {
		// The commit is in the native lane when the thread dies; env teardown drains it.
		const nativeCommit = Transaction.prototype.commit;
		Transaction.prototype.commit = function () {
			const committing = nativeCommit.call(this);
			parentPort.postMessage({ type: 'reserved', key: this.getTimestamp(), threadId });
			process.exit(0);
			return committing;
		};
		await transaction({}, () => Tbl.put({ id: 'dying-submitted', n: 1 }));
	} else if (mode === 'park') {
		Transaction.prototype.commit = function () {
			parentPort.postMessage({ type: 'reserved', key: this.getTimestamp(), threadId });
			Atomics.wait(gate, 0, 0);
		};
		await transaction({}, () => Tbl.put({ id: 'parked', n: 1 }));
	} else if (mode === 'park-reserving') {
		parkInsideNextReservation('getTimestamp');
		await transaction({}, () => Tbl.put(record));
		parentPort.postMessage({ type: 'committed' });
	} else if (mode === 'park-rekeying') {
		// an explicit timestamp is never a key, so the reservation mints one and installs it: park there
		parkInsideNextReservation('setTimestamp');
		await transaction({ timestamp: Date.now() - 60_000 }, () => Tbl.put(record));
		parentPort.postMessage({ type: 'committed' });
	} else if (mode === 'hold-then-park-reserving') {
		let commitHeld;
		const held = transaction({}, async () => {
			await Tbl.put({ id: 'held-outstanding', n: 1 });
			await new Promise((resolve) => (commitHeld = resolve));
		});
		while (!commitHeld) await new Promise((resolve) => setImmediate(resolve));
		parentPort.postMessage({ type: 'held' });
		await new Promise((resolve) => parentPort.once('message', resolve));
		parkInsideNextReservation('getTimestamp');
		await transaction({}, () => Tbl.put(record));
		commitHeld();
		await held;
		parentPort.postMessage({ type: 'committed' });
	}
}

// Stops inside the reservation, while its slot still says pending: before the key is decided at
// `getTimestamp`, after it at `setTimestamp`.
function parkInsideNextReservation(method) {
	const native = Transaction.prototype[method];
	Transaction.prototype[method] = function (...args) {
		if (/ThreadRegistry\.reserve\b/.test(new Error().stack)) {
			Transaction.prototype[method] = native;
			parentPort.postMessage({ type: 'parked' });
			Atomics.wait(gate, 0, 0);
		}
		return native.apply(this, args);
	};
}
