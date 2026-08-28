'use strict';

require('../testUtils');
const { parentPort } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { createBlob } = require('#src/resources/blob');
const { logger } = require('#src/utility/logging/logger');
const { onMessageByType } = require('#js/server/threads/manageThreads');

const MESSAGE_TYPE = 'drop-table-cross-worker-test';
const CONTROL_TYPE = 'drop-table-cross-worker-control';
const report = (event, details = {}) => parentPort.postMessage({ type: MESSAGE_TYPE, event, ...details });

let TestTable;

function runWorkerFixture() {
	onMessageByType(CONTROL_TYPE, () => {});
	setupTestDBPath();
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
				case 'get':
					// getFromSource resolves the caller before its cache write has committed
					TestTable.get(message.id, {}).then(
						() => report('get-resolved'),
						(error) => report('get-rejected', { error: error?.stack ?? String(error) })
					);
					break;
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
