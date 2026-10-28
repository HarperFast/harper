require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, database, databases } = require('#src/resources/databases');
const { replayLogs } = require('#src/resources/replayLogs');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { FULL_WRITE_HEAD, fullWriteHeadKey } = require('#src/resources/Table');
const { raiseAuditFloor, getAuditFloor, COPIED_RECORD } = require('#src/resources/auditStore');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { server } = require('#src/server/Server');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const DAY = 86400 * 1000;
const AUDIT_FLOOR_KEY = Symbol.for('audit-floor');
const RESIDENT_HERE = 7;

describe('A record bit for a full-write head (harper#3532)', () => {
	let tables = 0;
	let ids = 0;
	let T, headOrigin, lateOrigin;

	// The floor is database-scoped, so a test that moves it gets its own database.
	function auditedTable(audit = true) {
		const name = `FullWriteHead${++tables}`;
		const created = table({
			table: name,
			database: `fullWriteHead_${name}`,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }, { name: 'extra' }],
			audit,
		});
		created.dbisDB.putSync([Symbol.for('residency_by_id'), RESIDENT_HERE], [server.hostname]);
		return created;
	}

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = auditedTable();
		headOrigin = getIdOfRemoteNode('full-write-head-a', T.auditStore);
		lateOrigin = getIdOfRemoteNode('full-write-head-b', T.auditStore);
	});

	const newId = () => `key-${++ids}`;
	const flagged = (Table, id) => Boolean(Table.primaryStore.getEntry(id)?.metadataFlags & FULL_WRITE_HEAD);

	function fromOrigin(Table, id, write, { version, logKey = version }) {
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => write(await Table.getResource(id, context, { ensureLoaded: false })));
	}
	const apply = (Table, id, record, { version, nodeId = headOrigin, fullUpdate = false, logKey = version }) =>
		fromOrigin(
			Table,
			id,
			(resource) => resource._writeUpdate(id, record, fullUpdate, { isNotification: true, nodeId, version }),
			{ version, logKey }
		);
	const remove = (Table, id, { version, nodeId = headOrigin }) =>
		fromOrigin(Table, id, (resource) => resource._writeDelete(id, { version, nodeId }), { version });

	// Audit lookups are entry reads on the audit store; the floor is a metadata key, read with getBinary.
	async function lookupsDuring(Table, run) {
		const counts = { lookups: 0, metadataReads: 0 };
		const auditStore = Table.auditStore;
		const originals = {};
		for (const method of ['get', 'getSync', 'getRange', 'getBinary']) {
			originals[method] = auditStore[method];
			auditStore[method] = function (...args) {
				if (method === 'getBinary') counts.metadataReads++;
				else counts.lookups++;
				return originals[method].apply(this, args);
			};
		}
		try {
			await run();
		} finally {
			Object.assign(auditStore, originals);
		}
		return counts;
	}

	it('is set only by an in-order put or delete, on RocksDB', async () => {
		const id = newId();
		const version = Date.now() + DAY;
		await apply(T, id, { id, name: 'put' }, { version, fullUpdate: true });
		assert.equal(flagged(T, id), !isLMDB, 'an in-order put');
		if (isLMDB) return;
		await apply(T, id, { name: 'patched' }, { version: version + 1 });
		assert.equal(flagged(T, id), false, 'an in-order patch');
		await apply(T, id, { id, name: 'put again' }, { version: version + 2, fullUpdate: true });
		assert.equal(flagged(T, id), true);
		await fromOrigin(
			T,
			id,
			(resource) => {
				resource._writeUpdate(id, { id, name: 'put' }, true, {
					isNotification: true,
					nodeId: headOrigin,
					version: version + 3,
				});
				resource._writeUpdate(id, { extra: 1 }, false, {
					isNotification: true,
					nodeId: headOrigin,
					version: version + 3,
				});
			},
			{ version: version + 3 }
		);
		assert.equal(flagged(T, id), false, 'a transaction whose last write to the key is a patch');
		await fromOrigin(
			T,
			id,
			(resource) => {
				resource._writeUpdate(id, { extra: 2 }, false, {
					isNotification: true,
					nodeId: headOrigin,
					version: version + 4,
				});
				resource._writeUpdate(id, { id, name: 'put' }, true, {
					isNotification: true,
					nodeId: headOrigin,
					version: version + 4,
				});
			},
			{ version: version + 4 }
		);
		assert.equal(flagged(T, id), true, 'a transaction whose last write to the key is a put');
		await remove(T, id, { version: version + 5 });
		assert.equal(T.primaryStore.getEntry(id).value, null);
		assert.equal(flagged(T, id), true, 'a delete leaves a flagged tombstone');
	});

	it('is cleared by an invalidation, a relocation, a published message and a copied row', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + DAY;
		const flaggedPut = async () => {
			const id = newId();
			await apply(T, id, { id, name: 'put' }, { version, fullUpdate: true });
			assert.ok(flagged(T, id), 'premise: a flagged put');
			return id;
		};
		let id = await flaggedPut();
		await fromOrigin(
			T,
			id,
			(resource) => resource._writeInvalidate(id, { name: 'stub' }, { version: version + 1, nodeId: headOrigin }),
			{
				version: version + 1,
			}
		);
		assert.equal(flagged(T, id), false, 'invalidate');
		id = await flaggedPut();
		await fromOrigin(
			T,
			id,
			(resource) =>
				resource._writeRelocate(id, { version: version + 1, nodeId: headOrigin, residencyId: RESIDENT_HERE }),
			{ version: version + 1 }
		);
		assert.equal(T.primaryStore.getEntry(id).value.name, 'put', 'premise: the body stays');
		assert.equal(flagged(T, id), false, 'relocate moves the version without a full write');
		id = await flaggedPut();
		await T.publish(id, { message: 'hello' });
		assert.equal(T.primaryStore.getEntry(id).value.name, 'put', 'premise: the body stays');
		assert.equal(flagged(T, id), false, 'publish moves the version without a full write');
		id = newId();
		await fromOrigin(
			T,
			id,
			(resource) =>
				resource._writeUpdate(id, { id, name: 'copied' }, true, { isCopyApply: true, nodeId: headOrigin, version }),
			{ version }
		);
		assert.equal(T.primaryStore.getEntry(id).value.name, 'copied');
		assert.equal(flagged(T, id), false, 'a copied row does not carry its source’s kind');
		// a copy frame past the replay boundary applies as an audited put, still of a copied body
		id = newId();
		await fromOrigin(
			T,
			id,
			(resource) =>
				resource._writeUpdate(id, { id, name: 'copied' }, true, {
					isNotification: true,
					copyFrame: true,
					nodeId: headOrigin,
					version,
				}),
			{ version }
		);
		assert.equal(T.primaryStore.getEntry(id).value.name, 'copied');
		assert.equal(flagged(T, id), false, 'a copy frame applied as a put is not certified');
	});

	it('reports the head write’s log key, never another write’s at the same version', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + DAY;
		const headKey = (id) => {
			const entry = T.primaryStore.getEntry(id);
			return fullWriteHeadKey(entry.metadataFlags, entry);
		};
		let id = newId();
		await apply(T, id, { id, name: 'put' }, { version, fullUpdate: true });
		assert.equal(headKey(id), version, 'a log key equal to the version');
		id = newId();
		await apply(T, id, { id, name: 'put' }, { version, logKey: version - 10, fullUpdate: true });
		assert.equal(headKey(id), version - 10, 'a diverged log key');
		// the same writer and version under a later log key: this put is the head now
		await apply(T, id, { id, name: 'tied put' }, { version, logKey: version, fullUpdate: true });
		assert.equal(T.primaryStore.getEntry(id).value.name, 'tied put');
		assert.equal(headKey(id), undefined, 'a tie that inherits the earlier head’s ref is not certified');
		await apply(T, id, { name: 'patched' }, { version: version + 1 });
		assert.equal(headKey(id), undefined, 'a patch head');
	});

	describe('a copy frame past the replay boundary (harper#3703)', () => {
		// applied as an audited put of the source row's body, as a follower or a relay's next hop applies it
		const copiedPut = (Table, id, record, { version, nodeId }) =>
			fromOrigin(
				Table,
				id,
				(resource) =>
					resource._writeUpdate(id, record, true, { isNotification: true, copyFrame: true, nodeId, version }),
				{ version }
			);

		it('logs the copy, so a relay forwards it as one', async function () {
			if (isLMDB) return this.skip();
			const id = newId();
			const version = Date.now() + DAY;
			await copiedPut(T, id, { id, name: 'copied' }, { version, nodeId: headOrigin });
			assert.equal(flagged(T, id), false);
			const logged = T.auditStore.getSync(version, T.tableId, id, headOrigin);
			assert.equal(logged?.type, 'put');
			assert.ok(logged.extendedType & COPIED_RECORD, 'the entry relays carry and receivers map back to copyFrame');
		});

		it('still supersedes a later older write, which the post-copy replay re-delivers from the body', async function () {
			if (isLMDB) return this.skip();
			const id = newId();
			const version = Date.now() + DAY;
			await copiedPut(T, id, { id, name: 'copied', count: 5 }, { version, nodeId: headOrigin });
			await apply(T, id, { count: { __op__: 'add', value: 1 } }, { version: version - 1000, nodeId: lateOrigin });
			const entry = T.primaryStore.getEntry(id);
			assert.equal(entry.value.count, 5, 'an increment the copied body already holds is not applied twice');
			assert.equal(entry.version, version);
		});

		it('takes copyFrame from a replicated event', async function () {
			if (isLMDB) return this.skip();
			let release;
			const held = new Promise((resolve) => (release = resolve));
			const version = Date.now() + DAY;
			const Replicated = table({
				table: 'CopyFrameEvents',
				database: 'fullWriteHeadCopyFrameEvents',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			Replicated.sourcedFrom(
				{
					subscribeOnThisThread() {
						return true;
					},
					async *subscribe() {
						yield {
							type: 'put',
							id: 'copied',
							value: { id: 'copied', name: 'copied' },
							timestamp: version,
							version,
							copyFrame: true,
						};
						yield {
							type: 'put',
							id: 'put',
							value: { id: 'put', name: 'put' },
							timestamp: version + 1,
							version: version + 1,
						};
						await held;
					},
				},
				{ intermediateSource: true }
			);
			try {
				const deadline = Date.now() + 5000;
				while (!Replicated.primaryStore.getEntry('put') && Date.now() < deadline)
					await new Promise((r) => setTimeout(r, 20));
				assert.ok(flagged(Replicated, 'put'), 'premise: a replicated put is certified');
				assert.equal(Replicated.primaryStore.getEntry('copied')?.value?.name, 'copied');
				assert.equal(flagged(Replicated, 'copied'), false);
			} finally {
				release();
			}
		});

		it('replays a copied put after a crash without certifying it', async function () {
			if (isLMDB) return this.skip();
			const Replayed = table({
				table: 'CopiedReplay',
				database: 'fullWriteHeadCopiedReplay',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			const origin = getIdOfRemoteNode('full-write-head-a', Replayed.auditStore);
			const version = Date.now() + DAY;
			await copiedPut(Replayed, 'copied', { id: 'copied', name: 'copied' }, { version, nodeId: origin });
			// what a crash between the log append and the row's flush leaves: the entry, and no row
			Replayed.primaryStore.removeSync('copied');
			await replayLogs(
				database({ database: 'fullWriteHeadCopiedReplay', table: undefined }),
				databases.fullWriteHeadCopiedReplay,
				true
			);
			const entry = Replayed.primaryStore.getEntry('copied');
			assert.equal(entry?.value?.name, 'copied', 'premise: the replay re-applied the copied put');
			assert.equal(Boolean(entry.metadataFlags & FULL_WRITE_HEAD), false);
		});
	});

	it('is never set on a table without audit', async function () {
		if (isLMDB) return this.skip();
		const Unaudited = auditedTable(false);
		await Unaudited.put('plain', { name: 'put' });
		assert.equal(flagged(Unaudited, 'plain'), false);
	});

	for (const head of ['put', 'delete'])
		for (const late of ['put', 'patch', 'add'])
			it(`skips an older ${late} against a ${head} head with no audit lookup`, async function () {
				if (isLMDB) return this.skip();
				const id = newId();
				const version = Date.now() + DAY;
				await apply(T, id, { id, name: 'head', count: 5 }, { version, fullUpdate: true });
				if (head === 'delete') await remove(T, id, { version: version + 1 });
				const before = T.primaryStore.getEntry(id);
				assert.ok(before.metadataFlags & FULL_WRITE_HEAD, 'premise: a flagged head');
				const record = {
					put: { id, name: 'late', count: 1 },
					patch: { name: 'late' },
					add: { count: { __op__: 'add', value: 1 } },
				}[late];
				const counts = await lookupsDuring(T, () =>
					apply(T, id, record, { version: version - 1000, nodeId: lateOrigin, fullUpdate: late === 'put' })
				);
				assert.equal(counts.lookups, 0, 'no audit entry is read for a write the head supersedes');
				assert.ok(counts.metadataReads <= 1, `at most the floor is read; got ${counts.metadataReads}`);
				const after = T.primaryStore.getEntry(id);
				assert.deepEqual(after.value, before.value);
				assert.equal(after.version, before.version);
				assert.ok(after.metadataFlags & FULL_WRITE_HEAD);
			});

	it('keeps the walk for a write at the head’s own version, and for a patch head', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + DAY;
		let id = newId();
		await apply(T, id, { id, name: 'head' }, { version, fullUpdate: true, logKey: version + 10 });
		// the same writer and version, an earlier log key: a distinct write ordered by key, not by version
		let counts = await lookupsDuring(T, () => apply(T, id, { name: 'same version' }, { version, logKey: version + 5 }));
		assert.ok(counts.lookups > 0, 'a tie keeps the audit path');
		assert.equal(T.primaryStore.getEntry(id).value.name, 'head');

		id = newId();
		await apply(T, id, { id, name: 'head' }, { version, fullUpdate: true });
		await apply(T, id, { count: 1 }, { version: version + 2000 });
		counts = await lookupsDuring(T, () =>
			apply(T, id, { extra: 'late' }, { version: version + 1000, nodeId: lateOrigin })
		);
		assert.ok(counts.lookups > 0, 'a patch head keeps the walk');
		assert.equal(
			T.primaryStore.getEntry(id).value.extra,
			'late',
			'and its outcome: the older field is not overwritten'
		);
	});

	it('keeps the below-floor fold, which clears the bit', async function () {
		if (isLMDB) return this.skip();
		const Floor = auditedTable();
		const origin = getIdOfRemoteNode('full-write-head-a', Floor.auditStore);
		const version = Date.now() + DAY;
		await apply(Floor, 'op', { id: 'op', name: 'head', count: 5 }, { version, nodeId: origin, fullUpdate: true });
		assert.ok(flagged(Floor, 'op'), 'premise: a flagged put');
		raiseAuditFloor(Floor.auditStore, Date.now());
		await apply(
			Floor,
			'op',
			{ count: { __op__: 'add', value: 1 } },
			{ version: Date.now() - 30 * DAY, nodeId: getIdOfRemoteNode('full-write-head-b', Floor.auditStore) }
		);
		const entry = Floor.primaryStore.getEntry('op');
		assert.equal(entry.value.count, 6, 'below the floor the commutative op still folds');
		assert.equal(entry.version, version);
		assert.equal(
			Boolean(entry.metadataFlags & FULL_WRITE_HEAD),
			false,
			'the fold changed the body at the head’s version'
		);
	});

	it('keeps the walk when the head’s own log entry is older than the floor, or the floor is unknown', async function () {
		if (isLMDB) return this.skip();
		const Floor = auditedTable();
		const origin = getIdOfRemoteNode('full-write-head-a', Floor.auditStore);
		const late = getIdOfRemoteNode('full-write-head-b', Floor.auditStore);
		const now = Date.now();
		// the put's log key sits below its record version (diverged clocks), so the floor can pass it alone
		await apply(
			Floor,
			'diverged',
			{ id: 'diverged', name: 'head' },
			{ version: now + 10 * DAY, logKey: now + DAY, nodeId: origin, fullUpdate: true }
		);
		assert.ok(flagged(Floor, 'diverged'), 'premise: a flagged put');
		raiseAuditFloor(Floor.auditStore, now + 2 * DAY);
		let counts = await lookupsDuring(Floor, () =>
			apply(Floor, 'diverged', { extra: 'late' }, { version: now + 5 * DAY, nodeId: late })
		);
		assert.ok(counts.lookups > 0, 'a head the floor may have purged is resolved by the walk');

		await apply(
			Floor,
			'unknown',
			{ id: 'unknown', name: 'head' },
			{ version: now + 20 * DAY, nodeId: origin, fullUpdate: true }
		);
		Floor.auditStore.rootStore.removeSync(AUDIT_FLOOR_KEY);
		await Floor.auditStore.remove(AUDIT_FLOOR_KEY);
		assert.equal(getAuditFloor(Floor.auditStore), Infinity, 'premise: the floor reads as unknown');
		counts = await lookupsDuring(Floor, () =>
			apply(Floor, 'unknown', { extra: 'late' }, { version: now + 15 * DAY, nodeId: late })
		);
		assert.ok(counts.lookups > 0, 'an unknown floor proves nothing retained');
	});
});
