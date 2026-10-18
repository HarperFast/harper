const { parentPort } = require('node:worker_threads');
const { fullTextContinuationOwner } = require('#src/resources/indexes/fullTextContinuationOwner');

fullTextContinuationOwner().then(
	() => parentPort.postMessage({ message: 'Unexpected continuation owner' }),
	(error) => parentPort.postMessage({ message: error.message, statusCode: error.statusCode })
);
