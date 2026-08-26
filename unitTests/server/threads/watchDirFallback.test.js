'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const { watchDir } = require('#src/server/threads/manageThreads');

// watchDir is the WATCH_DIR dev reloader's watch site. It runs on the thread that owns every
// worker, and chokidar emits 'error' unguarded for anything but ENOENT/ENOTDIR, so an exhausted
// watcher pool there would otherwise take the main thread down. These tests drive the listener
// directly with a stubbed chokidar — no real watcher, no real reload.
describe('watchDir watcher fallback', () => {
	const sandbox = sinon.createSandbox();

	afterEach(() => sandbox.restore());

	const exhausted = () => Object.assign(new Error('inotify watch limit reached'), { code: 'ENOSPC' });

	const stubChokidar = (close) => {
		const chokidar = require('chokidar');
		const openedOptions = [];
		const errorHandlers = [];
		sandbox.stub(chokidar, 'watch').callsFake((_watchedPath, options) => {
			openedOptions.push(options);
			const watcher = {
				on: (event, handler) => {
					if (event === 'error') errorHandlers.push(handler);
					return watcher;
				},
				close,
			};
			return watcher;
		});
		return { openedOptions, errorHandlers };
	};

	it('reopens on polling when the watcher reports exhaustion, and only once', async () => {
		const { openedOptions, errorHandlers } = stubChokidar(() => Promise.resolve());

		await watchDir(__dirname);
		expect(openedOptions).to.have.lengthOf(1);
		expect(openedOptions[0].usePolling).to.equal(undefined);

		errorHandlers[0](exhausted());
		await new Promise((resolve) => setImmediate(resolve));

		expect(openedOptions).to.have.lengthOf(2);
		expect(openedOptions[1].usePolling).to.equal(true);

		// Repeated exhaustion errors — from the failed watcher and the polling one — must not open a
		// third watcher.
		errorHandlers[0](exhausted());
		errorHandlers[1](exhausted());
		await new Promise((resolve) => setImmediate(resolve));
		expect(openedOptions).to.have.lengthOf(2);
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
		expect(openedOptions).to.have.lengthOf(1);

		expect(() => errorHandlers[0](exhausted())).to.not.throw();
		await new Promise((resolve) => setImmediate(resolve));

		expect(openedOptions).to.have.lengthOf(2);
		expect(openedOptions[1].usePolling).to.equal(true);
	});
});
