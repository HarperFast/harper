'use strict';

const { armRestartExitWatchdog } = require('#src/bin/restartExitWatchdog');

if (!armRestartExitWatchdog(Number(process.argv[2]))) process.exit(2);
process.stdout.write('armed\n');
setInterval(() => {}, 10000);
