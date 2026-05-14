const assert = require('node:assert');

// The helper lives in a dependency-free module so the test doesn't need to bootstrap
// the full Resource/RocksDB module graph (which has a circular require chain).
const { classifyAuditEntryForReplay, REQUIRES_RECORD } = require('#src/resources/replayLogsGuards');

// Regression tests for the unclean-shutdown replay guards. Without these, an audit log
// containing entries with corrupt MessagePack values caused replayLogs to write
// `undefined` records and crash inside validate(), looping at ~100% CPU on every entry.

describe('classifyAuditEntryForReplay', () => {
	it('rejects entries where readAuditEntry returned {} (no type/tableId)', () => {
		assert.strictEqual(classifyAuditEntryForReplay(undefined, undefined, false), 'corrupt-header');
		assert.strictEqual(classifyAuditEntryForReplay(undefined, 1, true), 'corrupt-header');
		assert.strictEqual(classifyAuditEntryForReplay('put', undefined, true), 'corrupt-header');
	});

	it('rejects record-requiring types when the decoded record is missing', () => {
		for (const type of ['put', 'patch', 'message', 'invalidate']) {
			assert.strictEqual(classifyAuditEntryForReplay(type, 1, false), 'missing-record', `type=${type}`);
		}
	});

	it('accepts record-requiring types when the record is present', () => {
		for (const type of ['put', 'patch', 'message', 'invalidate']) {
			assert.strictEqual(classifyAuditEntryForReplay(type, 1, true), null, `type=${type}`);
		}
	});

	it('accepts ops that legitimately carry no value (delete, relocate, structures)', () => {
		// These types don't dereference the record on the write path, so a missing value
		// shouldn't cause a skip — replay must still process them to keep state consistent.
		assert.strictEqual(classifyAuditEntryForReplay('delete', 1, false), null);
		assert.strictEqual(classifyAuditEntryForReplay('relocate', 1, false), null);
		assert.strictEqual(classifyAuditEntryForReplay('structures', 1, false), null);
	});

	it('REQUIRES_RECORD covers the write paths that read record fields in validate()', () => {
		// Lock the set so future additions of record-requiring types are intentional;
		// drifting this without updating the loop guard would re-introduce the crash.
		assert.deepStrictEqual([...REQUIRES_RECORD].sort(), ['invalidate', 'message', 'patch', 'put']);
	});
});
