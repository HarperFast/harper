'use strict';

require('../testUtils');
const { parentPort } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { createBlob } = require('#src/resources/blob');
const { logger } = require('#src/utility/logging/logger');
const { onMessageByType, setMainIsWorker } = require('#js/server/threads/manageThreads');

const MESSAGE_TYPE = 'drop-table-cross-worker-test';
const CONTROL_TYPE = 'drop-table-cross-worker-control';
const report = (event, details = {}) => parentPort.postMessage({ type: MESSAGE_TYPE, event, ...details });

let TestTable;

function runWorkerFixture() {
	onMessageByType(CONTROL_TYPE, () => {});
	setupTestDBPath();
	setMainIsWorker(true);
	process.on('unhandledRejection', (error) => report('unhandled-rejection', { error: error?.stack ?? String(error) }));
	const originalError = logger.error;
	logger.error = (...args) => {
		report('logged-error', {
			message: args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
		});
		return originalError?.apply(logger, args);
	};
	parentPort.on('message', async (message) => {
		if (message.type !== CONTROL_TYPE) return;
		try {
			switch (message.command) {
				case 'define':
					TestTable = table({
						table: message.table,
						database: 'test',
						audit: true,
						attributes: [
							{ name: 'id', isPrimaryKey: true },
							{ name: 'blob', type: 'Blob' },
						],
					});
					// A blob defers the cache write's native commit until the blob file has been written,
					// which is what lets the drop on the other thread land while the commit is in flight.
					TestTable.sourcedFrom({
						get: async (id) => ({ id, blob: await createBlob(Buffer.alloc(100000, 1)) }),
						available: () => true,
					});
					report('defined');
					break;
				case 'get': {
					const { id } = message;
					// getFromSource resolves the caller before its cache write has committed, and holds the
					// record lock until that write has settled either way.
					TestTable.get(id, {}).then(
						async () => {
							report('get-resolved', { commitInFlight: TestTable.primaryStore.hasLock(id) });
							try {
								await waitFor(() => !TestTable.primaryStore.hasLock(id), {
									timeout: 30000,
									message: 'the source-fill cache write should settle',
								});
								report('commit-settled');
							} catch (error) {
								report('settle-error', { error: error?.stack ?? String(error) });
							}
						},
						(error) => report('get-rejected', { error: error?.stack ?? String(error) })
					);
					break;
				}
			}
		} catch (error) {
			report('error', { error: error?.stack ?? String(error) });
		}
	});
	// keep the thread alive: manageThreads unrefs parentPort
	setInterval(() => {}, 1000);
	report('booted');
}

if (parentPort) runWorkerFixture();
