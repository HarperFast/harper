const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { INVALIDATED } = require('#src/resources/Table');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { waitFor } = require('../waitFor');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

let nextTimestamp = Date.now() + 1_000_000;

const writes = {
	put50: (T, id, base) =>
		T.put(
			id,
			{ indexedTag: 'tag-50', secretBody: 'body-50', extra: 'stale-50', counter: 10 },
			{ timestamp: base + 50 }
		),
	patch120: (T, id, base) =>
		T.patch(id, { indexedTag: 'tag-120', counter: { __op__: 'add', value: 5 } }, { timestamp: base + 120 }),
	invalidate150: (T, id, base) => T.invalidate(id, { timestamp: base + 150 }),
	patch200: (T, id, base) =>
		T.patch(id, { indexedTag: 'tag-200', counter: { __op__: 'add', value: 5 } }, { timestamp: base + 200 }),
};

const arms = [
	{ name: 'no patch (control)', before: ['put50', 'invalidate150'], headVersion: 150, headTag: 'tag-50' },
	{
		name: 'a patch before the invalidation',
		before: ['put50', 'patch120', 'invalidate150'],
		headVersion: 150,
		headTag: 'tag-120',
	},
	{
		name: 'a patch after the invalidation',
		before: ['put50', 'invalidate150', 'patch200'],
		headVersion: 200,
		headTag: 'tag-200',
	},
	{
		name: 'patches on both sides of the invalidation',
		before: ['put50', 'patch120', 'invalidate150', 'patch200'],
		headVersion: 200,
		headTag: 'tag-200',
	},
];

