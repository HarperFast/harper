// Loaded into every Harper worker via threads.preloadRequire when run.mts is given --profile. Waits
// for run.mts to write <dir>/start (containing the duration in seconds), then CPU-profiles this
// thread for that long and writes <dir>/thread-<id>.cpuprofile.
const { Session } = require('node:inspector');
const { threadId } = require('node:worker_threads');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');

const dir = process.env.WS_SCALE_PROFILE_DIR;
const poll = setInterval(() => {
	if (!existsSync(`${dir}/start`)) return;
	clearInterval(poll);
	const seconds = Number(readFileSync(`${dir}/start`, 'utf8'));
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
}, 250);
poll.unref();
