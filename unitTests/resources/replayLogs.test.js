const assert = require('node:assert');

// The helper lives in a dependency-free module so the test doesn't need to bootstrap
// the full Resource/RocksDB module graph (which has a circular require chain).
const {
	classifyAuditEntryForReplay,
	isUndecodableValidatedWrite,
	RECORD_BEARING_FLAGS,
	endIteratorOnCorruptFrame,
	MAX_RESYNCS_PER_ITERATION,
	MAX_CORRUPT_FRAME_REPORTS,
	createCorruptFrameReporter,
	getCorruptFrameReports,
	getEvictedCorruptFrameReportCount,
	clearCorruptFrameReports,
	shouldAbortStalledReplay,
	REPLAY_NO_PROGRESS_COUNT_LIMIT,
	REPLAY_NO_PROGRESS_TIME_LIMIT_MS,
	REPLAY_NO_PROGRESS_TIME_SKIP_FLOOR,
	shouldAbortSlowReplay,
	REPLAY_WALL_CLOCK_LIMIT_MS,
} = require('#src/resources/replayLogsGuards');

// Regression tests for the unclean-shutdown replay guards. Without these, an audit log
// containing entries with corrupt MessagePack values caused replayLogs to write
// `undefined` records and crash inside validate(), looping at ~100% CPU on every entry.

// Mirror the action constants from auditStore.ts so the tests read like the writer.
const HAS_RECORD = 16;
const HAS_PARTIAL_RECORD = 32;
const PUT = 1;
const DELETE = 2;
const MESSAGE = 3;
const INVALIDATE = 4;
const PATCH = 5;
const RELOCATE = 6;
const STRUCTURES = 7;

describe('classifyAuditEntryForReplay', () => {
	it('rejects entries where readAuditEntry returned {} (no action / tableId)', () => {
		assert.strictEqual(classifyAuditEntryForReplay(undefined, undefined, false), 'corrupt-header');
		assert.strictEqual(classifyAuditEntryForReplay(undefined, 1, true), 'corrupt-header');
		assert.strictEqual(classifyAuditEntryForReplay(PUT | HAS_RECORD, undefined, true), 'corrupt-header');
	});

	it('rejects entries whose action bits advertise a record but the value is missing', () => {
		// put/message carry HAS_RECORD; patch/invalidate carry HAS_PARTIAL_RECORD.
		assert.strictEqual(classifyAuditEntryForReplay(PUT | HAS_RECORD, 1, false), 'missing-record');
		assert.strictEqual(classifyAuditEntryForReplay(MESSAGE | HAS_RECORD, 1, false), 'missing-record');
		assert.strictEqual(classifyAuditEntryForReplay(PATCH | HAS_PARTIAL_RECORD, 1, false), 'missing-record');
		assert.strictEqual(classifyAuditEntryForReplay(INVALIDATE | HAS_PARTIAL_RECORD, 1, false), 'missing-record');
	});

	it('accepts entries with record-bearing actions when the record is present', () => {
		assert.strictEqual(classifyAuditEntryForReplay(PUT | HAS_RECORD, 1, true), null);
		assert.strictEqual(classifyAuditEntryForReplay(PATCH | HAS_PARTIAL_RECORD, 1, true), null);
	});

	it('accepts ops with no record-bearing bits set (delete, relocate, structures)', () => {
		// These don't have HAS_RECORD or HAS_PARTIAL_RECORD set, so a missing value is fine.
		assert.strictEqual(classifyAuditEntryForReplay(DELETE, 1, false), null);
		assert.strictEqual(classifyAuditEntryForReplay(RELOCATE, 1, false), null);
		assert.strictEqual(classifyAuditEntryForReplay(STRUCTURES, 1, false), null);
	});

	it('ignores higher action bits (residency, blobs, etc.) when classifying', () => {
		// Other HAS_* flags live above bit 8 and must not be conflated with record-bearing.
		const HAS_BLOBS = 0x2000;
		assert.strictEqual(classifyAuditEntryForReplay(PUT | HAS_RECORD | HAS_BLOBS, 1, true), null);
		assert.strictEqual(classifyAuditEntryForReplay(DELETE | HAS_BLOBS, 1, false), null);
	});

	it('RECORD_BEARING_FLAGS pins to HAS_RECORD | HAS_PARTIAL_RECORD in auditStore', () => {
		// Lock the mask: the audit writer in auditStore.ts uses these exact bit values.
		// Silent drift here would re-introduce the crash.
		assert.strictEqual(RECORD_BEARING_FLAGS, HAS_RECORD | HAS_PARTIAL_RECORD);
	});
});

