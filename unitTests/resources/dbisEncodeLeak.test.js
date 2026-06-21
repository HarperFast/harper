require('../testUtils');
const assert = require('assert');
const { RecordEncoder, setNextEncoding, clearNextEncoding } = require('#src/resources/RecordEncoder');
const { Encoder } = require('msgpackr');

// Shared structures persisted as an encoded buffer (mirrors how a DBI stores them under
// Symbol.for('structures')), so structures cross between encoder instances.
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

function makeEncoder(useVersions, store) {
	return new RecordEncoder({
		structures: [],
		randomAccessStructure: false, // non-primary / __dbis__ style
		useVersions,
		getStructures: store.get,
		saveStructures: store.save,
	});
}

// A __dbis__ `seq` cursor value — the record at the center of harper#1307 / harper-pro#352.
const seqRecord = { seqId: 1781538711832, nodes: [] };

// The metadata a versioned delete leaves in the module-level *NextEncoding globals when its encode
// is skipped (record === undefined): a timestamp + HAS_NODE_ID(64) + the deleted record's nodeId.
const HAS_NODE_ID = 64;
function simulateLeakedDelete() {
	setNextEncoding(
		/* timestamp */ 1781538711832,
		/* metadata */ HAS_NODE_ID,
		/* expiresAt */ -1,
		/* nodeId */ 1,
		/* residencyId */ 0
	);
}

describe('RecordEncoder version-metadata gating (harper#1307)', () => {
	// Defaults match clearNextEncoding(), so this guarantees a clean baseline regardless of order,
	// and avoids leaking module state into other suites in the same mocha process.
	beforeEach(() => clearNextEncoding());
	afterEach(() => clearNextEncoding());

	it('a non-versioned store ignores leaked metadata and encodes the record plainly (round-trips)', () => {
		const store = sharedStore();
		const enc = makeEncoder(false, store);
		const clean = Buffer.from(enc.encode(seqRecord)); // baseline: no pending metadata

		simulateLeakedDelete();
		const afterLeak = Buffer.from(enc.encode(seqRecord));

		assert.deepStrictEqual(
			[...afterLeak],
			[...clean],
			'a useVersions:false store must not prefix its record with leaked timestamp/nodeId'
		);
		// The actual #352 failure mode: a prefixed __dbis__ record decodes to null on the non-versioned
		// read path. With no prefix it round-trips cleanly.
		const reader = makeEncoder(false, store);
		assert.deepStrictEqual(reader.decode(afterLeak), seqRecord, 'seq record must round-trip, not decode to null');
	});

	it('does NOT consume in-flight metadata staged for a versioned write (no metadata theft)', () => {
		// The nested-write case: recordUpdater stages the primary record's metadata, then a nested write
		// into a non-versioned store (e.g. a node-id-map update) runs before the primary encode. The
		// non-versioned encode must encode plainly AND leave the staged globals for the primary — if it
		// consumed/cleared them, the primary record would lose its prefix.
		const versioned = makeEncoder(true, sharedStore());
		const nonVersioned = makeEncoder(false, sharedStore());
		const cleanPrimary = Buffer.from(versioned.encode(seqRecord)); // baseline: no metadata

		simulateLeakedDelete(); // the primary write's staged metadata
		nonVersioned.encode(seqRecord); // nested non-versioned write — must not touch the globals
		const primaryOut = Buffer.from(versioned.encode(seqRecord)); // the primary encode

		assert.ok(
			primaryOut.length > cleanPrimary.length,
			`the primary write must still get its prefix after a nested non-versioned write (got ${primaryOut.length} vs ${cleanPrimary.length})`
		);
	});

	it('a versioned store still applies pending metadata (no regression)', () => {
		const store = sharedStore();
		const enc = makeEncoder(true, store);
		const clean = Buffer.from(enc.encode(seqRecord));

		simulateLeakedDelete();
		const withMeta = Buffer.from(enc.encode(seqRecord));

		assert.ok(
			withMeta.length > clean.length,
			`a useVersions:true store must still apply the metadata prefix (got ${withMeta.length} vs ${clean.length})`
		);
	});

	it('useVersions defaults to true when unspecified (option may not propagate to the encoder)', () => {
		const store = sharedStore();
		const enc = new RecordEncoder({
			structures: [],
			randomAccessStructure: false,
			getStructures: store.get,
			saveStructures: store.save,
		});
		assert.strictEqual(
			enc.useVersions,
			true,
			'omitted useVersions must default to true so prefixes are never silently dropped'
		);
	});

	it('clearNextEncoding() drops pending metadata so a later encode does not apply it', () => {
		const store = sharedStore();
		const enc = makeEncoder(true, store);
		const clean = Buffer.from(enc.encode(seqRecord));

		simulateLeakedDelete();
		clearNextEncoding();
		const after = Buffer.from(enc.encode(seqRecord));

		assert.deepStrictEqual([...after], [...clean], 'clearNextEncoding must drop the pending metadata');
	});
});
