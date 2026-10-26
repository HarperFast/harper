const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { INVALIDATED } = require('#src/resources/Table');
const { server } = require('#src/server/Server');
const { waitFor } = require('../waitFor.js');

describe('A full put at a stub head’s own identity', function () {
	this.timeout(10000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	function replicatedTable(name) {
		const pending = [];
		let lastMarker = 0;
		let wake;
		const T = table({
			table: name,
			database: `stubHead_${name}`,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
			audit: true,
		});
		T.sourcedFrom(
			{
				subscribeOnThisThread() {
					return true;
				},
				async *subscribe() {
					while (true) {
						while (pending.length) yield pending.shift();
						await new Promise((resolve) => (wake = resolve));
					}
				},
			},
			{ intermediateSource: true }
		);
		const origin = getIdOfRemoteNode('stub-origin', T.auditStore);
		return {
			T,
			origin,
			async apply(...events) {
				const markerKey = (lastMarker = Math.max(Date.now(), lastMarker + 1));
				pending.push(...events, {
					type: 'put',
					id: 'marker',
					value: { id: 'marker', name: String(markerKey) },
					timestamp: markerKey,
					nodeId: origin,
				});
				wake?.();
				await waitFor(async () => (await T.get('marker'))?.name === String(markerKey), {
					timeout: 5000,
					message: 'the batch should apply',
				});
			},
		};
	}

	async function stubbed(name) {
		const state = replicatedTable(name);
		const version = Date.now() - 60000;
		const write = (type, residencyList, extra) => ({
			type,
			id: 'r',
			value: type === 'invalidate' ? { id: 'r', name: 'indexed' } : { id: 'r', name: 'indexed', body: 'complete' },
			timestamp: version,
			version,
			nodeId: state.origin,
			residencyList,
			...extra,
		});
		await state.apply(write('invalidate', ['other-resident']));
		const entry = state.T.primaryStore.getEntry('r');
		assert.ok(entry.metadataFlags & INVALIDATED, 'the setup leaves a stub');
		assert.equal(entry.value.body, undefined);
		const puts = async () => (await state.T.getHistoryOfRecord('r')).filter((audit) => audit.type === 'put').length;
		return { ...state, version, write, puts };
	}

	it('replaces the stub with the put and logs it', async function () {
		const { T, apply, write, puts } = await stubbed('Upgrade');
		await apply(write('put', [server.hostname]));
		const entry = T.primaryStore.getEntry('r');
		assert.equal(entry.metadataFlags & INVALIDATED, 0, 'the record is complete');
		assert.equal(entry.value.body, 'complete');
		assert.equal(await puts(), 1, 'the put is logged');

		await apply(write('put', [server.hostname]));
		assert.equal(await puts(), 1, 'a re-delivery of the put is still a duplicate');
	});

	it('applies the rest of a re-delivered transaction after the upgraded put', async function () {
		const { T, apply, origin, version } = await stubbed('UpgradeThenPatch');
		await apply({
			type: 'transaction',
			timestamp: version,
			writes: [
				{
					type: 'put',
					id: 'r',
					value: { id: 'r', name: 'indexed', body: 'complete' },
					nodeId: origin,
					version,
					residencyList: [server.hostname],
				},
				{
					type: 'patch',
					id: 'r',
					value: { body: 'patched' },
					nodeId: origin,
					version,
					residencyList: [server.hostname],
				},
			],
		});
		const entry = T.primaryStore.getEntry('r');
		assert.equal(entry.metadataFlags & INVALIDATED, 0);
		assert.equal(entry.value.body, 'patched');
	});

	it('keeps the stub when the put would store only a stub here', async function () {
		const { T, apply, puts } = await stubbed('NonResident');
		const version = T.primaryStore.getEntry('r').version;
		const origin = T.primaryStore.getEntry('r').nodeId;
		// no residency list: the table's residency function decides, and it excludes this node
		T.setResidency(() => ['other-resident']);
		try {
			await apply({
				type: 'put',
				id: 'r',
				value: { id: 'r', name: 'indexed', body: 'complete' },
				timestamp: version,
				version,
				nodeId: origin,
			});
		} finally {
			T.setResidency(undefined);
		}
		const entry = T.primaryStore.getEntry('r');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.equal(entry.value.body, undefined);
		assert.equal(await puts(), 0, 'nothing is logged for a skipped duplicate');
	});

	// harper-pro's base copy sends a stub as an ordinary put to a peer whose capabilities it has not
	// learned, relying on an equal-version holder skipping it (replication/DESIGN.md, residencyStubCopy).
	it('keeps the stub for a copy-applied put, which can carry a stub projection', async function () {
		const { T, apply, write } = await stubbed('CopyApply');
		await apply(write('put', undefined, { value: { id: 'r', name: 'indexed' }, isCopyApply: true }));
		const entry = T.primaryStore.getEntry('r');
		assert.ok(entry.metadataFlags & INVALIDATED, 'the projection is not stored as a complete record');
	});

	it('still skips a re-delivered put onto the complete record it wrote', async function () {
		const { T, apply, origin } = replicatedTable('FullDuplicate');
		const version = Date.now() - 60000;
		const put = {
			type: 'put',
			id: 'r',
			value: { id: 'r', name: 'indexed', body: 'complete' },
			timestamp: version,
			version,
			nodeId: origin,
		};
		await apply(put);
		const history = (await T.getHistoryOfRecord('r')).length;
		await apply({ ...put, value: { id: 'r', name: 'indexed', body: 'changed' } });
		assert.equal((await T.getHistoryOfRecord('r')).length, history, 'the duplicate is not logged');
		assert.equal((await T.get('r')).body, 'complete');
	});

	it('relocates a new key away from this node on an indexed table', async function () {
		const { T, apply, origin } = replicatedTable('RelocateNew');
		const version = Date.now() - 60000;
		await apply({
			type: 'relocate',
			id: 'r',
			timestamp: version,
			version,
			nodeId: origin,
			residencyList: ['other-resident'],
		});
		const entry = T.primaryStore.getEntry('r');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.equal(entry.value.name, undefined);
	});
});
