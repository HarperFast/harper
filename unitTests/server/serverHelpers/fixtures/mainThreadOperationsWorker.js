'use strict';

const { parentPort } = require('node:worker_threads');
const registeredOperations = require('#src/server/serverHelpers/registeredOperations');
const { validateOperations } = require('#src/utility/operationPermissions');

const forwards = (name) => typeof registeredOperations.getRemoteOperationFunction(name) === 'function';
const grantable = (name) => validateOperations([name]) === null;

parentPort.on('message', ({ announce, names }) => {
	for (const message of announce) registeredOperations.operationRegisteredHandler({ message });
	parentPort.postMessage(
		Object.fromEntries(names.map((name) => [name, { forwards: forwards(name), grantable: grantable(name) }]))
	);
});
parentPort.postMessage('ready');
