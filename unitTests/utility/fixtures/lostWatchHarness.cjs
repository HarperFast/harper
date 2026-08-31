'use strict';

// Child-process harness for the lost-native-watch guard. It deliberately does NOT
// register an 'uncaughtException' listener of its own: the whole point is that the
// guard installed by guardedWatch() is the only thing standing between a deleted
// watched path and a dead process, and a listener here would mask that.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	claimLostNativeWatchError,
	guardedWatch,
	_lostNativeWatchCountForTests,
} = require('#src/utility/watcherFallback');

const mode = process.argv[2];

// How long to wait for an asynchronous watch failure. On Windows it is the error itself we are
// waiting for, and delivery competes with everything else on a loaded CI runner; elsewhere nothing
// will ever arrive and this is only a settle period, so it stays short. Cases that can observe the
// error poll for it and exit early, so the deadline is a ceiling, not a sleep.
const DELIVERY_DEADLINE_MS = process.platform === 'win32' ? 5000 : 1500;

function waitForDelivery(isDelivered, onDeadline) {
	const deadline = Date.now() + DELIVERY_DEADLINE_MS;
	const poll = setInterval(() => {
		if (!isDelivered() && Date.now() < deadline) return;
		clearInterval(poll);
		onDeadline();
	}, 50);
}

if (mode === 'warn-threshold') {
	// No watcher needed: claim a run of synthetic lost-watch errors and let the caller count the
	// warnings that reach the log. Warn is the default level, so this is the visible cadence.
	for (let i = 0; i < 12; i++) {
		claimLostNativeWatchError(
			Object.assign(new Error('EPERM: watch'), { code: 'EPERM', syscall: 'watch', filename: null })
		);
	}
	process.stdout.write(`claimed=${_lostNativeWatchCountForTests()}\n`);
	process.exit(0);
}

if (mode === 'prepend-ordering') {
	// Stands in for the handlers in server/threads/threadServer.js and socketRouter.ts, which are
	// registered at module load — before any watcher exists. They skip errors already marked
	// handled, which only works if the guard's listener runs ahead of them.
	process.on('uncaughtException', (error) => {
		process.stdout.write(`thread-handler saw isHandled=${error.isHandled}\n`);
		process.exit(0);
	});
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-lost-watch-'));
const watched = path.join(root, 'component');
fs.mkdirSync(path.join(watched, 'resources'), { recursive: true });
fs.writeFileSync(path.join(watched, 'config.yaml'), 'name: fixture\n');
fs.writeFileSync(path.join(watched, 'resources', 'index.js'), '// fixture\n');

// Matches EntryHandler's shape: a relative base resolved against `cwd`, which is
// what a component watcher actually opens.
const watcher = guardedWatch('.', { cwd: watched, persistent: false, followSymlinks: false });

watcher.on('ready', () => {
	if (mode === 'prepend-ordering') {
		fs.rmSync(watched, { recursive: true, force: true });
		// The handler above exits as soon as it runs, so reaching this is the failure.
		setTimeout(() => {
			process.stdout.write('thread-handler never ran\n');
			process.exit(3);
		}, DELIVERY_DEADLINE_MS);
		return;
	}

	if (mode === 'frozen-claim') {
		// A lost-watch-shaped error the guard cannot mark handled: `isHandled` is unassignable on a
		// frozen object, so classifying it throws. That throw happens inside the guard's
		// 'uncaughtException' listener, which runs first, so an unprotected guard would replace this
		// error's report with a TypeError and exit 7 instead of leaving it fatal on its own terms.
		setTimeout(() => {
			throw Object.freeze(
				Object.assign(new Error('frozen lost watch'), { code: 'EPERM', syscall: 'watch', filename: null })
			);
		}, 10);
		return;
	}

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
	waitForDelivery(
		() => _lostNativeWatchCountForTests() > 0,
		() => {
			process.stdout.write(`survived lostWatchCount=${_lostNativeWatchCountForTests()}\n`);
			process.exit(0);
		}
	);
});