describe('Out-of-order full PUT against an invalidated head', () => {
	let T;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'InvalidatedHead',
			database: 'outOfOrderInvalidatedHead',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'indexedTag', type: 'String', indexed: true },
				{ name: 'secretBody', type: 'String' },
				{ name: 'extra', type: 'String' },
				{ name: 'counter', type: 'Int' },
			],
		});
	});

	for (const { name, before: staged, headVersion, headTag } of arms) {
		it(`keeps the stub with ${name}`, async () => {
			const base = (nextTimestamp += 10_000);
			const id = `inv-${staged.join('-')}`;
			for (const step of staged) await writes[step](T, id, base);

			let entry = T.primaryStore.getEntry(id);
			assert.notStrictEqual(entry.metadataFlags & INVALIDATED, 0, 'the head is invalidated before the older PUT');
			assert.strictEqual(entry.value.secretBody, undefined);

			await T.put(
				id,
				{ indexedTag: 'tag-100', secretBody: 'resurrected-body-100', extra: 'extra-100', counter: 100 },
				{ timestamp: base + 100 }
			);

			entry = T.primaryStore.getEntry(id);
			assert.notStrictEqual(entry.metadataFlags & INVALIDATED, 0, 'an older PUT must not clear INVALIDATED');
			assert.deepStrictEqual({ ...entry.value }, { id, indexedTag: headTag });
			assert.strictEqual(entry.version, base + headVersion, 'the head version is not rewound');
			const found = [];
			for await (const record of T.search({
				conditions: [{ attribute: 'indexedTag', comparator: 'equals', value: 'tag-100' }],
			}))
				found.push(record.id);
			assert.deepStrictEqual(found, [], "the older PUT's indexed value is not added to the stub's index");
		});
	}

	it('replaces a stub that an older invalidation produced', async () => {
		const base = (nextTimestamp += 10_000);
		const id = 'inv-older-than-put';
		await T.put(id, { indexedTag: 'tag-20', secretBody: 'body-20', counter: 1 }, { timestamp: base + 20 });
		await T.invalidate(id, { timestamp: base + 50 });
		await writes.patch200(T, id, base);
		assert.notStrictEqual(T.primaryStore.getEntry(id).metadataFlags & INVALIDATED, 0);

		await T.put(id, { indexedTag: 'tag-100', secretBody: 'body-100', counter: 100 }, { timestamp: base + 100 });

		const entry = T.primaryStore.getEntry(id);
		assert.strictEqual(entry.metadataFlags & INVALIDATED, 0, 'the PUT is newer than the invalidation');
		assert.deepStrictEqual({ ...entry.value }, { id, indexedTag: 'tag-200', secretBody: 'body-100', counter: 105 });
	});

	it('keeps a PUT that is newer than an invalidation the audit walk cannot reach', async function () {
		if (isLMDB) return this.skip();
		const base = (nextTimestamp += 100_000);
		nextTimestamp += 2000;
		const id = 'inv-capped';
		await T.put(id, { indexedTag: 'tag-20', secretBody: 'body-20' }, { timestamp: base + 20 });
		await T.invalidate(id, { timestamp: base + 50 });
		for (let i = 1; i <= 1010; i++) await T.patch(id, { indexedTag: `tag-${i}` }, { timestamp: base + 200 + i });

		await T.put(id, { indexedTag: 'tag-100', secretBody: 'body-100' }, { timestamp: base + 100 });

		assert.strictEqual(T.primaryStore.getEntry(id).value.secretBody, 'body-100');
	});

	for (const order of [
		['patch', 'invalidate'],
		['invalidate', 'patch'],
	]) {
		it(`keeps the stub when the invalidation shares a transaction with a patch (${order.join(' then ')})`, async () => {
			const base = (nextTimestamp += 10_000);
			const id = `inv-frame-${order.join('-')}`;
			await writes.put50(T, id, base);
			const context = { timestamp: base + 150 };
			await transaction(context, async () => {
				for (const step of order) {
					if (step === 'patch')
						await T.patch(id, { indexedTag: 'tag-150', counter: { __op__: 'add', value: 5 } }, context);
					else await T.invalidate(id, context);
				}
			});
			assert.notStrictEqual(T.primaryStore.getEntry(id).metadataFlags & INVALIDATED, 0);

			await T.put(id, { indexedTag: 'tag-100', secretBody: 'resurrected-body-100' }, { timestamp: base + 100 });

			const entry = T.primaryStore.getEntry(id);
			assert.notStrictEqual(entry.metadataFlags & INVALIDATED, 0);
			assert.strictEqual(entry.value.secretBody, undefined);
		});
	}

	it('keeps the stub when a replicated invalidation and patch outrank a late replicated PUT', async () => {
		const base = (nextTimestamp += 10_000);
		const id = 'inv-replicated';
		const newer = getIdOfRemoteNode('invalidated-head-newer-origin', T.auditStore);
		const older = getIdOfRemoteNode('invalidated-head-older-origin', T.auditStore);
		const apply = (write, version, nodeId, value) => {
			const context = { source: {}, sourceApply: true, timestamp: version };
			return transaction(context, async () => {
				const resource = await T.getResource(id, context);
				await write(resource, value, { isNotification: true, nodeId, version });
			});
		};
		const put = (resource, value, options) => resource._writeUpdate(id, value, true, options);
		await apply(put, base + 50, newer, { id, indexedTag: 'tag-50', secretBody: 'body-50' });
		await apply((resource, value, options) => resource._writeUpdate(id, value, false, options), base + 120, newer, {
			indexedTag: 'tag-120',
		});
		await apply((resource, value, options) => resource._writeInvalidate(id, value, options), base + 150, newer, {
			id,
			indexedTag: 'tag-150',
		});
		await apply(put, base + 100, older, { id, indexedTag: 'tag-100', secretBody: 'resurrected-body-100' });

		const entry = T.primaryStore.getEntry(id);
		assert.notStrictEqual(entry.metadataFlags & INVALIDATED, 0);
		assert.deepStrictEqual({ ...entry.value }, { id, indexedTag: 'tag-150' });
	});

	it('keeps the stub when source frames deliver the PUT after the invalidation and a later patch', async () => {
		const Dispatched = table({
			table: 'InvalidatedHeadDispatched',
			database: 'outOfOrderInvalidatedHead',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'indexedTag', type: 'String', indexed: true },
				{ name: 'secretBody', type: 'String' },
			],
		});
		const id = 'dispatched';
		const base = Date.now() + 86400000;
		const origin = getIdOfRemoteNode('invalidated-head-dispatch-origin', Dispatched.auditStore);
		const frame = (version, type, value, key = id) => ({
			type: 'transaction',
			timestamp: version,
			writes: [{ type, id: key, value, nodeId: origin, version }],
		});
		let release;
		const held = new Promise((resolve) => (release = resolve));
		Dispatched.sourcedFrom(
			{
				subscribeOnThisThread: () => true,
				async *subscribe() {
					yield frame(base + 50, 'put', { id, indexedTag: 'tag-50', secretBody: 'body-50' });
					yield frame(base + 150, 'invalidate', { id, indexedTag: 'tag-150' });
					yield frame(base + 200, 'patch', { indexedTag: 'tag-200' });
					yield frame(base + 100, 'put', { id, indexedTag: 'tag-100', secretBody: 'resurrected-body-100' });
					yield frame(base + 300, 'put', { id: 'marker', indexedTag: 'marker' }, 'marker');
					await held;
				},
			},
			{ intermediateSource: true }
		);
		try {
			await waitFor(() => Dispatched.primaryStore.getEntry('marker')?.value, {
				timeout: 5000,
				message: 'the frames should apply',
			});
			const entry = Dispatched.primaryStore.getEntry(id);
			assert.notStrictEqual(entry.metadataFlags & INVALIDATED, 0);
			assert.deepStrictEqual({ ...entry.value }, { id, indexedTag: 'tag-200' });
		} finally {
			release();
		}
	});
});
