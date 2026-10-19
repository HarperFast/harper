const { parentPort } = require('node:worker_threads');
const {
	fullTextContinuationNow,
	fullTextContinuationDeadline,
} = require('#src/resources/indexes/fullTextContinuationClock');
const { resolveFullTextSearchLimits } = require('#src/resources/indexes/fullTextSearchLimits');
parentPort.on('message', () => {
	parentPort.postMessage({
		now: fullTextContinuationNow(),
		deadline: fullTextContinuationDeadline(resolveFullTextSearchLimits({ requestBudgetMilliseconds: 1234 })),
		admissionLoaded: Object.keys(require.cache).some((path) => /fullTextContinuation\.(js|ts)$/.test(path)),
	});
});
