require('../testUtils');
const assert = require('assert');
const RecordEncoderMod = require('#src/resources/RecordEncoder');
const { RecordEncoder, recordUpdater, setNextEncoding, clearNextEncoding } = RecordEncoderMod;
const { Encoder } = require('msgpackr');

function sharedStore() {
	let buf;
	const meta = new Encoder();
	return {
		save(s) {
			buf = meta.encode(s);
			return true;
		},
		get() {
			return buf ? meta.decode(buf) : undefined;
		},
	};
}

function makeEncoder(store) {
	return new RecordEncoder({
		structures: [],
		randomAccessStructure: false,
		useVersions: true,
		getStructures: store.get,
		saveStructures: store.save,
	});
}

describe('lastValueEncoding stale-state reset (harper#1309)', () => {
	beforeEach(() => clearNextEncoding());
	afterEach(() => clearNextEncoding());

	it('resets lastValueEncoding at the start of each call so record===undefined cannot carry stale bytes', () => {
		const enc = makeEncoder(sharedStore());

		// Seed lastValueEncoding by encoding a real record through the versioned path.
		setNextEncoding(/* timestamp */ 1000, /* metadata */ 0);
		enc.encode({ name: 'seed' });
		assert.ok(RecordEncoderMod.lastValueEncoding != null, 'precondition: lastValueEncoding should be set after encode');

		// Call recordUpdater with record===undefined (the no-op / delete path).
		// With the fix, lastValueEncoding is reset before the function body runs — no encode occurs
		// (record is undefined), so the reset is permanent for this call.
		const mockStore = { put: () => undefined, rootStore: null };
		const updater = recordUpdater(mockStore, /* tableId */ 1, /* auditStore */ null);
		updater(
			'test-key', // id
			undefined, // record — triggers the no-encode path
			null, // existingEntry
			2000, // newVersion
			-1, // assignMetadata (default: no extra metadata)
			false // audit=false — skip auditStore writes, keep mock simple
		);

		assert.strictEqual(
			RecordEncoderMod.lastValueEncoding,
			undefined,
			'lastValueEncoding must be undefined after a record===undefined call; stale bytes from a prior call must not persist'
		);
	});
});