describe('isUndecodableValidatedWrite', () => {
	// Regression for harper#1255: RecordEncoder.decode returns `null` (not `undefined`) on a
	// failed value decode (e.g. structure-dictionary divergence), so classify() — which only
	// catches `undefined` — lets it through. The replay then calls validate() on the null body
	// and crashes ("Cannot read properties of undefined (reading 'id')"). This guard skips the
	// actions whose replay reaches validate(): put/patch (via _writeUpdate) and message (via
	// _writePublish -> addWrite -> save) — and ONLY those.
	it('skips put/patch/message whose body failed to decode (null or undefined)', () => {
		assert.strictEqual(isUndecodableValidatedWrite('put', null), true);
		assert.strictEqual(isUndecodableValidatedWrite('put', undefined), true);
		assert.strictEqual(isUndecodableValidatedWrite('patch', null), true);
		assert.strictEqual(isUndecodableValidatedWrite('patch', undefined), true);
		assert.strictEqual(isUndecodableValidatedWrite('message', null), true);
		assert.strictEqual(isUndecodableValidatedWrite('message', undefined), true);
	});

	it('does not skip put/patch/message with a decoded body, including falsy primitives', () => {
		assert.strictEqual(isUndecodableValidatedWrite('put', { id: 1 }), false);
		assert.strictEqual(isUndecodableValidatedWrite('patch', 0), false);
		assert.strictEqual(isUndecodableValidatedWrite('put', ''), false);
		assert.strictEqual(isUndecodableValidatedWrite('patch', false), false);
		assert.strictEqual(isUndecodableValidatedWrite('message', 0), false);
	});

	it('never skips invalidate on a null body — a no-index table stores a legitimate null partial record', () => {
		// invalidate carries HAS_PARTIAL_RECORD but never reaches validate(); skipping it would
		// leave the record un-invalidated/stale after recovery.
		assert.strictEqual(isUndecodableValidatedWrite('invalidate', null), false);
		assert.strictEqual(isUndecodableValidatedWrite('invalidate', undefined), false);
	});

	it('does not skip non-validated actions on a null body', () => {
		// relocate/delete ignore the body and never call validate(), so they pass through untouched.
		assert.strictEqual(isUndecodableValidatedWrite('relocate', null), false);
		assert.strictEqual(isUndecodableValidatedWrite('delete', null), false);
		assert.strictEqual(isUndecodableValidatedWrite(undefined, null), false);
	});
});

