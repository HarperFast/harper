'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const env = require('#src/utility/environment/environmentManager');
env.initTestEnvironment();
const hdbTerms = require('#src/utility/hdbTerms');
const readLog = require('#src/utility/logging/readLog').default;

const TEST_LOG_DIR = path.join(__dirname, 'testLoggerStream');
const LOG_NAME = 'log_stream_unit_test.log';
const LOG_PATH = path.join(TEST_LOG_DIR, LOG_NAME);

function line(second, level, message) {
	return `2023-03-02T21:52:1${second}.688Z [main/0] [${level}]: ${message}\n`;
}

// Stand-in for the ProgressEmitter serverHandlers attaches to request.progress: an `emit`
// that captures events plus a `signal` that aborts on client disconnect. Using a plain object
// (rather than a mock) keeps this test on real modules per AGENTS.md.
function fakeProgress() {
	const controller = new AbortController();
	const events = [];
	return {
		events,
		signal: controller.signal,
		emit(event, data) {
			events.push({ event, data });
		},
		disconnect() {
			controller.abort();
		},
		logs() {
			return events.filter((e) => e.event === 'log').map((e) => e.data);
		},
	};
}

// Variant that models the real ProgressEmitter's backpressure surface: `paused` plus a
// `whenWritable()` that resolves on `resume()` (what createSSEResponseStream calls on stream
// 'drain'). `disconnect()` also releases waiters, mirroring the wrapper's teardown, so the
// tail cannot hang if the client leaves while the producer is awaiting drain.
function fakeProgressWithBackpressure() {
	const controller = new AbortController();
	const events = [];
	let paused = false;
	let waiters = [];
	const release = () => {
		const pending = waiters;
		waiters = [];
		for (const r of pending) r();
	};
	return {
		events,
		signal: controller.signal,
		get paused() {
			return paused;
		},
		emit(event, data) {
			events.push({ event, data });
		},
		whenWritable() {
			return paused ? new Promise((r) => waiters.push(r)) : Promise.resolve();
		},
		pause() {
			paused = true;
		},
		resume() {
			paused = false;
			release();
		},
		disconnect() {
			controller.abort();
			paused = false;
			release();
		},
		logs() {
			return events.filter((e) => e.event === 'log').map((e) => e.data);
		},
	};
}

async function waitFor(predicate, { timeout = 5000, interval = 20 } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, interval));
	}
	return false;
}

