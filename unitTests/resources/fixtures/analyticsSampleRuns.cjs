'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const env = require('#src/utility/environment/environmentManager');
env.initSync();
const analytics = require('#src/resources/analytics/write');
parentPort.ref();

const { metric, samples } = workerData;
analytics.setAnalyticsEnabled(true);
let entry;
analytics.addAnalyticsListener((metrics) => {
	entry ??= metrics.find((candidate) => candidate.metric === metric);
});
// moves every entry after it and puts one entry in the array twice: the runs follow the entries' positions once
// the listeners are done, and the entry's buffers are still listed for transfer once
analytics.addAnalyticsListener((metrics) => {
	const tenth = metrics.find((candidate) => candidate.metric === metric + '-tenth');
	if (tenth) metrics.unshift(tenth);
});
let sent;
const postMessage = parentPort.postMessage;
parentPort.postMessage = function (message, transfer) {
	if (message?.type === 'analytics-report' && message.runs?.length) sent ??= message;
	return postMessage.call(this, message, transfer);
};
const record = analytics.actionRecorder(metric);
for (const [i, sample] of samples.entries()) {
	if (i % 2) record(sample);
	else analytics.recordAction(sample, metric);
}
for (let i = 0; i < 1000; i++) analytics.recordAction(0.1, metric + '-tenth');
const runsOf = (name) => sent?.runs.find((held) => sent.report.metrics[held.index]?.metric === name);
analytics.flushAnalyticsForExit().then(() => {
	parentPort.postMessage({
		type: 'sample-runs-entry',
		entry: entry && Object.keys(entry),
		detached: runsOf(metric)?.values.buffer.byteLength === 0,
		tenthRuns: runsOf(metric + '-tenth')?.length,
		runsSent: sent?.runs.length,
	});
	parentPort.close();
});