// Regression tests for HarperFast/harper#1135: the wrapper must turn a framing RangeError into
// a clean end-of-log (so replay/broadcast don't abort the boot) and leave other errors alone.
describe('endIteratorOnCorruptFrame', () => {
	it('yields entries up to a corrupt frame, then ends cleanly and reports it once', () => {
		let calls = 0;
		const source = {
			next() {
				calls++;
				if (calls === 1) return { done: false, value: 'a' };
				if (calls === 2) return { done: false, value: 'b' };
				throw new RangeError('declared length 1778384896 overruns the log (limit=5439)');
			},
		};
		const reported = [];
		const wrapped = endIteratorOnCorruptFrame(source, (error) => reported.push(error));

		assert.deepStrictEqual([...wrapped], ['a', 'b']);
		assert.strictEqual(reported.length, 1);
		assert.ok(reported[0] instanceof RangeError);
		// Latched: stays done without re-invoking the source (no repeated reporting/spam).
		assert.deepStrictEqual(wrapped.next(), { done: true, value: undefined });
		assert.strictEqual(calls, 3);
		assert.strictEqual(reported.length, 1);
	});

	// harper#2016 / harper#2063: a mid-log break has intact, already-acknowledged entries behind
	// it. rocksdb-js reports where framing resumes and leaves the reader positioned there, so the
	// wrapper must keep pulling — treating it as end-of-log amputates every later entry, and every
	// future drain restarts from the same cursor and stops at the same frame.
	it('resyncs past a mid-log corrupt frame and keeps yielding the entries after it', () => {
		let calls = 0;
		const source = {
			next() {
				calls++;
				if (calls === 1) return { done: false, value: 'a' };
				if (calls === 2) {
					const error = new RangeError('declared length 1778384896 overruns the log (limit=5439)');
					error.resyncPosition = 0x7d3f;
					error.unreadableBytes = 26;
					throw error;
				}
				if (calls === 3) return { done: false, value: 'b' };
				return { done: true, value: undefined };
			},
		};
		const reported = [];
		const wrapped = endIteratorOnCorruptFrame(source, (error, stopped) => reported.push({ error, stopped }));

		assert.deepStrictEqual([...wrapped], ['a', 'b']);
		assert.strictEqual(reported.length, 1);
		assert.strictEqual(reported[0].stopped, false);
		assert.strictEqual(reported[0].error.unreadableBytes, 26);
	});

	it('stops resyncing once a log exceeds the per-iteration cap', () => {
		let calls = 0;
		const source = {
			next() {
				calls++;
				const error = new RangeError('corrupt');
				error.resyncPosition = calls * 100;
				error.unreadableBytes = 8;
				throw error;
			},
		};
		const reported = [];
		const wrapped = endIteratorOnCorruptFrame(source, (error, stopped) => reported.push(stopped));

		assert.deepStrictEqual(wrapped.next(), { done: true, value: undefined });
		// the cap is what ends iteration, and the break that hit it is reported as stopping it
		assert.strictEqual(calls, MAX_RESYNCS_PER_ITERATION + 1);
		assert.strictEqual(reported.length, MAX_RESYNCS_PER_ITERATION + 1);
		assert.strictEqual(reported.at(-1), true);
		// latched afterwards: no further pulls on the source
		assert.deepStrictEqual(wrapped.next(), { done: true, value: undefined });
		assert.strictEqual(calls, MAX_RESYNCS_PER_ITERATION + 1);
	});

	it('resets the resync cap after the source makes progress', () => {
		let frames = 0;
		let corrupt = true;
		const source = {
			next() {
				if (frames > MAX_RESYNCS_PER_ITERATION) return { done: true, value: undefined };
				if (corrupt) {
					corrupt = false;
					const error = new RangeError('corrupt');
					error.resyncPosition = frames;
					throw error;
				}
				corrupt = true;
				return { done: false, value: frames++ };
			},
		};
		const reported = [];
		const wrapped = endIteratorOnCorruptFrame(source, (error, stopped) => reported.push(stopped));

		assert.strictEqual([...wrapped].length, MAX_RESYNCS_PER_ITERATION + 1);
		assert.strictEqual(reported.length, MAX_RESYNCS_PER_ITERATION + 1);
		assert.ok(reported.every((stopped) => stopped === false));
	});

	it('treats a RangeError with no resync position as end-of-log (older rocksdb-js)', () => {
		let calls = 0;
		const source = {
			next() {
				calls++;
				if (calls === 1) return { done: false, value: 'a' };
				throw new RangeError('truncated entry header');
			},
		};
		const reported = [];
		const wrapped = endIteratorOnCorruptFrame(source, (error, stopped) =>
			reported.push({ stopped, resyncPosition: error.resyncPosition })
		);

		assert.deepStrictEqual([...wrapped], ['a']);
		assert.deepStrictEqual(reported, [{ stopped: true, resyncPosition: undefined }]);
		assert.strictEqual(calls, 2);
	});

	it('treats a null resync position from the native addon as end-of-log', () => {
		const error = new RangeError('truncated entry header');
		error.resyncPosition = null;
		let calls = 0;
		const wrapped = endIteratorOnCorruptFrame(
			{
				next() {
					calls++;
					throw error;
				},
			},
			(reportedError, stopped) => {
				assert.strictEqual(reportedError, error);
				assert.strictEqual(stopped, true);
			}
		);

		assert.deepStrictEqual(wrapped.next(), { done: true, value: undefined });
		assert.strictEqual(calls, 1);
	});

	it('keeps zero as a valid resync position', () => {
		const error = new RangeError('corrupt frame at offset 0');
		error.resyncPosition = 0;
		let calls = 0;
		const wrapped = endIteratorOnCorruptFrame(
			{
				next() {
					if (calls++ === 0) throw error;
					return { done: true, value: undefined };
				},
			},
			(reportedError, stopped) => {
				assert.strictEqual(reportedError, error);
				assert.strictEqual(stopped, false);
			}
		);

		assert.deepStrictEqual(wrapped.next(), { done: true, value: undefined });
		assert.strictEqual(calls, 2);
	});

	it('reports the cap-hit break as having stopped iteration, not as a clean resync', () => {
		// The reporter keys severity off the error's own shape, so a mid-log break that merely hit
		// the cap must still be distinguishable from a torn tail.
		const source = {
			next() {
				const error = new RangeError('corrupt');
				error.resyncPosition = 1;
				throw error;
			},
		};
		const reported = [];
		const wrapped = endIteratorOnCorruptFrame(source, (error, stopped) =>
			reported.push({ stopped, midLog: error.resyncPosition != null })
		);
		wrapped.next();
		assert.deepStrictEqual(reported.at(-1), { stopped: true, midLog: true });
	});

	it('does not swallow non-RangeError failures', () => {
		const source = {
			next() {
				throw new TypeError('boom');
			},
		};
		let reported = 0;
		const wrapped = endIteratorOnCorruptFrame(source, () => reported++);
		assert.throws(() => wrapped.next(), TypeError);
		assert.strictEqual(reported, 0);
	});

	it('passes a normal exhaustion through without reporting a corrupt frame', () => {
		let calls = 0;
		const source = {
			next() {
				calls++;
				return calls === 1 ? { done: false, value: 1 } : { done: true, value: undefined };
			},
		};
		let reported = 0;
		const wrapped = endIteratorOnCorruptFrame(source, () => reported++);
		assert.deepStrictEqual([...wrapped], [1]);
		assert.strictEqual(reported, 0);
	});

	it('delegates return()/throw() to the underlying iterator so early-exit cleanup runs', () => {
		let returnedWith;
		let threwWith;
		const source = {
			next() {
				return { done: false, value: 1 };
			},
			return(value) {
				returnedWith = value;
				return { done: true, value };
			},
			throw(error) {
				threwWith = error;
				return { done: true, value: undefined };
			},
		};
		const wrapped = endIteratorOnCorruptFrame(source, () => {});

		assert.strictEqual(typeof wrapped.return, 'function');
		assert.deepStrictEqual(wrapped.return('cleanup'), { done: true, value: 'cleanup' });
		assert.strictEqual(returnedWith, 'cleanup');
		// after return(), the wrapper is latched done and never touches the source again
		assert.deepStrictEqual(wrapped.next(), { done: true, value: undefined });

		assert.strictEqual(typeof wrapped.throw, 'function');
		const boom = new Error('boom');
		wrapped.throw(boom);
		assert.strictEqual(threwWith, boom);
	});

	it('return()/throw() fall back to protocol defaults and latch when the underlying lacks them', () => {
		let nextCalls = 0;
		const source = {
			next() {
				nextCalls++;
				return { done: false, value: 1 };
			},
		};
		const wrapped = endIteratorOnCorruptFrame(source, () => {});

		// return() defaults to done and latches without ever pulling the source again
		assert.deepStrictEqual(wrapped.return('x'), { done: true, value: 'x' });
		assert.deepStrictEqual(wrapped.next(), { done: true, value: undefined });
		assert.strictEqual(nextCalls, 0);

		// throw() rethrows when the source can't handle it
		const boom = new Error('boom');
		assert.throws(
			() => endIteratorOnCorruptFrame({ next: source.next }, () => {}).throw(boom),
			(error) => error === boom
		);
	});
});

