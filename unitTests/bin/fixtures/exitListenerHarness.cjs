'use strict';

process.env.HARPER_SAFE_MODE = 'true';
const env = require('#src/utility/environment/environmentManager');
env.initTestEnvironment();
const { addExitListeners } = require('#src/bin/run');

addExitListeners();

const mode = process.argv[2];
if (mode === 'signal' || mode === 'stalled-shutdown') {
	if (mode === 'stalled-shutdown') {
		// a main-thread shutdown that never finishes, bounded only by threads.shutdownTimeout or a second signal
		require('#src/server/threads/processShutdown').registerMainThreadShutdown(() => new Promise(() => {}));
		env.setProperty(require('#src/utility/hdbTerms').CONFIG_PARAMS.THREADS_SHUTDOWNTIMEOUT, Number(process.argv[3]));
	}
	process.stdout.write('ready\n');
	setInterval(() => {}, 10000);
} else {
	process.exit(Number(mode));
}
