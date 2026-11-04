// GC requests:
//   gc-<n>  run a full garbage collection (Harper runs with --expose-gc), then write this thread's
//           process.memoryUsage() as JSON to gc-<n>-<threadId>
const { threadId, workerData } = require('node:worker_threads');
const { existsSync, renameSync, writeFileSync } = require('node:fs');

const dir = process.env.WS_SCALE_CONTROL_DIR;
let collections = 0;

// HTTP workers hold the connections; a transient worker (such as a job worker) answering a GC and then exiting
// would change the set of workers run.mts expects
if (workerData?.name === 'http') {
	const poll = setInterval(() => {
		while (existsSync(`${dir}/gc-${collections + 1}`)) {
			const collection = ++collections;
			globalThis.gc?.();
			setImmediate(() => {
				globalThis.gc?.();
				// renamed into place so run.mts never parses a half-written acknowledgement
				const ack = `${dir}/gc-${collection}-${threadId}`;
				writeFileSync(`${ack}.tmp`, JSON.stringify(globalThis.gc ? process.memoryUsage() : { error: 'no gc()' }));
				renameSync(`${ack}.tmp`, ack);
			});
		}
	}, 100);
	poll.unref();
}
