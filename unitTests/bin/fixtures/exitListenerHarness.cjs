'use strict';

process.env.HARPER_SAFE_MODE = 'true';
require('#src/utility/environment/environmentManager').initTestEnvironment();
const { addExitListeners } = require('#src/bin/run');

addExitListeners();

const mode = process.argv[2];
if (mode === 'signal') {
	process.stdout.write('ready\n');
	setInterval(() => {}, 10000);
} else {
	process.exit(Number(mode));
}
