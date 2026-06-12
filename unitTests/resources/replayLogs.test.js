const assert = require('node:assert');

// The helper lives in a dependency-free module so the test doesn't need to bootstrap
// the full Resource/RocksDB module graph (which has a circular require chain).
const {
	classifyAuditEntryForReplay,
	isUndecodableValidatedWrite,
	RECORD_BEARING_FLAGS,
	endIteratorOnCorruptFrame,
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
	// catches `undefined` — lets it through. For put/patch the replay then calls save() ->
	// validate(), which crashes on the null body ("Cannot read properties of undefined
	// (reading 'id')"). This guard skips exactly those, and ONLY those.
	it('skips put/patch whose body failed to decode (null or undefined)', () => {
		assert.strictEqual(isUndecodableValidatedWrite('put', null), true);
		assert.strictEqual(isUndecodableValidatedWrite('put', undefined), true);
		assert.strictEqual(isUndecodableValidatedWrite('patch', null), true);
		assert.strictEqual(isUndecodableValidatedWrite('patch', undefined), true);
	});

	it('does not skip put/patch with a decoded body, including falsy primitives', () => {
		assert.strictEqual(isUndecodableValidatedWrite('put', { id: 1 }), false);
		assert.strictEqual(isUndecodableValidatedWrite('patch', 0), false);
		assert.strictEqual(isUndecodableValidatedWrite('put', ''), false);
		assert.strictEqual(isUndecodableValidatedWrite('patch', false), false);
	});

	it('never skips invalidate on a null body — a no-index table stores a legitimate null partial record', () => {
		// invalidate carries HAS_PARTIAL_RECORD but never reaches validate(); skipping it would
		// leave the record un-invalidated/stale after recovery.
		assert.strictEqual(isUndecodableValidatedWrite('invalidate', null), false);
		assert.strictEqual(isUndecodableValidatedWrite('invalidate', undefined), false);
	});

	it('does not skip other record-bearing / non-validated actions on a null body', () => {
		// Only put/patch run validate(); message/relocate/delete must pass through untouched.
		assert.strictEqual(isUndecodableValidatedWrite('message', null), false);
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
