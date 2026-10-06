// Diagnostic preload: print the JS stack of whatever opens copyDbIntegrity's non-LMDB fixture file,
// and of every scan of that suite's storage directory, with the running test.
const fs = require('fs');
const lmdb = require(require.resolve('lmdb', { paths: [process.cwd()] }));
const t0 = Date.now();
let current = '(none)';
const log = (s) => fs.writeSync(2, `[trace ${Date.now() - t0}ms "${current}"] ${s}\n`);
const stack = () => new Error().stack.split('\n').slice(2, 40).join('\n');
const origOpen = lmdb.open;
lmdb.open = function (path, options) {
	const p = typeof path === 'string' ? path : path?.path;
	if (String(p).includes('existing-target')) log('OPEN existing-target\n' + stack());
	return origOpen.apply(this, arguments);
};
const origReaddir = fs.readdirSync;
fs.readdirSync = function (p, ...rest) {
	if (String(p).endsWith('copyIntegrity')) log('SCAN copyIntegrity\n' + stack());
	return origReaddir.call(this, p, ...rest);
};
exports.mochaHooks = {
	beforeEach() {
		current = this.currentTest.title;
	},
	afterEach() {
		current = 'after: ' + this.currentTest.title;
	},
};
