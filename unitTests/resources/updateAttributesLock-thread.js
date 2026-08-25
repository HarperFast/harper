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

const DEADLINE_DEFINITION = {
	table: 'DeadlineWedged',
	database: 'test',
	attributes: [{ name: 'id', type: 'Int', isPrimaryKey: true }],
};
const DEADLINE_REDECLARATION = {
	...DEADLINE_DEFINITION,
	attributes: [...DEADLINE_DEFINITION.attributes, { name: 'added', type: 'String', indexed: true }],
};
let deadlineTable;

function reportDeadline(action, callback, { selfLock = true, extra } = {}) {
	const acquired = selfLock ? rootStore.tryLock('update-attributes') : false;
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
	parentPort.postMessage({
		type: 'deadline-result',
		action,
		acquired,
		elapsed: Date.now() - startTime,
		error,
		...extra?.(),
	});
}

function liveSchema(Table) {
	return {
		attributes: Table.attributes.map((attribute) => attribute.name),
		indices: Object.keys(Table.indices),
		schemaVersion: Table.schemaVersion,
		description: Table.description ?? null,
		hidden: Table.hidden ?? null,
		cacheControl: Table.cacheControl ?? null,
		schemaDefined: Table.schemaDefined ?? null,
	};
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
		} else if (message.type === 'prepare-deadline-table') {
			deadlineTable = table(DEADLINE_DEFINITION);
			parentPort.postMessage({ type: 'deadline-table-prepared', before: liveSchema(deadlineTable) });
		} else if (message.type === 'declare-under-wedge') {
			// snapshot around this call alone: unrelated schema activity between messages would
			// otherwise show up as drift
			const before = liveSchema(deadlineTable);
			reportDeadline(message.type, () => table(DEADLINE_REDECLARATION), {
				selfLock: false,
				extra: () => ({ before, after: liveSchema(deadlineTable) }),
			});
		} else if (message.type === 'redeclare') {
			try {
				parentPort.postMessage({
					type: 'table-updated',
					updated: Boolean(table(DEADLINE_REDECLARATION)),
					applied: liveSchema(deadlineTable),
				});
			} catch (error) {
				parentPort.postMessage({ type: 'table-updated', updated: false, error: error.message });
			}
		}
	})
	.ref();
