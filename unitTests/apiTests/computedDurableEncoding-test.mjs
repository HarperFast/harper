'use strict';

// harper#2359: a resolved attribute owns its name, so no durable encoding may carry a value under it,
// and a record that already does must still materialize with the resolver authoritative. FourProp
// supplies `nameTitle` (@computed @enumerable, so the response projection surfaces it) and
// `ageInMonths` (@computed).
import assert from 'node:assert';
import { setupTestApp } from './setupTestApp.mjs';
import { storedFieldsOnly } from '#src/resources/RecordEncoder';

const RESOLVED = ['nameTitle', 'ageInMonths'];

// Asserting the projection rather than encoded bytes keeps the test off the shared, reused encode
// buffer; the wiring into real encodes is covered by integrationTests/resources/cachedComputedAttribute.test.ts.
function durableProjection(store, record) {
	return storedFieldsOnly(store.encoder, record);
}

describe('resolved attributes stay out of durable encodings', function () {
	before(async function () {
		await setupTestApp();
	});

	it('the response projection surfaces a computed attribute but the durable encoding does not', () => {
		const store = tables.FourProp.primaryStore;
		const record = new store.encoder.structPrototype.constructor();
		Object.assign(record, { id: 'durable-2359', name: 'name', title: 'title', age: 3 });

		// Establishes the premise: this record reaches the encoder carrying the projection that adds the
		// computed value (the contamination route), not merely a plain object.
		assert.ok(Object.keys(record.toJSON()).includes('nameTitle'));

		const keys = Object.keys(durableProjection(store, record));
		for (const name of RESOLVED) assert.ok(!keys.includes(name), `${name} must not be durably encoded`);
		assert.ok(keys.includes('name'));
		assert.ok(keys.includes('title'));
	});

	it('a class instance smuggling a resolver-owned key through its own toJSON is projected', () => {
		const store = tables.FourProp.primaryStore;
		class Row {
			constructor() {
				this.id = 'tojson-2359';
				this.name = 'n';
			}
			toJSON() {
				return { ...this, nameTitle: 'SMUGGLED' };
			}
		}
		const projected = durableProjection(store, new Row());
		assert.ok(!Object.hasOwn(projected, 'nameTitle'), 'the toJSON output must be projected too');
		assert.strictEqual(projected.name, 'n', 'the serialized shape must otherwise be preserved');

		class CleanRow {
			constructor() {
				this.id = 'tojson-clean';
			}
			toJSON() {
				return { id: this.id, extra: 'serialized' };
			}
		}
		const clean = durableProjection(store, new CleanRow());
		assert.strictEqual(clean.extra, 'serialized', 'a clean toJSON serialization must be honored');
	});

	it('an own __proto__ key survives the projection as a data property', () => {
		const store = tables.FourProp.primaryStore;
		const record = { id: 'proto-2359', name: 'n', title: 't', age: 1, nameTitle: 'FORGED' };
		Object.defineProperty(record, '__proto__', { value: { injected: true }, enumerable: true, configurable: true });
		const projected = durableProjection(store, record);
		assert.notStrictEqual(projected, record, 'the colliding key must force a projection');
		const descriptor = Object.getOwnPropertyDescriptor(projected, '__proto__');
		assert.ok(descriptor && 'value' in descriptor, '__proto__ must be an own data property');
		assert.deepStrictEqual(descriptor.value, { injected: true });
		assert.strictEqual(Object.getPrototypeOf(projected), Object.prototype, 'the prototype must not be swapped');
		assert.ok(!('injected' in Object.getPrototypeOf(projected)), 'no pollution of the prototype');
	});

	it('an own key colliding with a resolved attribute is dropped from the durable encoding', () => {
		const store = tables.FourProp.primaryStore;
		const keys = Object.keys(
			durableProjection(store, { id: 'durable-own-2359', name: 'name', title: 'title', age: 3, nameTitle: 'WRONG' })
		);
		assert.ok(!keys.includes('nameTitle'));
		assert.ok(keys.includes('name'));
	});

	it('assigning a computed attribute on a resource instance throws a client error', () => {
		const instance = Object.create(tables.FourProp.prototype);
		assert.throws(() => {
			instance.nameTitle = 'assigned';
		}, /computed attribute/);
	});

	it('a relationship attribute is resolver-owned, and a table with no resolved attributes is untouched', () => {
		const resolved = tables.FourProp.primaryStore.encoder.resolvedAttributeNames;
		for (const name of RESOLVED) assert.ok(resolved.has(name), `${name} must be resolver-owned`);
		assert.ok(tables.Related.primaryStore.encoder.resolvedAttributeNames.has('subObject'));
		// The undefined (not empty-set) marker is what keeps the projection off an unaffected table's
		// write path entirely.
		assert.strictEqual(tables.VariedProps.primaryStore.encoder.resolvedAttributeNames, undefined);
	});
});

describe('the audit encodedRecord takes the durable projection', function () {
	before(async function () {
		await setupTestApp();
	});

	// The explicit auditRecord branch is fed by partial updates (the patch body — which replication
	// can deliver contaminated from an affected peer) and by the residency path (the record instance,
	// whose toJSON is the response projection). Neither feed is reachable from a single-node public
	// write (validate rejects a user-supplied computed property), so the branch is driven directly and
	// the payload is captured at the encoder, which the projection runs before; the write is then
	// allowed to fail downstream where it wants a live transaction.
	it('a record-type audit payload is projected; a message payload is not', async () => {
		const { recordUpdater } = await import('#src/resources/RecordEncoder');
		const table = tables.FourProp;
		const encoder = table.primaryStore.encoder;
		const update = recordUpdater(table.primaryStore, table.tableId, table.auditStore);

		const capturedAuditPayload = (id, type, auditRecord) => {
			const encoded = [];
			const realEncode = encoder.encode;
			encoder.encode = function (record, options) {
				encoded.push(record);
				return realEncode.call(this, record, options);
			};
			try {
				update(id, { id, name: 'n', title: 't', age: 1 }, null, Date.now(), -1, true, {}, type, false, auditRecord);
			} catch {
				// the audit write wants a live transaction; everything under test ran before it
			} finally {
				encoder.encode = realEncode;
			}
			return encoded.find((candidate) => candidate && Object.hasOwn(candidate, 'probe'));
		};

		const recordPayload = capturedAuditPayload(`audit-rec-${Date.now()}`, 'put', {
			probe: true,
			name: 'patched',
			nameTitle: 'FORGED',
		});
		assert.ok(recordPayload, 'the record-type audit payload must be encoded');
		assert.strictEqual(recordPayload.name, 'patched');
		assert.ok(!Object.hasOwn(recordPayload, 'nameTitle'), 'resolver-owned keys must be projected out');

		const messagePayload = capturedAuditPayload(`audit-msg-${Date.now()}`, 'message', {
			probe: true,
			body: 'hello',
			nameTitle: 'part of the payload',
		});
		assert.ok(messagePayload, 'the message payload must be encoded');
		assert.strictEqual(
			messagePayload.nameTitle,
			'part of the payload',
			'a published payload must reach subscribers verbatim'
		);
	});
});
