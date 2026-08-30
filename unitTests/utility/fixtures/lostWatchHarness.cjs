'use strict';

// Child-process harness for the lost-native-watch guard. It deliberately does NOT
// register an 'uncaughtException' listener of its own: the whole point is that the
// guard installed by guardedWatch() is the only thing standing between a deleted
// watched path and a dead process, and a listener here would mask that.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { guardedWatch, _lostNativeWatchCountForTests } = require('#src/utility/watcherFallback');

const mode = process.argv[2];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-lost-watch-'));
const watched = path.join(root, 'component');
fs.mkdirSync(path.join(watched, 'resources'), { recursive: true });
fs.writeFileSync(path.join(watched, 'config.yaml'), 'name: fixture\n');
fs.writeFileSync(path.join(watched, 'resources', 'index.js'), '// fixture\n');

// Matches EntryHandler's shape: a relative base resolved against `cwd`, which is
// what a component watcher actually opens.
const watcher = guardedWatch('.', { cwd: watched, persistent: false, followSymlinks: false });

watcher.on('ready', () => {
	if (mode === 'sync-watch-failure') {
		// A synchronous fs.watch() throw shares the guard's syscall ('watch') but carries a `path`,
		// which is what keeps an ordinary "watching a path that isn't there" misconfiguration fatal
		// instead of being mistaken for a benign lost watch and swallowed.
		setTimeout(() => {
			fs.watch(path.join(root, 'no-such-directory'), { persistent: false }, () => {});
		}, 10);
		return;
	}

	if (mode === 'unrelated-throw') {
		// The guard is installed now. An unrelated uncaught exception must still be
		// fatal — a guard that swallows everything turns crashes into silent hangs.
		setTimeout(() => {
			throw new Error('unrelated harness failure');
		}, 10);
		return;
	}

	// The delete is what raises `EPERM: operation not permitted, watch` on Windows,
	// asynchronously, on a native watcher chokidar never attached a listener to.
	fs.rmSync(watched, { recursive: true, force: true });
	setTimeout(() => {
		process.stdout.write(`survived lostWatchCount=${_lostNativeWatchCountForTests()}\n`);
		process.exit(0);
	}, 1500);
});
