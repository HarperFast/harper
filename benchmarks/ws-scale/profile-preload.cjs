// Only HTTP workers hold this benchmark's WebSocket connections.
//   start   holds a duration in seconds: CPU-profile this thread that long, then write thread-<id>.cpuprofile;
//           after consuming start, the worker stops polling
const { Session } = require('node:inspector');
const { threadId, workerData } = require('node:worker_threads');
const { existsSync, readFileSync, renameSync, writeFileSync } = require('node:fs');

const dir = process.env.WS_SCALE_CONTROL_DIR;

function profile(seconds) {
	const session = new Session();
	session.connect();
	session.post('Profiler.enable', () =>
		session.post('Profiler.setSamplingInterval', { interval: 250 }, () =>
			session.post('Profiler.start', (error) => {
				if (error) {
					session.disconnect();
					return;
				}
				writeFileSync(`${dir}/thread-${threadId}.started`, '');
				setTimeout(
					() =>
						session.post('Profiler.stop', (error, result) => {
							if (!error) {
								const profileFile = `${dir}/thread-${threadId}.cpuprofile`;
								writeFileSync(`${profileFile}.tmp`, JSON.stringify(result.profile));
								renameSync(`${profileFile}.tmp`, profileFile);
							}
							session.disconnect();
						}),
					seconds * 1000
				);
			})
		)
	);
}

if (workerData?.name === 'http') {
	const poll = setInterval(() => {
		if (!existsSync(`${dir}/start`)) return;
		clearInterval(poll);
		profile(Number(readFileSync(`${dir}/start`, 'utf8')));
	}, 250);
	poll.unref();
}
