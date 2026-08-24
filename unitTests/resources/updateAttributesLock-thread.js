require('../testUtils');
const { parentPort } = require('worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { database, table } = require('#src/resources/databases');
const { acquireUpdateAttributesLock } = require('#src/resources/Table');
const { ServerError } = require('#src/utility/errors/hdbError');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

setupTestDBPath();
setMainIsWorker(true);
const rootStore = database({ database: 'test', table: null });

function reportDeadline(action, callback) {
	const acquired = rootStore.tryLock('update-attributes');
	const startTime = Date.now();
	let error;
	try {
		callback();
	} catch (caughtError) {
		error = {
			isServerError: caughtError instanceof ServerError,
			message: caughtError.message,
			statusCode: caughtError.statusCode,
		};
	} finally {
		if (acquired) rootStore.unlock('update-attributes');
	}
	parentPort.postMessage({ type: 'deadline-result', action, acquired, elapsed: Date.now() - startTime, error });
}

parentPort
	?.on('message', (message) => {
		if (message.type === 'hold-lock') {
			const acquired = rootStore.tryLock('update-attributes');
			parentPort.postMessage({ type: 'held', acquired });
			setTimeout(() => {
				rootStore.unlock('update-attributes');
			}, message.holdTime);
		} else if (message.type === 'helper-deadline') {
			reportDeadline(message.type, () =>
				acquireUpdateAttributesLock(rootStore, "table 'test.Wedged'", message.timeout)
			);
		} else if (message.type === 'table-deadline') {
			const definition = {
				table: 'DeadlineWedged',
				database: 'test',
				attributes: [{ name: 'id', type: 'Int', isPrimaryKey: true }],
			};
			reportDeadline(message.type, () => table(definition));
			parentPort.postMessage({ type: 'table-created', created: Boolean(table(definition)) });
		} else if (message.type === 'shutdown') {
			process.exit(0);
		}
	})
	.ref();
