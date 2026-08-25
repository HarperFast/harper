'use strict';

const { armRestartExitWatchdog } = require('#src/bin/restartExitWatchdog');

armRestartExitWatchdog(Number(process.argv[2])).then((armed) => {
	if (!armed) process.exit(2);
	process.stdout.write('armed\n');
});
setInterval(() => {}, 10000);