// harper#2063: the reporter is what makes a lossy stream distinguishable from a healthy one, so
// its severity choice, deduplication, and key derivation are the load-bearing parts.
describe('createCorruptFrameReporter', () => {
	function setup() {
		clearCorruptFrameReports();
		const logs = { warn: [], error: [] };
		const reporter = createCorruptFrameReporter({
			warn: (message, error) => logs.warn.push({ message, error }),
			error: (message, error) => logs.error.push({ message, error }),
		});
		return { logs, report: reporter('local') };
	}

	function midLogError(position = 0x7d20bb, unreadableBytes = 26) {
		const error = new RangeError(`Corrupt transaction log entry at position ${position.toString(16)} of log 2`);
		error.logId = 2;
		error.position = position;
		error.resyncPosition = position + unreadableBytes;
		error.unreadableBytes = unreadableBytes;
		return error;
	}

	it('logs a mid-log break at error level and records the lost bytes', () => {
		const { logs, report } = setup();
		report(midLogError(), false);

		assert.strictEqual(logs.warn.length, 0);
		assert.strictEqual(logs.error.length, 1);
		assert.match(logs.error[0].message, /26 byte\(s\) are unreadable/);
		const reports = getCorruptFrameReports();
		assert.strictEqual(reports.length, 1);
		assert.deepStrictEqual(
			{ log: reports[0].log, midLog: reports[0].midLog, unreadableBytes: reports[0].unreadableBytes },
			{ log: 'local', midLog: true, unreadableBytes: 26 }
		);
	});

	it('logs a torn tail at warn level', () => {
		const { logs, report } = setup();
		const error = new RangeError('truncated entry header');
		error.logId = 2;
		error.position = 100;
		report(error, true);

		assert.strictEqual(logs.error.length, 0);
		assert.strictEqual(logs.warn.length, 1);
		assert.strictEqual(getCorruptFrameReports()[0].midLog, false);
	});

	// A break that hit the resync cap lost entries just the same. Reporting it as the benign
	// torn-tail warn would re-hide the condition #2063 exists to surface.
	it('logs a capped mid-log break as data loss, naming it unreachable', () => {
		const { logs, report } = setup();
		report(midLogError(), true);

		assert.strictEqual(logs.warn.length, 0);
		assert.match(logs.error[0].message, /remain unreachable.*until the worker\/store reader is reconstructed/);
	});

	it('counts repeats of the same break without re-logging it', () => {
		const { logs, report } = setup();
		report(midLogError(), false);
		report(midLogError(), false);
		report(midLogError(), false);

		assert.strictEqual(logs.error.length, 1);
		const [only] = getCorruptFrameReports();
		assert.strictEqual(only.occurrences, 3);
		assert.ok(only.lastSeen >= only.firstSeen);
	});

	// The first pass may sit behind 32 other breaks and hit the cap; a later pass, its cursor
	// further along, resyncs cleanly. The report and the tracked state must follow.
	it('updates the stopped state on a later encounter of the same break', () => {
		const { report } = setup();
		report(midLogError(), true);
		assert.strictEqual(getCorruptFrameReports()[0].stoppedIteration, true);

		report(midLogError(), false);
		assert.strictEqual(getCorruptFrameReports()[0].stoppedIteration, false);
	});

	// Against a rocksdb-js with no logId/position, keying on those fields alone collapses every
	// break on the stream onto one entry, so the second real corruption is never logged.
	it('separates breaks by message when the error carries no logId/position', () => {
		const { logs, report } = setup();
		report(new RangeError('Corrupt transaction log entry at position 7d20bb of log 2'), true);
		report(new RangeError('Corrupt transaction log entry at position 3bc071 of log 23'), true);

		assert.strictEqual(getCorruptFrameReports().length, 2);
		assert.strictEqual(logs.warn.length, 2);
	});

	it('treats null native position fields as absent when keying and classifying breaks', () => {
		const { logs, report } = setup();
		for (const message of ['corrupt frame at offset 1', 'corrupt frame at offset 2']) {
			const error = new RangeError(message);
			error.logId = null;
			error.position = null;
			error.resyncPosition = null;
			report(error, true);
		}

		assert.strictEqual(getCorruptFrameReports().length, 2);
		assert.strictEqual(logs.warn.length, 2);
		assert.strictEqual(logs.error.length, 0);
	});

	it('keeps zero native position fields as valid report metadata', () => {
		const { logs, report } = setup();
		const error = midLogError(0, 0);
		error.logId = 0;
		report(error, false);

		assert.strictEqual(logs.error.length, 1);
		assert.deepStrictEqual(
			{ logId: getCorruptFrameReports()[0].logId, position: getCorruptFrameReports()[0].position },
			{ logId: 0, position: 0 }
		);
	});

	it('bounds retained break sites by evicting the oldest', () => {
		const { logs, report } = setup();
		for (let i = 0; i < MAX_CORRUPT_FRAME_REPORTS + 5; i++) {
			report(midLogError(0x1000 + i * 0x100), false);
		}

		assert.strictEqual(getCorruptFrameReports().length, MAX_CORRUPT_FRAME_REPORTS);
		assert.strictEqual(getEvictedCorruptFrameReportCount(), 5);
		assert.strictEqual(logs.error.length, MAX_CORRUPT_FRAME_REPORTS + 5);
	});

	// Refusing a new site once full would leave it undeduplicated, so it would re-log on every
	// drain — the log spam this report exists to replace.
	it('keeps deduplicating the newest sites after the bound is reached', () => {
		const { logs, report } = setup();
		for (let i = 0; i < MAX_CORRUPT_FRAME_REPORTS + 5; i++) {
			report(midLogError(0x1000 + i * 0x100), false);
		}
		const logsAfterFill = logs.error.length;

		// re-encounter the most recent site repeatedly, as every later drain would
		for (let i = 0; i < 10; i++) {
			report(midLogError(0x1000 + (MAX_CORRUPT_FRAME_REPORTS + 4) * 0x100), false);
		}

		assert.strictEqual(logs.error.length, logsAfterFill);
		assert.strictEqual(getEvictedCorruptFrameReportCount(), 5);
	});

	it('retains recently encountered sites when evicting old reports', () => {
		const { logs, report } = setup();
		for (let i = 0; i < MAX_CORRUPT_FRAME_REPORTS; i++) {
			report(midLogError(0x1000 + i * 0x100), false);
		}
		const firstPosition = 0x1000;
		const secondPosition = 0x1100;
		report(midLogError(firstPosition), false);
		report(midLogError(0x1000 + MAX_CORRUPT_FRAME_REPORTS * 0x100), false);

		const positions = getCorruptFrameReports().map((entry) => entry.position);
		assert.ok(positions.includes(firstPosition));
		assert.ok(!positions.includes(secondPosition));
		assert.strictEqual(logs.error.length, MAX_CORRUPT_FRAME_REPORTS + 1);
	});
});

