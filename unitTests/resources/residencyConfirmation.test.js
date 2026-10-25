require('../testUtils');
const assert = require('node:assert');
const { hostname } = require('node:os');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { ClientError } = require('#src/utility/errors/hdbError');
const {
	DatabaseTransaction,
	replicationConfirmation,
	confirmingResidents,
} = require('#src/resources/DatabaseTransaction');
const { certifyOriginFloor, publishOriginFloor } = require('#src/resources/originClosedFloor');

const SELF = global.server.hostname || hostname();
const PEER_A = 'residency-confirmation-a';
const PEER_B = 'residency-confirmation-b';

describe('replicatedConfirmation residency (harper-pro#1031)', () => {
	let Records, Unplaced, calls;

	before(function () {
		// LMDBTransaction keeps its own confirmation registry, which the replication layer never registers
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Records = table({
			table: 'ResidencyConfirmation',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'homes' }, { name: 'body', indexed: true }],
			audit: true,
		});
		Unplaced = table({
			table: 'ResidencyConfirmationUnplaced',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
			audit: true,
		});
	});

	beforeEach(() => {
		calls = [];
		replicationConfirmation((databaseName, version, confirmationCount, residentPeerLists) => {
			calls.push({ databaseName, version, confirmationCount, residentPeerLists });
			return Promise.resolve();
		});
		Records.setResidency((record) => record.homes);
	});

	afterEach(() => {
		replicationConfirmation(undefined);
		Records.setResidency(undefined);
		Records.setResidencyById(undefined);
	});

	const confirmed = (context, write) => transaction(context, write);
	const sorted = (lists) => lists.map((list) => [...list].sort()).sort();
	const logKeyOf = (Table, id, type) => {
		for (const entry of Table.primaryStore.rootStore.auditStore.getRange({ start: 1, log: 0 }))
			if (entry.tableId === Table.tableId && entry.recordId === id && entry.type === type) return entry.txnLogKey;
		assert.fail(`no ${type} audit entry for ${id}`);
	};

	it('passes the other residents of a record placed by a residency list', async () => {
		await confirmed({ replicatedConfirmation: 1 }, () =>
			Records.put('placed', { id: 'placed', homes: [SELF, PEER_A], body: 'complete' })
		);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].residentPeerLists, [[PEER_A]]);
		assert.equal(calls[0].version, Records.primaryStore.getEntry('placed').version);
	});

	it('passes no residency lists for a table without residency, as before', async () => {
		await confirmed({ replicatedConfirmation: 1 }, () => Unplaced.put('open', { id: 'open', body: 'complete' }));
		assert.equal(calls.length, 1);
		assert.equal(calls[0].residentPeerLists, undefined);
		assert.ok(calls[0].version);
	});

	it('passes one list per distinct residency in a multi-record transaction, ignoring unplaced records', async () => {
		await confirmed({ replicatedConfirmation: 1 }, async () => {
			await Records.put('multi-a', { id: 'multi-a', homes: [SELF, PEER_A], body: 'a' });
			await Records.put('multi-b', { id: 'multi-b', homes: [SELF, PEER_B], body: 'b' });
			await Records.put('multi-a2', { id: 'multi-a2', homes: [SELF, PEER_A], body: 'a2' });
			await Unplaced.put('multi-open', { id: 'multi-open', body: 'open' });
		});
		assert.equal(calls.length, 1);
		assert.deepEqual(sorted(calls[0].residentPeerLists), [[PEER_A], [PEER_B]]);
	});

	it('waits for the log position of a placed write whose record version is below the origin floor', async () => {
		const rootStore = Records.primaryStore.rootStore;
		let floor = certifyOriginFloor(rootStore);
		for (let retry = 0; floor === null && retry < 100; retry++) floor = certifyOriginFloor(rootStore);
		assert.ok(floor > 0, 'no origin floor was certified');
		publishOriginFloor(rootStore, floor);
		const timestamp = floor - 1000;
		for (const placedFirst of [true, false]) {
			calls = [];
			const placed = () => Records.put(`floor-${placedFirst}`, { id: `floor-${placedFirst}`, homes: [SELF, PEER_A] });
			const unplaced = () => Unplaced.put(`floor-${placedFirst}`, { id: `floor-${placedFirst}` });
			await confirmed({ replicatedConfirmation: 1, timestamp }, async () => {
				await (placedFirst ? placed : unplaced)();
				await (placedFirst ? unplaced : placed)();
			});
			assert.equal(Records.primaryStore.getEntry(`floor-${placedFirst}`).version, timestamp);
			assert.ok(calls[0].version >= floor, `confirmed on ${calls[0].version}, below the log key floor ${floor}`);
		}
		calls = [];
		await confirmed({ replicatedConfirmation: 1, timestamp }, () =>
			Unplaced.put('floor-unplaced', { id: 'floor-unplaced' })
		);
		assert.ok(calls[0].version >= floor, `an unplaced write confirmed on ${calls[0].version}, below ${floor}`);
		calls = [];
		await confirmed({ replicatedConfirmation: 1, timestamp }, () => Unplaced.delete('floor-unplaced'));
		assert.ok(calls[0].version >= floor, `a delete confirmed on ${calls[0].version}, below ${floor}`);
	});

	it('confirms a commit whose only write lost to a newer entry on that entry, not its unused log key', async () => {
		await Unplaced.put('newer', { id: 'newer', body: 'kept' });
		const { version } = Unplaced.primaryStore.getEntry('newer');
		await confirmed({ replicatedConfirmation: 1, timestamp: version - 60_000 }, () => Unplaced.delete('newer'));
		assert.equal((await Unplaced.get('newer')).body, 'kept');
		assert.equal(calls[0].version, version);
	});

	it('confirms a commit whose only write is a relocation that lost to a newer entry on that entry (harper#3182)', async () => {
		await Unplaced.put('relocated', { id: 'relocated', body: 'kept' });
		const { version } = Unplaced.primaryStore.getEntry('relocated');
		const context = { replicatedConfirmation: 1, timestamp: version - 60_000 };
		await confirmed(context, async () => {
			const resource = await Unplaced.getResource('relocated', context);
			resource._writeRelocate('relocated', {});
		});
		assert.equal((await Unplaced.get('relocated')).body, 'kept');
		assert.equal(Unplaced.primaryStore.getEntry('relocated').version, version);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].version, version);
	});

	it('confirms on the log key when a losing relocation shares the commit with an applied write', async () => {
		await Unplaced.put('relocated-mixed', { id: 'relocated-mixed', body: 'kept' });
		const { version } = Unplaced.primaryStore.getEntry('relocated-mixed');
		const context = { replicatedConfirmation: 1, timestamp: version - 60_000 };
		await confirmed(context, async () => {
			const resource = await Unplaced.getResource('relocated-mixed', context);
			resource._writeRelocate('relocated-mixed', {});
			await Unplaced.put('relocated-mixed-new', { id: 'relocated-mixed-new' });
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].version, logKeyOf(Unplaced, 'relocated-mixed-new', 'put'));
	});

	it('confirms a relocation that lost when staged but applied when re-staged past an open iterator', async () => {
		await Unplaced.put('relocated-evicted', { id: 'relocated-evicted', body: 'kept' });
		const { version, value } = Unplaced.primaryStore.getEntry('relocated-evicted');
		const context = { replicatedConfirmation: 1, timestamp: version - 60_000 };
		let iterator;
		try {
			await confirmed(context, async () => {
				// the open iterator makes the commit re-stage every write on a fresh transaction
				iterator = Unplaced.search({ conditions: [] })[Symbol.iterator]();
				iterator.next();
				const resource = await Unplaced.getResource('relocated-evicted', context);
				resource._writeRelocate('relocated-evicted', {});
				await Unplaced.evict('relocated-evicted', value, version);
			});
		} finally {
			iterator?.return?.();
		}
		assert.equal(Unplaced.primaryStore.getEntry('relocated-evicted'), undefined);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].version, logKeyOf(Unplaced, 'relocated-evicted', 'relocate'));
	});

	it('keeps a count-based placement at its count when a record is updated', async () => {
		Records.setResidency(undefined);
		const previousNodes = global.server.nodes;
		global.server.nodes = [{ name: PEER_A }, { name: PEER_B }];
		try {
			for (const body of ['first', 'second', 'third']) {
				calls = [];
				await confirmed({ replicatedConfirmation: 2, replicateTo: 2 }, () =>
					Records.put('counted', { id: 'counted', body })
				);
				assert.deepEqual(sorted(calls[0].residentPeerLists), [[PEER_A, PEER_B]], `after the ${body} write`);
			}
		} finally {
			global.server.nodes = previousNodes;
		}
	});

	it('places a replicateTo list like a residency list', async () => {
		Records.setResidency(undefined);
		await confirmed({ replicatedConfirmation: 1, replicateTo: [PEER_B] }, () =>
			Records.put('replicate-to', { id: 'replicate-to', body: 'complete' })
		);
		assert.deepEqual(calls[0].residentPeerLists, [[PEER_B]]);
	});

	it('fails before writing when the count exceeds the other residents', async () => {
		await assert.rejects(
			confirmed({ replicatedConfirmation: 2 }, async () =>
				Records.put('too-few', { id: 'too-few', homes: [SELF, PEER_A, PEER_A], body: 'complete' })
			),
			(error) => {
				assert.equal(error.statusCode, 400);
				assert.match(error.message, /Cannot confirm replication to 2 node\(s\) for record "too-few"/);
				assert.match(error.message, new RegExp(`resident on 1 other node\\(s\\) \\(${PEER_A}\\)`));
				return true;
			}
		);
		assert.equal(Records.primaryStore.getEntry('too-few'), undefined);
		assert.equal(calls.length, 0);
		await Records.put('too-few', { id: 'too-few', homes: [SELF, PEER_A], body: 'later' });
		assert.equal((await Records.get('too-few')).body, 'later');
	});

	it('names a BigInt key in the refusal', async () => {
		await Records.put('self-only', { id: 'self-only', homes: [SELF] });
		const { residencyId } = Records.primaryStore.getEntry('self-only');
		assert.throws(
			() => confirmingResidents(Records.primaryStore, residencyId, 1, ['composite', 12n]),
			new RegExp(`for record \\["composite",12\\] in database "${Records.primaryStore.rootStore.databaseName}"`)
		);
	});

	it('consults the registered feasibility check before committing, and writes nothing when it refuses', async () => {
		const checked = [];
		replicationConfirmation(
			() => Promise.resolve(),
			(databaseName, confirmationCount, residentPeerLists) => {
				checked.push({ databaseName, confirmationCount, residentPeerLists });
				if (residentPeerLists?.some((residents) => residents.includes('unreachable')))
					throw new ClientError('not reachable from here');
			}
		);
		await confirmed({ replicatedConfirmation: 1 }, () =>
			Records.put('feasible', { id: 'feasible', homes: [SELF, PEER_A], body: 'ok' })
		);
		await assert.rejects(
			confirmed({ replicatedConfirmation: 1 }, () =>
				Records.put('infeasible', { id: 'infeasible', homes: [SELF, 'unreachable'], body: 'no' })
			),
			/not reachable from here/
		);
		assert.deepEqual(checked, [
			{
				databaseName: Records.primaryStore.rootStore.databaseName,
				confirmationCount: 1,
				residentPeerLists: [[PEER_A]],
			},
			{
				databaseName: Records.primaryStore.rootStore.databaseName,
				confirmationCount: 1,
				residentPeerLists: [['unreachable']],
			},
		]);
		assert.equal((await Records.get('feasible')).body, 'ok');
		assert.equal(Records.primaryStore.getEntry('infeasible'), undefined);
	});

	it('refuses an asynchronous feasibility check rather than submitting past it', async () => {
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			replicationConfirmation(
				() => Promise.resolve(),
				async () => {
					throw new Error('asynchronous refusal');
				}
			);
			await assert.rejects(
				confirmed({ replicatedConfirmation: 1 }, () =>
					Records.put('async-check', { id: 'async-check', homes: [SELF, PEER_A], body: 'no' })
				),
				/feasibility check must be synchronous/
			);
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
		assert.deepEqual(unhandled, []);
		assert.equal(Records.primaryStore.getEntry('async-check'), undefined);
	});

	it('neither waits on nor checks a commit that appends nothing to replicate', async () => {
		const checked = [];
		replicationConfirmation(
			(...args) => {
				calls.push(args);
				return Promise.resolve();
			},
			(...args) => checked.push(args)
		);
		const NoAudit = table({
			table: 'ResidencyConfirmationNoAudit',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
			audit: false,
		});
		await NoAudit.put(1, { id: 1 });
		await confirmed({ replicatedConfirmation: 1 }, () => NoAudit.delete(1));
		const context = { transaction: new DatabaseTransaction() };
		Records.writeReloadMarker(context);
		context.transaction.replicatedConfirmation = 1;
		await context.transaction.commit({ doneWriting: true });
		assert.deepEqual(calls, []);
		assert.deepEqual(checked, []);
	});

	it('rolls back the whole transaction when a later record cannot be confirmed', async () => {
		await assert.rejects(
			confirmed({ replicatedConfirmation: 1 }, async () => {
				await Records.put('rollback-ok', { id: 'rollback-ok', homes: [SELF, PEER_A], body: 'ok' });
				await Records.put('rollback-self', { id: 'rollback-self', homes: [SELF], body: 'self only' });
			}),
			/resident on 0 other node\(s\)$/
		);
		assert.equal(Records.primaryStore.getEntry('rollback-ok'), undefined);
		assert.equal(Records.primaryStore.getEntry('rollback-self'), undefined);
	});

	it('does not commit a refused write whose refusal the caller caught', async () => {
		await confirmed({ replicatedConfirmation: 1 }, async () => {
			await Records.put('caught-ok', { id: 'caught-ok', homes: [SELF, PEER_A], body: 'ok' });
			await assert.rejects(
				async () => Records.put('caught-refused', { id: 'caught-refused', homes: [SELF], body: 'refused' }),
				/resident on 0 other node\(s\)$/
			);
		});
		assert.equal(Records.primaryStore.getEntry('caught-refused'), undefined);
		const indexed = Array.from(Records.indices.body.getRange({ start: null }), ({ key }) => key);
		assert.ok(!indexed.includes('refused'), `the refused write left an index entry: ${JSON.stringify(indexed)}`);
		assert.ok(indexed.includes('ok'));
		assert.equal((await Records.get('caught-ok')).body, 'ok');
		assert.deepEqual(calls[0].residentPeerLists, [[PEER_A]]);
	});

	it("confirms on the accepted write's version, not a refused update's older entry", async () => {
		await Records.put('refused-existing', { id: 'refused-existing', body: 'old' });
		const oldVersion = Records.primaryStore.getEntry('refused-existing').version;
		await confirmed({ replicatedConfirmation: 1 }, async () => {
			await Records.put('accepted', { id: 'accepted', homes: [SELF, PEER_A], body: 'ok' });
			await assert.rejects(
				async () => Records.put('refused-existing', { id: 'refused-existing', homes: [SELF], body: 'refused' }),
				/resident on 0 other node\(s\)$/
			);
		});
		assert.equal((await Records.get('refused-existing')).body, 'old');
		assert.equal(calls[0].version, Records.primaryStore.getEntry('accepted').version);
		assert.notEqual(calls[0].version, oldVersion);
	});

	it('refuses before committing when confirmation is requested after the write was staged', async () => {
		const context = { transaction: new DatabaseTransaction() };
		await Records.put('late', { id: 'late', homes: [SELF], body: 'complete' }, context);
		context.transaction.replicatedConfirmation = 1;
		await assert.rejects(
			async () => context.transaction.commit({ doneWriting: true }),
			/resident on 0 other node\(s\)$/
		);
		assert.equal(calls.length, 0);
		assert.equal(Records.primaryStore.getEntry('late'), undefined);
		await Records.put('late', { id: 'late', homes: [SELF], body: 'again' });
		assert.equal((await Records.get('late')).body, 'again');
	});

	it('confirms an update that omits the writer on its own version, not the older entry it leaves', async () => {
		Records.setResidency(undefined);
		await Records.put('left-behind', { id: 'left-behind', body: 'old' });
		const oldVersion = Records.primaryStore.getEntry('left-behind').version;
		Records.setResidencyById(() => [PEER_A]);
		await confirmed({ replicatedConfirmation: 1 }, () =>
			Records.put('left-behind', { id: 'left-behind', body: 'new' })
		);
		assert.equal(calls.length, 1);
		assert.ok(
			calls[0].version > oldVersion,
			`confirmed on ${calls[0].version}, the entry left behind is ${oldVersion}`
		);
	});

	it('confirms a late-requested update that omits the writer on its log key, not the entry it leaves', async () => {
		Records.setResidency(undefined);
		await Records.put('late-left-behind', { id: 'late-left-behind', body: 'old' });
		const oldVersion = Records.primaryStore.getEntry('late-left-behind').version;
		Records.setResidencyById(() => [PEER_A]);
		const context = { transaction: new DatabaseTransaction() };
		await Records.put('late-left-behind', { id: 'late-left-behind', body: 'new' }, context);
		context.transaction.replicatedConfirmation = 1;
		await context.transaction.commit({ doneWriting: true });
		assert.ok(
			calls[0].version > oldVersion,
			`confirmed on ${calls[0].version}, the entry left behind is ${oldVersion}`
		);
	});

	it('confirms a write whose residency omits the writer, which stores no local record', async () => {
		Records.setResidency(undefined);
		Records.setResidencyById(() => [PEER_A]);
		await confirmed({ replicatedConfirmation: 1 }, () =>
			Records.put('elsewhere', { id: 'elsewhere', body: 'complete' })
		);
		assert.equal(Records.primaryStore.getEntry('elsewhere')?.value, undefined);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].residentPeerLists, [[PEER_A]]);
		assert.ok(calls[0].version);
	});
});
