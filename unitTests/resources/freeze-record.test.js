// Read-side guard for #1298: freezeRecord() must not throw on a bare-TypedArray record root.
// V8 throws "Cannot freeze array buffer views with elements" on Object.freeze of a non-empty
// TypedArray/DataView, which used to 500 every scan over a table holding such a record. This
// guard backstops records that bypass write validation (source/cache population, replication of
// legacy data) and lets an already-poisoned table recover after upgrade.
require('../testUtils');
const assert = require('node:assert');
const { freezeRecord } = require('#src/resources/Table');

describe('freezeRecord (#1298 read-side guard)', () => {
	it('does not throw on bare TypedArray / DataView / ArrayBuffer roots', () => {
		assert.doesNotThrow(() => freezeRecord(Buffer.from([1, 2, 3])));
		assert.doesNotThrow(() => freezeRecord(new Uint8Array([1, 2, 3])));
		assert.doesNotThrow(() => freezeRecord(new Float64Array([1.5, 2.5])));
		assert.doesNotThrow(() => freezeRecord(new DataView(new ArrayBuffer(8))));
		assert.doesNotThrow(() => freezeRecord(new ArrayBuffer(8)));
	});

	it('leaves binary roots unfrozen (the freeze is shallow; they need none)', () => {
		const buf = Buffer.from([1, 2, 3]);
		freezeRecord(buf);
		assert.equal(Object.isFrozen(buf), false);
	});

	it('freezes plain object records', () => {
		const record = { id: 1, name: 'x' };
		freezeRecord(record);
		assert.equal(Object.isFrozen(record), true);
	});

	it('is a harmless no-op on null / undefined / primitives', () => {
		assert.doesNotThrow(() => freezeRecord(null));
		assert.doesNotThrow(() => freezeRecord(undefined));
		assert.doesNotThrow(() => freezeRecord(42));
		assert.doesNotThrow(() => freezeRecord('a string'));
	});
});
