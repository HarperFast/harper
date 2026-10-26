require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { INVALIDATED } = require('#src/resources/Table');
const { waitFor } = require('../waitFor.js');

const PEER = 'source-fill-peer';

// Raw index keys for one record, so an orphaned or missing entry cannot hide behind query hydration.
function indexedKeys(Table, attribute, id) {
	return Array.from(Table.indices[attribute].getRange({}))
		.filter(({ value }) => value === id)
		.map(({ key }) => key);
}

// The first get() resolves before the fill commits; a second get() waits on the fill's lock and is
// served from the stored record, so it only reaches the source again if the fill did not commit.
async function settledFill(Table, id, calls) {
	await Table.get(id);
	const before = calls.length;
	await Table.get(id);
	assert.equal(calls.length, before, `the fill of ${id} did not commit, so the next read went to the source again`);
	return Table.primaryStore.getEntry(id);
}

describe('Source fills', function () {
	this.timeout(10_000);
	let Stamped, Placed, Computed, calls, names;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Stamped = table({
			database: 'test',
			table: 'SourceFillStamped',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'createdAt', type: 'Float', assignCreatedTime: true, indexed: true },
				{ name: 'updatedAt', type: 'Float', assignUpdatedTime: true, indexed: true },
			],
		});
		Placed = table({
			database: 'test',
			table: 'SourceFillPlaced',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
			audit: true,
		});
		Computed = table({
			database: 'test',
			table: 'SourceFillComputed',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'sku', indexed: true },
				{ name: 'name' },
				{ name: 'upper', indexed: true, computed: true },
			],
		});
		// `name` is not indexed, so no stub carries the resolver's input
		Computed.setComputedAttribute('upper', (record) => record.name.toUpperCase());
		for (const Table of [Stamped, Placed, Computed]) {
			Table.sourcedFrom({
				get(id) {
					calls.push(id);
					if (names.get(id) === null) return undefined;
					return { id, sku: 'A', name: names.get(id) ?? 'from source', body: 'complete' };
				},
			});
		}
	});

	beforeEach(() => {
		calls = [];
		names = new Map();
	});
	afterEach(() => {
		Placed.setResidency(undefined);
		Placed.setResidencyById(undefined);
	});

	describe('@createdTime and @updatedTime', () => {
		it('a first fill indexes both timestamps of the stored record, once', async () => {
			const stored = (await settledFill(Stamped, 'first', calls)).value;
			assert.equal(typeof stored.createdAt, 'number');
			assert.deepEqual(indexedKeys(Stamped, 'createdAt', 'first'), [stored.createdAt]);
			assert.deepEqual(indexedKeys(Stamped, 'updatedAt', 'first'), [stored.updatedAt]);
		});

		for (const [label, stale] of [
			['an invalidated record', (id) => Stamped.invalidate(id)],
			[
				'an expired record',
				async (id) => {
					await Stamped.put(id, { id, name: 'local' }, { expiresAt: Date.now() + 20 });
					await waitFor(() => Stamped.primaryStore.getEntry(id).expiresAt < Date.now());
				},
			],
		]) {
			it(`revalidating ${label} keeps one entry per timestamp index, at the stored values`, async () => {
				const id = `revalidated-${label.split(' ')[1]}`;
				await Stamped.put(id, { id, name: 'local' });
				const original = Stamped.primaryStore.getEntry(id).value;
				await stale(id);
				const stored = (await settledFill(Stamped, id, calls)).value;
				assert.equal(stored.name, 'from source');
				assert.equal(stored.createdAt, original.createdAt, 'a refill keeps the created time');
				assert.ok(stored.updatedAt > original.updatedAt);
				assert.deepEqual(indexedKeys(Stamped, 'createdAt', id), [stored.createdAt]);
				assert.deepEqual(indexedKeys(Stamped, 'updatedAt', id), [stored.updatedAt]);
			});
		}

		it('a noCacheStore read returns both timestamps without storing the record', async () => {
			const record = await Stamped.get('uncached', { noCacheStore: true });
			assert.equal(record.name, 'from source');
			assert.equal(record.updatedAt, record.getUpdatedTime());
			assert.equal(record.createdAt, record.updatedAt);
			assert.equal(Stamped.primaryStore.getEntry('uncached'), undefined);
		});
	});

	describe('residency', () => {
		it('a fill this node is not resident for by id stores no index entry', async () => {
			Placed.setResidencyById(() => [PEER]);
			await Placed.get('by-id');
			// the fill writes no primary entry, only its audit record; it has committed once it releases the key
			await waitFor(() => !Placed.primaryStore.hasLock('by-id'));
			assert.equal(Placed.primaryStore.getEntry('by-id')?.value ?? undefined, undefined);
			const logged = Array.from(Placed.auditStore.getRange({ start: 1 })).filter(
				(auditRecord) => auditRecord.recordId === 'by-id'
			);
			assert.equal(logged.length, 1, 'premise: the fill committed its audit record');
			assert.deepEqual(indexedKeys(Placed, 'name', 'by-id'), []);
		});

		it('a fill this node is not resident for keeps the key on its stub, so an index-only select is local', async () => {
			Placed.setResidency(() => [PEER]);
			names.set('stubbed', 'stub name');
			await Placed.get('stubbed');
			await waitFor(() => Placed.primaryStore.getEntry('stubbed')?.metadataFlags & INVALIDATED);
			const stub = Placed.primaryStore.getEntry('stubbed').value;
			assert.equal(stub.id, 'stubbed');
			assert.equal(stub.body, undefined);
			const found = [];
			for await (const record of Placed.search({
				conditions: [{ attribute: 'name', value: 'stub name' }],
				select: ['id', 'name'],
			}))
				found.push(record);
			assert.deepEqual(found, [{ id: 'stubbed', name: 'stub name' }]);
			assert.deepEqual(calls, ['stubbed']);
		});
	});

	describe('computed index over a stub', () => {
		async function stub(id) {
			await Computed.put(id, { id, sku: 'A', name: 'old' });
			await Computed.invalidate(id);
			assert.ok(Computed.primaryStore.getEntry(id).metadataFlags & INVALIDATED, 'premise: a stub');
		}

		it('a refill indexes the new computed value', async () => {
			await stub('refilled');
			names.set('refilled', 'new');
			const entry = await settledFill(Computed, 'refilled', calls);
			assert.ok(!(entry.metadataFlags & INVALIDATED));
			assert.equal(entry.value.name, 'new');
			assert.ok(indexedKeys(Computed, 'upper', 'refilled').includes('NEW'));
			assert.deepEqual(indexedKeys(Computed, 'sku', 'refilled'), ['A']);
		});

		it('a source miss deletes the stub', async () => {
			await stub('missing');
			names.set('missing', null);
			assert.equal(await Computed.get('missing'), undefined);
			await waitFor(() => Computed.primaryStore.getEntry('missing')?.value == null, {
				message: 'the source miss did not delete the stub',
			});
			assert.deepEqual(indexedKeys(Computed, 'sku', 'missing'), []);
		});
	});
});
