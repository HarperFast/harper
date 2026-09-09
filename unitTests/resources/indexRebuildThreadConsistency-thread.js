const { parentPort, workerData } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { resetDatabases } = require('#src/resources/databases');
const manageThreads = require('#js/server/threads/manageThreads');
const { setMainIsWorker } = manageThreads;

// A thread that never declares the schema: it reaches Table.indices only through the catalog reload
// (resetDatabases -> initStores), which is what the main and operations threads do in a running node.
// Probing is driven by the test with Atomics rather than by an ITC schema event, so the backfill can be
// held at a known point; the reload it performs is the same one the ITC handler performs.
const { phase, ack, tableName, attributeName, probeValue, probeId } = workerData ?? {};
if (phase) run();

async function run() {
	setupTestDBPath();
	setMainIsWorker(true);
	for (let step = 0; step < 3; step++) {
		Atomics.wait(phase, 0, step);
		await probe(step + 1);
		Atomics.store(ack, 0, step + 1);
		Atomics.notify(ack, 0);
	}
}

async function probe(step) {
	const message = {
		step,
		loaded: false,
		isIndexing: null,
		hits: null,
		searchError: null,
		foundById: false,
		processIncarnation: manageThreads.processIncarnation,
	};
	try {
		const Table = resetDatabases().test?.[tableName];
		message.loaded = Boolean(Table);
		if (Table) {
			message.isIndexing = Table.indices[attributeName]?.isIndexing ?? null;
			try {
				const hits = [];
				for await (const record of Table.search({
					allowFullScan: false,
					conditions: [{ attribute: attributeName, value: probeValue }],
				}))
					hits.push(record);
				message.hits = hits.length;
			} catch (error) {
				message.searchError = error?.message ?? String(error);
			}
			message.foundById = Boolean(await Table.get(probeId));
		}
	} catch (error) {
		message.failure = error.message;
	}
	parentPort.postMessage(message);
}
