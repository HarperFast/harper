const { threadId } = require('node:worker_threads');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { Session } = require('node:inspector/promises');
const { setTimeout: delay } = require('node:timers/promises');

let profile, mainProfile;

function countsFor(result) {
	const counts = {};
	for (const script of result) {
		if (
			!/\/resources\/indexes\/fullText(?:SearchLimits|Continuation|ContinuationLease|QueryProtocol)\.js$/.test(
				script.url
			)
		)
			continue;
		for (const fn of script.functions) {
			if (
				![
					'resolveFullTextSearchLimits',
					'request',
					'dispatch',
					'read',
					'fullTextContinuationRequest',
					'fullTextContinuationResponse',
					'replayFullTextPrefix',
				].includes(fn.functionName)
			)
				continue;
			const key = `${script.url.split('/').pop()}:${fn.functionName}`;
			counts[key] = (counts[key] ?? 0) + fn.ranges[0].count;
		}
	}
	return counts;
}

exports.runBenchmark = async function (body, Product, Control, context) {
	if (body.action === 'profile-start') {
		if (body.main && !mainProfile) {
			mainProfile = new Session();
			mainProfile.connectToMainThread();
			await mainProfile.post('Profiler.enable');
			await mainProfile.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
		}
		if (!profile) {
			profile = new Session();
			profile.connect();
			await profile.post('Profiler.enable');
			await profile.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
		}
		return { worker: threadId };
	}
	if (body.action === 'profile-stop') {
		if (!profile) return { worker: threadId };
		const { result } = await profile.post('Profiler.takePreciseCoverage');
		await profile.post('Profiler.stopPreciseCoverage');
		profile.disconnect();
		profile = undefined;
		let mainCounts;
		if (mainProfile) {
			const main = await mainProfile.post('Profiler.takePreciseCoverage');
			await mainProfile.post('Profiler.stopPreciseCoverage');
			mainProfile.disconnect();
			mainProfile = undefined;
			mainCounts = countsFor(main.result);
		}
		return { worker: threadId, counts: countsFor(result), mainCounts };
	}
	if (body.action === 'control') {
		const record = await Control.get('control', context);
		return { worker: threadId, value: record.value };
	}
	const histogram = monitorEventLoopDelay({ resolution: 1 });
	histogram.enable();
	await delay(5);
	histogram.reset();
	const memory = process.memoryUsage();
	const utilization = performance.eventLoopUtilization();
	const started = performance.now();
	let result, error;
	try {
		const query = { ...body.query, checkPermission: true };
		if (query.continuation !== undefined) result = await Product.search(query, context);
		else {
			result = [];
			for await (const record of Product.search(query, context)) result.push(record);
		}
	} catch (failure) {
		error = { status: failure.statusCode, message: failure.message };
	}
	const milliseconds = performance.now() - started;
	const loop = performance.eventLoopUtilization(utilization);
	await delay(2);
	histogram.disable();
	const after = process.memoryUsage();
	return {
		worker: threadId,
		records: result,
		continuation: result?.continuation,
		complete: result?.complete,
		error,
		milliseconds,
		eventLoopMaxMilliseconds: histogram.max / 1e6,
		eventLoopUtilization: loop.utilization,
		heapDeltaBytes: after.heapUsed - memory.heapUsed,
		processRssBytes: after.rss,
	};
};
