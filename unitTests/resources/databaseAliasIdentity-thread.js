'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { closeLoadedDatabases, getDatabases } = require('#src/resources/databases');
const { onMessageByType, setMainIsWorker } = require('#js/server/threads/manageThreads');

const MESSAGE_TYPE = 'database-alias-identity-test';
const CONTROL_TYPE = 'database-alias-identity-control';
const report = (event, details = {}) => parentPort.postMessage({ type: MESSAGE_TYPE, event, ...details });

function aliasState() {
	const databases = getDatabases();
	return Object.fromEntries(workerData.databaseAliasIdentityAliases.map((name) => [name, Boolean(databases[name])]));
}

function run() {
	require('#js/server/threads/itc');
	setMainIsWorker(true);
	onMessageByType(CONTROL_TYPE, () => {});
	const keepAlive = setInterval(() => {}, 1000);
	parentPort.on('message', (message) => {
		if (message.type === CONTROL_TYPE && message.command === 'inspect') report('inspected', { aliases: aliasState() });
		if (message.type === CONTROL_TYPE && message.command === 'close') {
			closeLoadedDatabases();
			clearInterval(keepAlive);
			report('closed');
			parentPort.close();
		}
	});
	report('booted', { aliases: aliasState() });
}

if (parentPort) run();
