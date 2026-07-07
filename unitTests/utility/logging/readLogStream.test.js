'use strict';

const env_mangr = require('#src/utility/environment/environmentManager');
env_mangr.initTestEnvironment();
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs-extra');
const rewire = require('rewire');
const read_log = rewire('#src/utility/logging/readLog');
const readLogFunction = read_log.default || read_log;
const hdb_terms = require('#src/utility/hdbTerms');

const LOG_DIR_TEST = 'testLoggerStream';
const LOG_NAME_TEST = 'log_stream_unit_test.log';
const TEST_LOG_DIR = path.join(__dirname, LOG_DIR_TEST);
const FULL_LOG_PATH_TEST = path.join(TEST_LOG_DIR, LOG_NAME_TEST);

function line(second, level, message) {
	return `2023-03-02T21:52:1${second}.688Z [main/0] [${level}]: ${message}\n`;
}

// Fake ProgressEmitter matching what serverHandlers attaches to request.progress: an `emit`
// that captures events, plus a `signal` that aborts on client disconnect.
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

async function waitFor(predicate, { timeout = 5000, interval = 20 } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, interval));
	}
	return false;
}

describe('Test readLog SSE tail', () => {
	const sandbox = sinon.createSandbox();
	const validator_stub = sandbox.stub().returns(null);
	let validator_rw;
	let getConfigPath_rw;
	let progress;
	let running;

	beforeEach(() => {
		fs.mkdirpSync(TEST_LOG_DIR);
		fs.writeFileSync(FULL_LOG_PATH_TEST, '');
		getConfigPath_rw = read_log.__set__('configUtils_ts_1', {
			getConfigPath: (key) => (key === hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY ? TEST_LOG_DIR : undefined),
		});
		validator_rw = read_log.__set__('readLogValidator_ts_1', { default: validator_stub });
		progress = undefined;
		running = undefined;
	});

	afterEach(async () => {
		// Always disconnect so the file watcher/timers are torn down and the operation resolves,
		// otherwise a leaked fs.watchFile would keep the process (and mocha) alive.
		if (progress && running) {
			progress.disconnect();
			await running;
		}
		sandbox.resetHistory();
		validator_rw();
		getConfigPath_rw();
		fs.removeSync(TEST_LOG_DIR);
	});

	it('emits the existing backlog as `log` events, then resolves on disconnect', async () => {
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(0, 'info', 'first'));
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(1, 'warn', 'second'));

		progress = fakeProgress();
		running = readLogFunction({ operation: 'read_log', log_name: LOG_NAME_TEST, progress });

		const got = await waitFor(() => progress.logs().length >= 2);
		expect(got, 'backlog entries were emitted').to.be.true;

		const messages = progress.logs().map((l) => l.message);
		expect(messages).to.include('first');
		expect(messages).to.include('second');
		expect(progress.events.every((e) => e.event === 'log')).to.be.true;

		progress.disconnect();
		await running; // resolves because the tail observed the abort
	});

	it('tails newly appended lines live', async () => {
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(0, 'info', 'backlog'));

		progress = fakeProgress();
		running = readLogFunction({ operation: 'read_log', log_name: LOG_NAME_TEST, progress });
		expect(await waitFor(() => progress.logs().length >= 1)).to.be.true;

		// Append three lines: the first two are finalized by the following markers and stream out
		// without waiting on the idle flush.
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(2, 'info', 'live-a'));
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(3, 'error', 'live-b'));
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(4, 'warn', 'live-c'));

		const got = await waitFor(() => {
			const m = progress.logs().map((l) => l.message);
			return m.includes('live-a') && m.includes('live-b');
		});
		expect(got, 'live-appended lines were tailed').to.be.true;
	});

	it('flushes a trailing single line once the tail goes idle', async function () {
		this.timeout(15000);
		progress = fakeProgress();
		running = readLogFunction({ operation: 'read_log', log_name: LOG_NAME_TEST, progress });
		// give the watcher a moment to arm on the empty file
		await new Promise((r) => setTimeout(r, 100));

		fs.appendFileSync(FULL_LOG_PATH_TEST, line(5, 'info', 'lonely'));

		// No following marker will arrive, so this only shows up after the idle flush fires.
		const got = await waitFor(() => progress.logs().some((l) => l.message === 'lonely'), { timeout: 6000 });
		expect(got, 'trailing line flushed on idle').to.be.true;
	});

	it('applies level and filter to both backlog and live entries', async () => {
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(0, 'info', 'keep me'));
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(0, 'error', 'drop me'));

		progress = fakeProgress();
		running = readLogFunction({
			operation: 'read_log',
			log_name: LOG_NAME_TEST,
			level: 'info',
			filter: 'keep',
			progress,
		});

		expect(await waitFor(() => progress.logs().length >= 1)).to.be.true;

		fs.appendFileSync(FULL_LOG_PATH_TEST, line(2, 'info', 'keep this too'));
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(3, 'info', 'nope'));
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(4, 'error', 'keep but wrong level'));
		// A trailing line whose marker finalizes 'keep this too' / 'nope'.
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(5, 'info', 'sentinel keep'));

		await waitFor(() => progress.logs().some((l) => l.message === 'keep this too'));

		const messages = progress.logs().map((l) => l.message);
		expect(messages).to.include('keep me');
		expect(messages).to.include('keep this too');
		expect(messages).to.not.include('drop me'); // filtered by `filter`
		expect(messages).to.not.include('nope'); // filtered by `filter`
		expect(messages).to.not.include('keep but wrong level'); // filtered by `level`
	});

	it('caps the backlog at `limit`, keeping the newest', async () => {
		for (let i = 0; i < 5; i++) {
			fs.appendFileSync(FULL_LOG_PATH_TEST, line(i, 'info', `entry-${i}`));
		}

		progress = fakeProgress();
		running = readLogFunction({ operation: 'read_log', log_name: LOG_NAME_TEST, limit: 2, progress });

		expect(await waitFor(() => progress.logs().length >= 2)).to.be.true;
		// Give any erroneous extra backlog emits a chance to land before asserting the cap.
		await new Promise((r) => setTimeout(r, 100));

		const messages = progress.logs().map((l) => l.message);
		expect(messages).to.eql(['entry-3', 'entry-4']);
	});

	it('resolves immediately without a disconnect signal (degrades to backlog-only)', async () => {
		fs.appendFileSync(FULL_LOG_PATH_TEST, line(0, 'info', 'only-backlog'));

		const noSignal = {
			events: [],
			emit(event, data) {
				this.events.push({ event, data });
			},
		};
		// No `signal` → cannot safely tail forever, so it must resolve after the backlog.
		await readLogFunction({ operation: 'read_log', log_name: LOG_NAME_TEST, progress: noSignal });

		const messages = noSignal.events.filter((e) => e.event === 'log').map((e) => e.data.message);
		expect(messages).to.eql(['only-backlog']);
	});
});