describe('Test readLog SSE tail', () => {
	let originalLogPath;
	let progress;
	let running;

	before(() => {
		// Point read_log's configured log directory at our temp dir via the real environment
		// manager — getConfigPath reads env.get(LOG_PATH) — so the real validator and reader
		// operate on our file with no module stubbing.
		originalLogPath = env.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
		env.setProperty(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, TEST_LOG_DIR);
	});

	after(() => {
		env.setProperty(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, originalLogPath);
		fs.rmSync(TEST_LOG_DIR, { recursive: true, force: true });
	});

	beforeEach(() => {
		fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
		fs.writeFileSync(LOG_PATH, '');
		progress = undefined;
		running = undefined;
	});

	afterEach(async () => {
		// Always disconnect so the file watcher/timers are torn down and the operation resolves;
		// a leaked fs.watchFile would otherwise keep the process (and mocha) alive.
		if (progress && running) {
			progress.disconnect();
			await running;
		}
	});

	it('emits the existing backlog as `log` events, then resolves on disconnect', async () => {
		fs.appendFileSync(LOG_PATH, line(0, 'info', 'first'));
		fs.appendFileSync(LOG_PATH, line(1, 'warn', 'second'));

		progress = fakeProgress();
		running = readLog({ operation: 'read_log', log_name: LOG_NAME, progress });

		assert.ok(await waitFor(() => progress.logs().length >= 2), 'backlog entries were emitted');

		const messages = progress.logs().map((l) => l.message);
		assert.ok(messages.includes('first'));
		assert.ok(messages.includes('second'));
		assert.ok(progress.events.every((e) => e.event === 'log'));

		progress.disconnect();
		await running; // resolves because the tail observed the abort
	});

	it('tails newly appended lines live', async () => {
		fs.appendFileSync(LOG_PATH, line(0, 'info', 'backlog'));

		progress = fakeProgress();
		running = readLog({ operation: 'read_log', log_name: LOG_NAME, progress });
		assert.ok(await waitFor(() => progress.logs().length >= 1));

		// Append three lines: the first two are finalized by the following markers and stream out
		// without waiting on the idle flush.
		fs.appendFileSync(LOG_PATH, line(2, 'info', 'live-a'));
		fs.appendFileSync(LOG_PATH, line(3, 'error', 'live-b'));
		fs.appendFileSync(LOG_PATH, line(4, 'warn', 'live-c'));

		const got = await waitFor(() => {
			const m = progress.logs().map((l) => l.message);
			return m.includes('live-a') && m.includes('live-b');
		});
		assert.ok(got, 'live-appended lines were tailed');
	});

	it('pauses tailing under backpressure and resumes on drain', async function () {
		this.timeout(15000);
		fs.appendFileSync(LOG_PATH, line(0, 'info', 'backlog'));

		progress = fakeProgressWithBackpressure();
		running = readLog({ operation: 'read_log', log_name: LOG_NAME, progress });
		assert.ok(await waitFor(() => progress.logs().length >= 1), 'backlog emitted');

		// Simulate a slow client whose write buffer is full, then append new lines.
		progress.pause();
		fs.appendFileSync(LOG_PATH, line(2, 'info', 'live-a'));
		fs.appendFileSync(LOG_PATH, line(3, 'info', 'live-b'));
		fs.appendFileSync(LOG_PATH, line(4, 'info', 'live-c'));

		const beforeDrain = progress.logs().length;
		// The pump should reach the appended bytes but park on whenWritable() — emitting nothing
		// more — rather than buffering frames for a client that cannot keep up.
		await new Promise((r) => setTimeout(r, 700));
		assert.strictEqual(progress.logs().length, beforeDrain, 'no entries emitted while paused');

		// Client catches up; the tail resumes and delivers the withheld lines.
		progress.resume();
		const got = await waitFor(() => {
			const m = progress.logs().map((l) => l.message);
			return m.includes('live-a') && m.includes('live-b');
		});
		assert.ok(got, 'withheld entries flow once the stream drains');
	});

	it('flushes a trailing single line once the tail goes idle', async function () {
		this.timeout(15000);
		progress = fakeProgress();
		running = readLog({ operation: 'read_log', log_name: LOG_NAME, progress });
		// give the watcher a moment to arm on the empty file
		await new Promise((r) => setTimeout(r, 100));

		fs.appendFileSync(LOG_PATH, line(5, 'info', 'lonely'));

		// No following marker will arrive, so this only shows up after the idle flush fires.
		const got = await waitFor(() => progress.logs().some((l) => l.message === 'lonely'), { timeout: 6000 });
		assert.ok(got, 'trailing line flushed on idle');
	});

	it('applies level and filter to both backlog and live entries', async () => {
		fs.appendFileSync(LOG_PATH, line(0, 'info', 'keep me'));
		fs.appendFileSync(LOG_PATH, line(0, 'error', 'drop me'));

		progress = fakeProgress();
		running = readLog({
			operation: 'read_log',
			log_name: LOG_NAME,
			level: 'info',
			filter: 'keep',
			progress,
		});

		assert.ok(await waitFor(() => progress.logs().length >= 1));

		fs.appendFileSync(LOG_PATH, line(2, 'info', 'keep this too'));
		fs.appendFileSync(LOG_PATH, line(3, 'info', 'nope'));
		fs.appendFileSync(LOG_PATH, line(4, 'error', 'keep but wrong level'));
		// A trailing line whose marker finalizes 'keep this too' / 'nope'.
		fs.appendFileSync(LOG_PATH, line(5, 'info', 'sentinel keep'));

		await waitFor(() => progress.logs().some((l) => l.message === 'keep this too'));

		const messages = progress.logs().map((l) => l.message);
		assert.ok(messages.includes('keep me'));
		assert.ok(messages.includes('keep this too'));
		assert.ok(!messages.includes('drop me'), 'filtered by `filter`');
		assert.ok(!messages.includes('nope'), 'filtered by `filter`');
		assert.ok(!messages.includes('keep but wrong level'), 'filtered by `level`');
	});

	it('caps the backlog at `limit`, keeping the newest', async () => {
		for (let i = 0; i < 5; i++) {
			fs.appendFileSync(LOG_PATH, line(i, 'info', `entry-${i}`));
		}

		progress = fakeProgress();
		running = readLog({ operation: 'read_log', log_name: LOG_NAME, limit: 2, progress });

		assert.ok(await waitFor(() => progress.logs().length >= 2));
		// Give any erroneous extra backlog emits a chance to land before asserting the cap.
		await new Promise((r) => setTimeout(r, 100));

		const messages = progress.logs().map((l) => l.message);
		assert.deepStrictEqual(messages, ['entry-3', 'entry-4']);
	});

	it('resolves immediately without a disconnect signal (degrades to backlog-only)', async () => {
		fs.appendFileSync(LOG_PATH, line(0, 'info', 'only-backlog'));

		const noSignal = {
			events: [],
			emit(event, data) {
				this.events.push({ event, data });
			},
		};
		// No `signal` → cannot safely tail forever, so it must resolve after the backlog.
		await readLog({ operation: 'read_log', log_name: LOG_NAME, progress: noSignal });

		const messages = noSignal.events.filter((e) => e.event === 'log').map((e) => e.data.message);
		assert.deepStrictEqual(messages, ['only-backlog']);
	});
});
