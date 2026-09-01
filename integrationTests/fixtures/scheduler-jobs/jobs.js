import { closeSync, openSync } from 'node:fs';
import { workerData } from 'node:worker_threads';

const crashMarker = process.env.HARPER_TEST_CRASH_INITIAL_HTTP_WORKER_MARKER;
if (crashMarker && workerData?.name === 'http' && workerData.workerIndex === 0) {
	let marker;
	try {
		marker = openSync(crashMarker, 'wx');
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
	}
	if (marker !== undefined) {
		closeSync(marker);
		process._realExit(1);
	}
}

// Scheduled job handler for the scheduler integration test. Each run inserts a
// row; the random id surfaces duplicate fires (two workers or two nodes running
// the same occurrence would produce two rows for the same tick).
export async function recordTick(context) {
	await tables.SchedulerTick.put({
		id: `${context.jobName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		jobName: context.jobName,
		catchUp: context.catchUp,
	});
}
