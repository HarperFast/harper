// Diagnostic preload: print the JS stack of whatever opens copyDbIntegrity's non-LMDB fixture file.
// Deliberately minimal (no mocha hooks, no fs patches): a heavier probe hid the trigger entirely.
const fs = require('fs');
const lmdb = require(require.resolve('lmdb', { paths: [process.cwd()] }));
const origOpen = lmdb.open;
lmdb.open = function (path) {
	const p = typeof path === 'string' ? path : path?.path;
	if (typeof p === 'string' && p.includes('existing-target')) {
		Error.stackTraceLimit = 60;
		fs.writeSync(2, `OPEN existing-target at ${process.uptime()}s\n${new Error().stack}\n`);
	}
	return origOpen.apply(this, arguments);
};
