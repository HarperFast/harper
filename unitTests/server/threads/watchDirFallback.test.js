'use strict';

const assert = require('node:assert');
const chokidar = require('chokidar');

const { watchDir } = require('#src/server/threads/manageThreads');
const { _resetForTests: resetWatcherFallbackWarning } = require('#src/utility/watcherFallback');

describe('watchDir watcher fallback', () => {
	const realWatch = chokidar.default.watch;

	afterEach(() => {
		chokidar.default.watch = realWatch;
		// warnWatcherFallback's first-fallback gate is process-global; leaving it set would make a
		// later suite's warning assertion silently observe nothing.
		resetWatcherFallbackWarning();
	});

	const exhausted = () => Object.assign(new Error('inotify watch limit reached'), { code: 'ENOSPC' });

	// Never open a real watcher here: these cases drive the 'error' listener directly, and real
	// watchers would leak fds across repeated runs.
	const stubChokidar = (close) => {
		const openedOptions = [];
		const errorHandlers = [];
		chokidar.default.watch = (_watchedPath, options) => {
			openedOptions.push(options);
			const watcher = {
				on: (event, handler) => {
					if (event === 'error') errorHandlers.push(handler);
					return watcher;
				},
				close,
			};
			return watcher;
		};
		return { openedOptions, errorHandlers };
	};

	it('reopens on polling when the watcher reports exhaustion, and only once', async () => {
		const { openedOptions, errorHandlers } = stubChokidar(() => Promise.resolve());

		await watchDir(__dirname);
		assert.equal(openedOptions.length, 1);
		assert.equal(openedOptions[0].usePolling, undefined);

		errorHandlers[0](exhausted());
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(openedOptions.length, 2);
		assert.equal(openedOptions[1].usePolling, true);

		errorHandlers[0](exhausted());
		errorHandlers[1](exhausted());
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(openedOptions.length, 2);
	});

	it('a synchronous throw from close() stays inside the reopen chain', async () => {
		// The reopen used to be spelled `Promise.resolve(opened.close())`, whose argument is evaluated
		// eagerly: a close() that throws synchronously threw out of the 'error' listener itself, past
		// the chained .catch(), and Node reported it as an uncaught exception instead of reopening on
		// polling.
		const { openedOptions, errorHandlers } = stubChokidar(() => {
			throw new Error('close failed synchronously');
		});

		await watchDir(__dirname);
		assert.equal(openedOptions.length, 1);

		assert.doesNotThrow(() => errorHandlers[0](exhausted()));
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(openedOptions.length, 2);
		assert.equal(openedOptions[1].usePolling, true);
	});
});
