const assert = require('node:assert');

// The helper lives in a dependency-free module so the test doesn't need to bootstrap
// the full Resource/RocksDB module graph (which has a circular require chain).
const { classifyAuditEntryForReplay, RECORD_BEARING_FLAGS } = require('#src/resources/replayLogsGuards');

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
