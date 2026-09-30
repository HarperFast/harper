// Loaded into every Harper worker via threads.preloadRequire when run.mts is given --profile or runs the churn
// scenario. run.mts drives it with files in WS_SCALE_CONTROL_DIR:
//   start   holds a duration in seconds: CPU-profile this thread that long, then write thread-<id>.cpuprofile
//   gc-<n>  run a full garbage collection (Harper runs with --expose-gc), then write this thread's
//           process.memoryUsage() as JSON to gc-<n>-<threadId>
const { Session } = require('node:inspector');
const { threadId, workerData } = require('node:worker_threads');
const { existsSync, readFileSync, renameSync, writeFileSync } = require('node:fs');

const dir = process.env.WS_SCALE_CONTROL_DIR;
let profiling = false;
let collections = 0;

function profile(seconds) {
	const session = new Session();
	session.connect();
	session.post('Profiler.enable', () =>
		session.post('Profiler.setSamplingInterval', { interval: 250 }, () =>
			session.post('Profiler.start', () =>
				setTimeout(
					() =>
						session.post('Profiler.stop', (error, result) => {
							if (!error) writeFileSync(`${dir}/thread-${threadId}.cpuprofile`, JSON.stringify(result.profile));
							session.disconnect();
						}),
					seconds * 1000
				)
			)
		)
	);
}

// HTTP workers hold the connections; a transient worker (such as a job worker) answering a GC and then exiting
// would change the set of workers run.mts expects
if (workerData?.name === 'http') {
	const poll = setInterval(() => {
		if (!profiling && existsSync(`${dir}/start`)) {
			profiling = true;
			profile(Number(readFileSync(`${dir}/start`, 'utf8')));
		}
		while (existsSync(`${dir}/gc-${collections + 1}`)) {
			collections++;
			globalThis.gc?.();
			// renamed into place so run.mts never parses a half-written acknowledgement
			const ack = `${dir}/gc-${collections}-${threadId}`;
			writeFileSync(`${ack}.tmp`, JSON.stringify(globalThis.gc ? process.memoryUsage() : { error: 'no gc()' }));
			renameSync(`${ack}.tmp`, ack);
		}
	}, 100);
	poll.unref();
}
