require('../testUtils');
const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');

// A record past its expiry stays stored until eviction removes it. Until then, a table with no source answers
// as if it were already gone; a caching table may still serve it as stale.
describe('an expired record that has not been evicted yet', () => {
	let tableSeq = 0;
	const PAST = () => Date.now() - 60_000;
	const FUTURE = () => Date.now() + 3_600_000;
	const notCached = { statusCode: 504 };

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	function makeTable() {
		return table({
			table: `OnlyIfCachedExpiry${++tableSeq}`,
			database: 'test',
			expiration: 3600,
			eviction: 3600, // expired but not evictable, so only a read can evict it
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
	}

	async function seed(Table, id, expiresAt) {
		await Table.put(id, { id, name: 'seed' }, { expiresAt });
		await waitFor(() => Table.primaryStore.getEntry(id));
		return Table.primaryStore.getEntry(id).version;
	}

	async function searchIds(Table, query, context) {
		const ids = [];
		for await (const record of Table.search(query, context)) ids.push(record.id);
		return ids.sort();
	}

	describe('on a table with no source', () => {
		let Table;
		let Parent;
		let expiredVersion;
		before(async function () {
			Table = makeTable();
			await seed(Table, 'live', FUTURE());
			expiredVersion = await seed(Table, 'expired', PAST());
			Parent = table({
				table: `OnlyIfCachedExpiryParent${tableSeq}`,
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'childId' },
					{ name: 'child', relationship: { from: 'childId' }, definition: { tableClass: Table } },
				],
			});
			await Parent.put({ id: 'of-expired', childId: 'expired' });
			await Parent.put({ id: 'of-live', childId: 'live' });
		});
		after(() => Table?.closeMaintenance());

		// a 504 that came from evicting the record would pass the status checks too
		function assertStillStored() {
			const entry = Table.primaryStore.getEntry('expired');
			assert.ok(entry?.value, 'an only-if-cached read must not evict');
			assert.equal(entry.version, expiredVersion);
			assert.equal(Table.indices.name.getValuesCount('seed'), 2);
		}

		it('only-if-cached get and getResource answer 504, as they do once the record is evicted', async function () {
			await assert.rejects(async () => Table.get('expired', { onlyIfCached: true }), notCached);
			await assert.rejects(async () => Table.getResource('expired', { onlyIfCached: true }), notCached);
			await assert.rejects(async () => Table.get('never-written', { onlyIfCached: true }), notCached);
			assert.equal((await Table.get('live', { onlyIfCached: true })).name, 'seed');
			assertStillStored();
		});

		it('only-if-cached get answers 504 on the loadAsInstance=false path', async function () {
			class ValueTable extends Table {
				static loadAsInstance = false;
			}
			await assert.rejects(async () => ValueTable.get('expired', { onlyIfCached: true }), notCached);
			assert.equal((await ValueTable.get('live', { onlyIfCached: true })).name, 'seed');
			assertStillStored();
		});

		it('only-if-cached search omits it, by index and by scan', async function () {
			const byIndex = { conditions: [{ attribute: 'name', value: 'seed' }] };
			assert.deepEqual(await searchIds(Table, byIndex, { onlyIfCached: true }), ['live']);
			assert.deepEqual(await searchIds(Table, { select: ['id', 'name'] }, { onlyIfCached: true }), ['live']);
			assert.deepEqual(await searchIds(Table, {}, { onlyIfCached: true }), ['live']);
			// the SQL UPDATE/DELETE row finder still sees it
			const withExpired = { ...byIndex, includeExpired: true };
			assert.deepEqual(await searchIds(Table, withExpired, { onlyIfCached: true }), ['expired', 'live']);
			assertStillStored();
		});

		it('only-if-cached search resolves a relationship to it as missing', async function () {
			const children = {};
			const select = ['id', { name: 'child', select: ['id', 'name'] }];
			for await (const parent of Parent.search({ select }, { onlyIfCached: true })) children[parent.id] = parent.child;
			assert.deepEqual(children['of-live'], { id: 'live', name: 'seed' });
			assert.ok(children['of-expired'] == null, JSON.stringify(children['of-expired']));
			assertStillStored();
		});

		it('ensureLoaded() under only-if-cached answers 504', async function () {
			const context = {};
			const resource = await Table.getResource('expired', context, { ensureLoaded: false });
			context.onlyIfCached = true;
			assert.throws(() => resource.ensureLoaded(), notCached);
		});

		it('an only-if-cached read does not stamp its version or local time on the context', async function () {
			const liveEntry = Table.primaryStore.getEntry('live');
			const context = { onlyIfCached: true };
			await assert.rejects(async () => Table.get('expired', context), notCached);
			assert.equal(context.lastModified, undefined);
			assert.equal(context.lastRefreshed, undefined);
			// the expired record was written after the live one, so it must not raise a shared context's lastModified
			const shared = { onlyIfCached: true };
			await Table.get('live', shared);
			await assert.rejects(async () => Table.get('expired', shared), notCached);
			assert.equal(shared.lastModified, liveEntry.version);
			assert.equal(shared.lastRefreshed, liveEntry.localTime);
			assertStillStored();
		});

		it('a plain get answers absent without stamping the context', async function () {
			const liveVersion = Table.primaryStore.getEntry('live').version;
			const context = {};
			await Table.get('live', context);
			assert.ok((await Table.get('expired', context)) == null);
			assert.equal(context.lastModified, liveVersion);
			const fresh = {};
			await seed(Table, 'expired-2', PAST());
			assert.ok((await Table.get('expired-2', fresh)) == null);
			assert.equal(fresh.lastModified, undefined);
			assert.equal(fresh.lastRefreshed, undefined);
		});

		it('a write over it does not report its version as the context lastModified', async function () {
			for (const write of ['put', 'patch', 'delete']) {
				const id = `expired-${write}`;
				const version = await seed(Table, id, PAST());
				const context = {};
				if (write === 'delete') await Table.delete(id, context);
				else await Table[write](id, { id, name: write }, context);
				assert.notEqual(context.lastModified, version, write);
			}
		});
	});

	describe('on a caching table with a source', () => {
		let Table;
		let sourceRequests = 0;
		before(async function () {
			Table = makeTable();
			Table.sourcedFrom({
				get(id) {
					sourceRequests++;
					return { id, name: 'source' };
				},
			});
			await seed(Table, 'stale', PAST());
		});
		after(() => Table?.closeMaintenance());

		it('only-if-cached get serves the stale record without asking the source', async function () {
			sourceRequests = 0;
			const context = { onlyIfCached: true };
			assert.equal((await Table.get('stale', context)).name, 'seed');
			assert.equal(context.lastModified, Table.primaryStore.getEntry('stale').version);
			class ValueTable extends Table {
				static loadAsInstance = false;
			}
			assert.equal((await ValueTable.get('stale', { onlyIfCached: true })).name, 'seed');
			assert.equal(sourceRequests, 0);
		});
	});
});
