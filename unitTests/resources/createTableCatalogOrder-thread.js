const { parentPort, workerData } = require('worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { resetDatabases, databaseEventsEmitter } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// phase (main -> here): 0 idle, 1 the create is paused after its first attribute row, 2 the create
// returned. ack (here -> main): the number of scans completed. Absent when mocha's glob loads this
// file as a test on the main thread.
const { phase, ack, tableName } = workerData ?? {};
if (phase) run();

function run() {
	setupTestDBPath();
	setMainIsWorker(true);

	// updateTable is what replication turns into a DB_SCHEMA announcement to peers
	let updateTableEvents = 0;
	databaseEventsEmitter.on('updateTable', (Table) => {
		if (Table.tableName === tableName) updateTableEvents++;
	});

	function scan(type) {
		updateTableEvents = 0;
		const Table = resetDatabases().test?.[tableName];
		parentPort.postMessage({
			type,
			loaded: Boolean(Table),
			attributes: Table ? Table.attributes.map((attribute) => attribute.name) : [],
			updateTableEvents,
		});
	}

	Atomics.wait(phase, 0, 0);
	scan('mid-create');
	Atomics.store(ack, 0, 1);
	Atomics.notify(ack, 0);
	Atomics.wait(phase, 0, 1);
	scan('after-create');
	Atomics.store(ack, 0, 2);
	Atomics.notify(ack, 0);
}
