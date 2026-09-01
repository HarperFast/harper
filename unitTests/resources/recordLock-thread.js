// Worker for recordLock.test.js: holds and releases record locks, and runs serialized increments,
// on another thread sharing the test database.
require('../testUtils');
const { parentPort, threadId } = require('worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
require('#src/server/serverHelpers/serverUtilities');

setupTestDBPath();
setMainIsWorker(true);
const LockTest = table({
	table: 'RecordLockThread',
	database: 'test',
	attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
});
let held;
parentPort
	?.on('message', async (message) => {
		try {
			switch (message.type) {
				case 'hold':
					held = await LockTest.lock(message.id, { hold: true, lease: message.lease ?? 5000 });
					parentPort.postMessage({ type: 'held', id: message.id });
					break;
				case 'release': {
					const cleared = await held.unlock();
					parentPort.postMessage({ type: 'released', cleared });
					break;
				}
				case 'increment': {
					// `end` is taken before the commit (and so before the release): the critical section of
					// one holder must end before the next holder's lock commits
					const intervals = [];
					for (let i = 0; i < message.count; i++) {
						await transaction(async () => {
							const record = await LockTest.lock(message.id);
							const start = Date.now();
							record.set('n', (record.getProperty('n') ?? 0) + 1);
							await record.save();
							intervals.push({ start, end: Date.now(), worker: threadId });
						});
					}
					parentPort.postMessage({ type: 'incremented', intervals });
					break;
				}
				case 'shutdown':
					process.exit(0);
			}
		} catch (error) {
			parentPort.postMessage({
				type: 'error',
				message: error.message,
				stack: error.stack,
				statusCode: error.statusCode,
			});
		}
	})
	.ref();
