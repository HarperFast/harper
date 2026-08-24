const { parentPort } = require('worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { database, table } = require('#src/resources/databases');
const { acquireUpdateAttributesLock } = require('#src/resources/Table');
const { ServerError } = require('#src/utility/errors/hdbError');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

setupTestDBPath();
setMainIsWorker(true);
const rootStore = database({ database: 'test', table: null });
let heldLock = false;

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
			code: caughtError.code,
			retryable: caughtError.retryable,
		};
	} finally {
		if (acquired) rootStore.unlock('update-attributes');
	}
	parentPort.postMessage({ type: 'deadline-result', action, acquired, elapsed: Date.now() - startTime, error });
}

parentPort
	?.on('message', (message) => {
		if (message.type === 'hold-lock') {
			heldLock = rootStore.tryLock('update-attributes');
			parentPort.postMessage({ type: 'held', acquired: heldLock });
		} else if (message.type === 'release-lock') {
			setTimeout(() => {
				if (heldLock) rootStore.unlock('update-attributes');
				heldLock = false;
				parentPort.postMessage({ type: 'released' });
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
			try {
				parentPort.postMessage({ type: 'table-created', created: Boolean(table(definition)) });
			} catch (error) {
				parentPort.postMessage({ type: 'table-created', created: false, error: error.message });
			}
		}
	})
	.ref();
