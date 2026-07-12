// Regression guard for the v4->v5 migration canonical-seed root cause (HarperFast/harper#1508).
//
// copyDb's structure observer builds the canonical v5 dictionary by encoding shapeForStructure(record)
// for each migrated record. The migration reads source records as RecordObject instances (the encoder's
// structPrototype), NOT plain Object. shapeForStructure used to gate recursion on
// `value.constructor === Object`, so a RecordObject fell through to the scalar stub (1): the observer
// then minted no structure, canonicalStructures stayed undefined, the seed was never persisted, and
// every v5 worker forked the dictionary from an empty durable. shapeForStructure must recurse decoded
// records (any non-leaf object) while still stubbing leaf object types (Blob/Date/typed arrays).
const assert = require('node:assert');
const { shapeForStructure } = require('#src/bin/copyDb');

describe('shapeForStructure (#1508)', function () {
	it('recurses a decoded record (non-plain object), not just plain Object', function () {
		// Simulate a decoded record: a class instance (constructor !== Object) with data fields, like the
		// RecordObject the migration actually reads. The old constructor===Object gate stubbed this to 1.
		class RecordObject {}
		const record = new RecordObject();
		record.id = 'a';
		record.name = 'n';
		record.tags = ['x', 'y'];
		record.nested = { level: 1, child: { k: 'v' } };
		const shape = shapeForStructure(record);
		assert.notStrictEqual(shape, 1, 'a decoded record was stubbed to a scalar -> observer mints no structure (#1508)');
		assert.deepEqual(shape, { id: 1, name: 1, tags: [1, 1], nested: { level: 1, child: { k: 1 } } });
	});

	it('still recurses plain objects and arrays', function () {
		assert.deepEqual(shapeForStructure({ a: 1, b: { c: 2 } }), { a: 1, b: { c: 1 } });
		assert.deepEqual(shapeForStructure([{ a: 1 }, 2]), [{ a: 1 }, 1]);
	});

	it('stubs leaf values (primitives and leaf object types) to a scalar', function () {
		const leaves = [
			's',
			5,
			true,
			null,
			new Date(),
			Buffer.from('x'),
			new Uint8Array([1]),
			new ArrayBuffer(4),
			new Map(),
			new Set(),
		];
		if (typeof SharedArrayBuffer !== 'undefined') leaves.push(new SharedArrayBuffer(4));
		for (const leaf of leaves) {
			assert.equal(shapeForStructure(leaf), 1, `expected ${String(leaf)} to stub to 1`);
		}
		// A Blob must stay a leaf — recursing it would pull the file-backed payload shapeForStructure avoids.
		if (typeof Blob !== 'undefined') assert.equal(shapeForStructure(new Blob(['x'])), 1, 'Blob must stub to 1');
	});

	it('uses own enumerable keys only (no prototype-chain leakage)', function () {
		// A record whose prototype carries an enumerable property must not leak it into the skeleton's
		// key set — that would diverge from the struct fields msgpackr encodes for the record.
		const proto = { inheritedEnumerable: 'x' };
		const record = Object.create(proto);
		record.id = 'a';
		record.value = 7;
		assert.deepEqual(shapeForStructure(record), { id: 1, value: 1 });
	});
});
