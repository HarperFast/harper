require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { ServerError } = require('#src/utility/errors/hdbError');
const { INVALIDATED } = require('#src/resources/Table');
const { server } = require('#src/server/Server');

describe('Reads of residency stubs', function () {
	this.timeout(10_000);
	let Records, response, calls;
	const unavailable = new ServerError('residency test: no resident is reachable', 502);

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Records = table({
			database: 'test',
			table: 'ResidencyReads',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String', indexed: true },
				{ name: 'body', type: 'String' },
			],
			audit: true,
		});
		Records.sourcedFrom(
			class extends Resource {
				static async load(entry) {
					calls.push(entry.key);
					if (response instanceof Error) throw response;
					return response;
				}
			},
			{ intermediateSource: true }
		);
	});

	beforeEach(async () => {
		response = unavailable;
		calls = [];
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('record', context, { ensureLoaded: false });
			resource._writeInvalidate('record', Object.freeze({ name: 'indexed' }), { residencyId: 123 });
		});
		const entry = Records.primaryStore.getEntry('record');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.equal(entry.value.body, undefined);
	});

	async function query(select, conditions = []) {
		const records = [];
		for await (const record of Records.search({ conditions, select })) records.push(record);
		return records;
	}

	it('propagates the original source error from a single-record read', async () => {
		await assert.rejects(Records.get('record'), (error) => error === unavailable);
		assert.deepEqual(calls, ['record']);
	});

	for (const [label, conditions] of [
		['a scan', []],
		['an indexed query', [{ attribute: 'name', value: 'indexed' }]],
	]) {
		it(`propagates the source error from ${label} selecting non-indexed fields`, async () => {
			await assert.rejects(query(['id', 'body'], conditions), (error) => error === unavailable);
			assert.deepEqual(calls, ['record']);
		});

		it(`loads the complete record for ${label}`, async () => {
			response = { key: 'record', value: { id: 'record', name: 'indexed', body: 'complete' }, metadataFlags: 0 };
			assert.deepEqual(await query(['id', 'body'], conditions), [{ id: 'record', body: 'complete' }]);
			assert.deepEqual(calls, ['record']);
		});
	}

	it('keeps successful absence distinct from a source failure', async () => {
		response = undefined;
		assert.equal(await Records.get('record'), undefined);
		assert.deepEqual(await query(['id', 'body']), []);
		assert.deepEqual(calls, ['record', 'record']);
	});

	it('uses indexed-only projections without contacting a resident', async () => {
		assert.deepEqual(await query(['id', 'name']), [{ id: 'record', name: 'indexed' }]);
		assert.deepEqual(calls, []);
	});

	it('replaces indexed values when an existing stub is invalidated again', async () => {
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('record', context, { ensureLoaded: false });
			resource._writeInvalidate('record', { id: 'record', name: 'changed' }, { residencyId: 123 });
		});
		assert.deepEqual(await query(['id'], [{ attribute: 'name', value: 'indexed' }]), []);
		assert.deepEqual(await query(['id'], [{ attribute: 'name', value: 'changed' }]), [{ id: 'record' }]);
		assert.deepEqual(calls, []);
	});

	it('removes an omitted indexed value from a received residency stub', async () => {
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('record', context, { ensureLoaded: false });
			resource._writeInvalidate('record', Object.freeze({ name: undefined }), { residencyId: 123 });
		});
		assert.deepEqual(await query(['id'], [{ attribute: 'name', value: 'indexed' }]), []);
		assert.equal(Records.primaryStore.getEntry('record').value.name, undefined);
		assert.equal(Records.primaryStore.getEntry('record').value.id, 'record');
	});

	for (const [label, residents, newer, shouldInvalidate] of [
		['an equal-version copy addressed to a resident', 'self', false, false],
		['a newer invalidation', 'self', true, true],
		['a demotion to a non-resident', 'remote', false, true],
		['an ordinary cache invalidation', undefined, false, true],
	]) {
		it(`preserves the correct full/stub state for ${label}`, async () => {
			const id = 'copy-target';
			await Records.put(id, { id, name: 'indexed', body: 'complete' });
			const before = Records.primaryStore.getEntry(id);
			const residencyId = residents ? 456 : undefined;
			if (residents)
				Records.dbisDB.putSync(
					[Symbol.for('residency_by_id'), residencyId],
					[residents === 'self' ? server.hostname : 'other-resident']
				);
			const context = { sourceApply: true, timestamp: before.version + (newer ? 1 : 0) };
			await transaction(context, async () => {
				const resource = await Records.getResource(id, context, { ensureLoaded: false });
				resource._writeInvalidate(
					id,
					{ id, name: 'indexed' },
					{ version: before.version + (newer ? 1 : 0), nodeId: before.nodeId ?? 0, residencyId }
				);
			});
			const after = Records.primaryStore.getEntry(id);
			assert.equal(Boolean(after.metadataFlags & INVALIDATED), shouldInvalidate);
			assert.equal(after.value.body, shouldInvalidate ? undefined : 'complete');
		});
	}
});