// Regression tests for HarperFast/harper#1266: a boot replay over a backlog of unwritable entries
// (undecodable peer-log entries, or entries for a dropped table) must give up once it is making no
// forward progress, instead of grinding the main thread for minutes. A healthy replay (which keeps
// producing writes that reset the no-progress counters) must never trip the bound, and neither must
// a single skip followed by an unrelated latency spike.
describe('shouldAbortStalledReplay', () => {
	it('exposes conservative default bounds', () => {
		assert.strictEqual(REPLAY_NO_PROGRESS_COUNT_LIMIT, 100_000);
		assert.strictEqual(REPLAY_NO_PROGRESS_TIME_LIMIT_MS, 60_000);
		assert.strictEqual(REPLAY_NO_PROGRESS_TIME_SKIP_FLOOR, 1_000);
	});

	it('does not abort while the no-progress run is below both bounds', () => {
		assert.strictEqual(shouldAbortStalledReplay(0, 0), false);
		assert.strictEqual(shouldAbortStalledReplay(1, 0), false);
		assert.strictEqual(shouldAbortStalledReplay(REPLAY_NO_PROGRESS_COUNT_LIMIT - 1, 0), false);
		assert.strictEqual(shouldAbortStalledReplay(50_000, REPLAY_NO_PROGRESS_TIME_LIMIT_MS - 1), false);
	});

	it('aborts once the no-progress count reaches the limit', () => {
		assert.strictEqual(shouldAbortStalledReplay(REPLAY_NO_PROGRESS_COUNT_LIMIT, 0), true);
		assert.strictEqual(shouldAbortStalledReplay(REPLAY_NO_PROGRESS_COUNT_LIMIT + 1, 0), true);
	});

	it('does NOT trip the time bound on a tiny no-progress run (a single skip + a latency spike)', () => {
		// harper#1266 review (Gemini): a lone skip followed by a GC/disk-throttle pause longer than
		// the time limit must not abort an otherwise-healthy replay — the time bound requires a real
		// run of no-progress entries first.
		assert.strictEqual(shouldAbortStalledReplay(1, REPLAY_NO_PROGRESS_TIME_LIMIT_MS), false);
		assert.strictEqual(
			shouldAbortStalledReplay(REPLAY_NO_PROGRESS_TIME_SKIP_FLOOR - 1, 10 * REPLAY_NO_PROGRESS_TIME_LIMIT_MS),
			false
		);
	});

	it('aborts once a substantial slow no-progress run crosses the time bound below the count limit', () => {
		// Belt-and-suspenders: slow per-entry decodes can burn minutes well before the count bound.
		assert.strictEqual(
			shouldAbortStalledReplay(REPLAY_NO_PROGRESS_TIME_SKIP_FLOOR, REPLAY_NO_PROGRESS_TIME_LIMIT_MS),
			true
		);
		assert.strictEqual(
			shouldAbortStalledReplay(REPLAY_NO_PROGRESS_TIME_SKIP_FLOOR, REPLAY_NO_PROGRESS_TIME_LIMIT_MS - 1),
			false
		);
	});

	it('honors caller-supplied bounds (used to keep unit tests fast/deterministic)', () => {
		// signature: (noProgressRun, msSinceProgress, countLimit, timeLimitMs, timeSkipFloor)
		assert.strictEqual(shouldAbortStalledReplay(3, 0, 5, 1000, 2), false);
		assert.strictEqual(shouldAbortStalledReplay(5, 0, 5, 1000, 2), true);
		assert.strictEqual(shouldAbortStalledReplay(2, 1000, 5, 1000, 2), true);
		assert.strictEqual(shouldAbortStalledReplay(1, 1000, 5, 1000, 2), false);
		assert.strictEqual(shouldAbortStalledReplay(2, 999, 5, 1000, 2), false);
	});
});

