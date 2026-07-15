// #1786 review (heskew): the record-scoped allowRead guard must see a read-only view of a
// record on the caching-table source-revalidation path, WITHOUT freezing the actual object —
// that object is the SAME one the deferred commit still mutates (createdAt/updatedAt) and
// persists, so freezing it directly would break that write.
require('../testUtils');
const assert = require('node:assert');
const { frozenRecordView } = require('#src/resources/Table');

describe('frozenRecordView (#1786 source-revalidation guard view)', () => {
	it('returns an already-frozen record unchanged (the common, already-safe local-read path)', () => {
		const record = Object.freeze({ id: 1, secret: 'x' });
		assert.strictEqual(frozenRecordView(record), record);
	});

	it('blocks writes on an unfrozen record without freezing the original', () => {
		const record = { id: 1, secret: 'x' };
		const view = frozenRecordView(record);
		assert.notStrictEqual(view, record, 'must be a distinct view, not the original object');
		assert.equal(Object.isFrozen(record), false, 'the original object must remain mutable');

		assert.throws(() => {
			'use strict';
			view.secret = 'mutated';
		}, TypeError);
		assert.equal(record.secret, 'x', 'a write through the view must not reach the original');

		// The commit path this guards must still be able to mutate the real object afterward.
		record.updatedAt = 12345;
		assert.equal(record.updatedAt, 12345);
	});

	it('reads pass through to the original, including getters bound to the real record', () => {
		const record = {
			id: 1,
			get computed() {
				// A lazy-decode getter (e.g. a caching table's structPrototype) must see `this` as the
				// REAL record, not the view, or it can't reach its own backing state.
				return this === record ? 'real' : 'wrong-this';
			},
		};
		const view = frozenRecordView(record);
		assert.equal(view.id, 1);
		assert.equal(view.computed, 'real');
	});

	it('leaves an Array root wrapped and read-only without eagerly copying (preserves .length)', () => {
		const record = [1, 2, 3];
		const view = frozenRecordView(record);
		assert.equal(view.length, 3);
		assert.equal(view[0], 1);
		assert.throws(() => {
			'use strict';
			view.push(4);
		});
		assert.deepEqual(record, [1, 2, 3], 'the original array must be untouched');
	});

	it('does not freeze/wrap Date/Map/Set roots — internal-slot types can legitimately be a cached record', () => {
		const date = new Date(0);
		const map = new Map([['a', 1]]);
		const set = new Set([1, 2]);
		assert.strictEqual(frozenRecordView(date), date);
		assert.strictEqual(frozenRecordView(map), map);
		assert.strictEqual(frozenRecordView(set), set);
		// Confirms these are returned genuinely unwrapped and still fully usable — a Proxy or copy
		// would throw "incompatible receiver" on these method calls.
		assert.doesNotThrow(() => date.getTime());
		assert.doesNotThrow(() => map.get('a'));
		assert.doesNotThrow(() => set.has(1));
	});

	it('is a harmless no-op on null / undefined / primitives / binary roots', () => {
		assert.doesNotThrow(() => frozenRecordView(null));
		assert.doesNotThrow(() => frozenRecordView(undefined));
		assert.equal(frozenRecordView(42), 42);
		assert.equal(frozenRecordView('a string'), 'a string');
		const buf = Buffer.from([1, 2, 3]);
		assert.strictEqual(frozenRecordView(buf), buf);
	});
});
