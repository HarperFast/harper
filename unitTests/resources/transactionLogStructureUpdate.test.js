const assert = require('assert');
const { RocksTransactionLogStore } = require('#src/resources/RocksTransactionLogStore');
const { readAuditEntry } = require('#src/resources/auditStore');
const { HAS_STRUCTURE_UPDATE } = require('#src/resources/RecordEncoder');

// A mock per-node transaction log that captures appended entry binaries. The binaries must be
// copied because the audit encoder reuses a single ENTRY_HEADER buffer between createAuditEntry calls.
function makeLog() {
	return {
		entries: [],
		addEntry(bin) {
			this.entries.push(Buffer.from(bin));
		},
	};
}

// nodeLogs is indexed by nodeId; logById() reads it directly, so we can drive put() against
// distinct per-node logs without a real RocksDB.
function makeStore(logs) {
	const store = new RocksTransactionLogStore({ useLog: () => makeLog() });
	store.nodeLogs = logs;
	return store;
}

function put(store, nodeId, structureVersion, { tableId = 1, extendedType = 0, commit = true } = {}) {
	// `delete` carries no record, keeping the serialized entry self-contained for decode.
	const auditRecord = {
		type: 'delete',
		tableId,
		recordId: `t${tableId}-k${nodeId}-${structureVersion}`,
		nodeId,
		version: 1_700_000_000_000 + structureVersion,
		structureVersion,
		extendedType,
	};
	const transaction = { id: 1, isRetry: false };
	store.put(null, auditRecord, { nodeId, transaction });
	// The watermark advances only on durable commit. Simulate that by default; `commit: false` models a
	// discarded/aborted append (the entry's flag was set but the watermark must not advance).
	if (commit) transaction.onCommit?.();
	return auditRecord;
}

const flagged = (extendedType) => (extendedType & HAS_STRUCTURE_UPDATE) !== 0;

describe('RocksTransactionLogStore per-log HAS_STRUCTURE_UPDATE (harper#1348)', () => {
	it('flags an entry when its structureVersion advances the log, and not otherwise', () => {
		const log0 = makeLog();
		const store = makeStore([log0]);

		assert.ok(flagged(put(store, 0, 3).extendedType), 'first higher structureVersion flags');
		assert.ok(!flagged(put(store, 0, 3).extendedType), 'same structureVersion does not flag');
		assert.ok(flagged(put(store, 0, 5).extendedType), 'a further increase flags again');
		assert.ok(!flagged(put(store, 0, 5).extendedType), 'no further increase does not flag');

		// The flag must survive serialization (decode skips the 4-byte structureVersion header).
		const firstDecoded = readAuditEntry(log0.entries[0], 4, undefined);
		assert.ok(flagged(firstDecoded.extendedType), 'flag round-trips through the serialized entry');
	});

	it('tracks structureVersion per log, so a peer log learns a structure independently', () => {
		const log0 = makeLog();
		const log1 = makeLog();
		const store = makeStore([log0, log1]);

		assert.ok(flagged(put(store, 0, 5).extendedType), 'log 0 first entry flags');
		// log 1 has never been advanced; its first entry must flag even though log 0 already reached 5.
		// This is the core fix: the flag is derived per-log, not from a single shared/one-shot signal.
		assert.ok(flagged(put(store, 1, 4).extendedType), 'log 1 first entry flags independently of log 0');
		assert.ok(!flagged(put(store, 1, 4).extendedType), 'log 1 same structureVersion does not flag');
	});

	it('never strips a flag the encoder already set, even when the count is unchanged', () => {
		const store = makeStore([makeLog()]);
		put(store, 0, 5); // advance the (log, table) watermark to 5
		// An entry at the same count that already carries the encoder's one-shot flag must keep it (the per-log
		// derivation only adds HAS_STRUCTURE_UPDATE, never clears it).
		assert.ok(flagged(put(store, 0, 5, { extendedType: HAS_STRUCTURE_UPDATE }).extendedType), 'pre-set flag preserved');
	});

	it('tracks structureVersion per (log, table): a high-version table does not suppress another table', () => {
		const store = makeStore([makeLog()]);
		// Table 1 advances this single per-node log to version 10.
		assert.ok(flagged(put(store, 0, 10, { tableId: 1 }).extendedType), 'table 1 advance flags');
		// Table 2's first entry (version 1) in the SAME log must still flag — its structure is independent
		// of table 1's. A log-wide watermark (10) would wrongly suppress this and recreate the bug for table 2.
		assert.ok(
			flagged(put(store, 0, 1, { tableId: 2 }).extendedType),
			'table 2 flags despite log being at v10 for table 1'
		);
		assert.ok(!flagged(put(store, 0, 1, { tableId: 2 }).extendedType), 'table 2 same version does not re-flag');
		assert.ok(flagged(put(store, 0, 2, { tableId: 2 }).extendedType), 'table 2 advance flags again');
	});

	it('advances the watermark only on durable commit, so an aborted entry does not suppress a later flag', () => {
		const store = makeStore([makeLog()]);
		// First entry at v7 is flagged but its transaction never commits (aborted/discarded).
		assert.ok(flagged(put(store, 0, 7, { commit: false }).extendedType), 'aborted entry is still flagged');
		// Because the watermark was NOT advanced by the aborted entry, the next committed entry at the same
		// structureVersion must still carry the flag — otherwise a linear reader could miss the structure (P2).
		assert.ok(flagged(put(store, 0, 7).extendedType), 'same-version entry after an aborted attempt still flags');
		// Once committed, the watermark advances and a further same-version entry no longer re-flags.
		assert.ok(!flagged(put(store, 0, 7).extendedType), 'after a committed entry, same version stops flagging');
	});
});