// Regression tests for HarperFast/harper#1316 (facet a): a slow-but-progressing replay (e.g.
// deep out-of-order audit chain walks per entry) resets noProgressRun on every write, so
// shouldAbortStalledReplay never fires — the boot thread can be pegged indefinitely. This guard
// fires on total elapsed time regardless of forward progress.
describe('shouldAbortSlowReplay', () => {
	it('exposes a conservative default wall-clock limit', () => {
		assert.strictEqual(REPLAY_WALL_CLOCK_LIMIT_MS, 10 * 60 * 1000);
	});

	it('does not abort while the elapsed time is below the limit', () => {
		assert.strictEqual(shouldAbortSlowReplay(0), false);
		assert.strictEqual(shouldAbortSlowReplay(REPLAY_WALL_CLOCK_LIMIT_MS - 1), false);
	});

	it('aborts once the elapsed time meets or exceeds the limit', () => {
		assert.strictEqual(shouldAbortSlowReplay(REPLAY_WALL_CLOCK_LIMIT_MS), true);
		assert.strictEqual(shouldAbortSlowReplay(REPLAY_WALL_CLOCK_LIMIT_MS + 1), true);
	});

	it('honors a caller-supplied limit (used to keep unit tests fast/deterministic)', () => {
		assert.strictEqual(shouldAbortSlowReplay(999, 1000), false);
		assert.strictEqual(shouldAbortSlowReplay(1000, 1000), true);
		assert.strictEqual(shouldAbortSlowReplay(1001, 1000), true);
	});

	it('fires even when writes are succeeding (unlike shouldAbortStalledReplay)', () => {
		// The key difference: shouldAbortStalledReplay only fires on no-progress runs.
		// shouldAbortSlowReplay fires purely on total elapsed time — writes or not.
		assert.strictEqual(shouldAbortSlowReplay(5000, 1000), true);
		assert.strictEqual(shouldAbortSlowReplay(500, 1000), false);
	});
});
