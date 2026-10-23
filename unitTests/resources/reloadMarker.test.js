const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { LOCAL_ONLY } = require('#src/resources/auditStore');
const { ResumeHistoryUnavailableError } = require('#src/utility/errors/hdbError');
const {
	DatabaseTransaction,
	replicationConfirmation: rocksReplicationConfirmation,
} = require('#src/resources/DatabaseTransaction');
const { replicationConfirmation: lmdbReplicationConfirmation } = require('#src/resources/LMDBTransaction');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const setReplicationConfirmation = isLMDB ? lmdbReplicationConfirmation : rocksReplicationConfirmation;

// A table-reload marker is a whole-table signal (harper-pro#489): one LOCAL_ONLY audit entry of type
// 'reload' with no record, delivered to every subscriber on the table so they re-read it. It exists so
// copyApply (which back-fills base-copy rows as snapshots with no per-row audit entries) can cover the
// system DB, whose subscribers (hdb_nodes peer discovery, hdb_certificate CA install) drive off the
// audit `aftercommit` stream.
describe('table-reload marker (harper-pro#489)', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('delivers a raw reload event to every subscriber on a system table', async function () {
		// System-DB subscribers (knownNodes peer discovery, hdb_certificate CA install) consume the raw
		// marker and run their own bespoke whole-table rescan, so for the system DB the bare 'reload' is
		// forwarded verbatim. (User-DB tables instead re-snapshot the current scope — see the next test,
		// harper-pro#495.)
		const ReloadTable = table({
			database: 'system',
			table: 'ReloadMarkerDeliver',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		// Two subscribers at different keys: the reload marker has no recordId, so BOTH must be notified.
		const rootEvents = [];
		const keyEvents = [];
		const rootSub = await ReloadTable.subscribe({});
		rootSub.on('data', (event) => rootEvents.push(event));
		const keySub = await ReloadTable.subscribe('some-key');
		keySub.on('data', (event) => keyEvents.push(event));

		await ReloadTable.writeReloadMarker();

		await waitFor(() => rootEvents.some((e) => e.type === 'reload'), {
			timeout: 5000,
			interval: 20,
			message: 'root subscriber receives reload',
		});
		await waitFor(() => keyEvents.some((e) => e.type === 'reload'), {
			timeout: 5000,
			interval: 20,
			message: 'keyed subscriber receives reload',
		});

		const reload = rootEvents.find((e) => e.type === 'reload');
		assert.equal(reload.value, undefined, 'reload carries no record value');
		assert.ok(reload.id == null, 'reload has no record id (whole-table signal)');
	});

	it('re-snapshots the current scope (not a raw reload) to a user-table subscriber (harper-pro#495)', async function () {
		// On a user table, a copyApply base copy back-fills rows with no per-row audit events, so the live
		// listener never fired for them. subscribe() reacts to the reload marker by re-delivering the
		// current scope as 'put's — recovering those rows — and suppresses the bare marker (a 'reload' typed
		// event is meaningless to MQTT/SSE/WS clients). Subscribe with omitCurrent so the only delivery is
		// the reload-driven re-snapshot, not the initial snapshot.
		const ReloadTable = table({
			table: 'ReloadMarkerResnapshot',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		await ReloadTable.put({ id: 'r1', name: 'one' });

		const events = [];
		const sub = await ReloadTable.subscribe({ omitCurrent: true });
		sub.on('data', (event) => events.push(event));

		await ReloadTable.writeReloadMarker();

		await waitFor(() => events.some((e) => e.type === 'put' && e.id === 'r1'), {
			timeout: 5000,
			interval: 20,
			message: 'subscriber receives the existing row as a put via the reload re-snapshot',
		});
		assert.ok(
			!events.some((e) => e.type === 'reload'),
			'the bare reload marker is suppressed on a user table (re-snapshotted instead)'
		);
	});

	it('persists the marker as a local-only audit entry that never replicates', async function () {
		for (const forceContention of isLMDB ? [false, true] : [false]) {
			const ReloadTable = table({
				table: `ReloadMarkerAudit${forceContention ? 'Contention' : 'Optimistic'}`,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			});
			// touch the audit stream first so the table has an audit store wired up
			await ReloadTable.put({ id: 1, name: 'row' });
			const originalRetryRisk = ReloadTable.primaryStore.retryRisk;
			if (isLMDB) ReloadTable.primaryStore.retryRisk = forceContention ? 101 : 0;
			try {
				await ReloadTable.writeReloadMarker();
			} finally {
				ReloadTable.primaryStore.retryRisk = originalRetryRisk;
			}

			// The txn-log store's empty getRange positions at the tail (for live subscription), so scan from an
			// explicit numeric start to read the existing entries.
			let marker;
			for (const entry of ReloadTable.auditStore.getRange({ start: 1 })) {
				if (entry.type === 'reload' && entry.tableId === ReloadTable.tableId) {
					marker = entry;
					break;
				}
			}
			assert.ok(marker, 'a reload audit entry was written');
			// LOCAL_ONLY makes the replication send path skip it by a bitmask test (no decode of an unknown
			// type on a peer): the marker is a local signal only.
			assert.ok(marker.extendedType & LOCAL_ONLY, 'reload marker is LOCAL_ONLY (never forwarded to peers)');
			assert.ok(marker.recordId == null, 'reload marker has a null recordId');
			// the regular row keeps its own audit entry; the marker did not disturb it
			assert.ok((await ReloadTable.getHistoryOfRecord(1)).length >= 1, 'the real row still has its audit entry');
		}
	});

	it('confirms a stored null-key publish but not a local-only marker', async function () {
		const ReloadTable = table({
			table: 'ReloadMarkerConfirmation',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		let confirmationCalls = 0;
		let confirmedVersion;
		setReplicationConfirmation((_databaseName, version) => {
			confirmationCalls++;
			confirmedVersion = version;
		});
		try {
			const publishContext = { transaction: new DatabaseTransaction() };
			ReloadTable.publish(null, { message: 'root topic' }, publishContext);
			const publishTransaction = isLMDB ? publishContext.transaction.next : publishContext.transaction;
			publishTransaction.replicatedConfirmation = 1;
			await publishTransaction.commit({ doneWriting: true });
			assert.equal(confirmationCalls, 1, 'a stored root-topic publish is confirmed');
			assert.ok(confirmedVersion != null, 'the confirmation uses the stored entry version');

			const context = { transaction: new DatabaseTransaction() };
			ReloadTable.writeReloadMarker(context);
			const markerTransaction = isLMDB ? context.transaction.next : context.transaction;
			markerTransaction.replicatedConfirmation = 1;
			await markerTransaction.commit({ doneWriting: true });
			assert.equal(confirmationCalls, 1, 'a LOCAL_ONLY marker has nothing to confirm with peers');

			// a trailing marker is exempt from confirmation, but it must not suppress confirmation for the
			// replicable write staged before it in the same transaction
			const mixedContext = { transaction: new DatabaseTransaction() };
			await ReloadTable.put(2, { id: 2 }, mixedContext);
			ReloadTable.writeReloadMarker(mixedContext);
			const mixedTransaction = isLMDB ? mixedContext.transaction.next : mixedContext.transaction;
			mixedTransaction.replicatedConfirmation = 1;
			confirmedVersion = undefined;
			await mixedTransaction.commit({ doneWriting: true });
			assert.equal(confirmationCalls, 2, 'the replicable write staged before the marker is still confirmed');
			assert.ok(confirmedVersion != null, 'confirmation uses the stored entry of the replicable write');

			// the other write the confirmation walk skips: one with no stored entry at all — a delete
			// leaves nothing to read back only when the table has neither audit nor delete tracking
			const NoAuditTable = table({
				table: 'ReloadMarkerNoAuditDelete',
				attributes: [{ name: 'id', isPrimaryKey: true }],
				audit: false,
			});
			await NoAuditTable.put(1, { id: 1 });
			const deleteContext = { transaction: new DatabaseTransaction() };
			await NoAuditTable.put(2, { id: 2 }, deleteContext);
			await NoAuditTable.delete(1, deleteContext);
			const deleteTransaction = isLMDB ? deleteContext.transaction.next : deleteContext.transaction;
			deleteTransaction.replicatedConfirmation = 1;
			confirmedVersion = undefined;
			await deleteTransaction.commit({ doneWriting: true });
			assert.equal(confirmationCalls, 3, 'the put staged before an entry-less delete is still confirmed');
			// LMDB confirms on the audit store's local time, which an `audit: false` table's records do not
			// carry at all (pre-existing: every confirmed write on such a table passes undefined).
			if (!isLMDB) assert.ok(confirmedVersion != null, 'confirmation uses the stored entry of the put, not the delete');
		} finally {
			setReplicationConfirmation(undefined);
		}
	});
});

describe('a replay that crosses a reload marker', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	let sequence = 0;
	function reloadTable(database) {
		const name = `ReplayReload${++sequence}`;
		return table({
			table: name,
			database: database ?? `replay_reload_${name}`,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
	}

	async function putAndPosition(T, id, value) {
		const positions = [];
		const live = await T.subscribe({ omitCurrent: true, listener: (event) => positions.push(event.localTime) });
		await T.put(id, { value });
		await waitFor(() => positions.length > 0);
		live.end();
		return positions[0];
	}

	/** A row stored without an audit entry, as a copyApply snapshot leaves it. */
	const backfill = (T, id, value) => T.primaryStore.put(id, { id, value });

	const pathId = (group, name) => `${group}/${name}`;
	async function reloadedAfterPosition(database, id = pathId) {
		const T = reloadTable(database);
		const startTime = await putAndPosition(T, id('team', 'before'), 'before');
		await backfill(T, id('team', 'back'), 'back');
		await backfill(T, id('other', 'back'), 'other-back');
		await T.writeReloadMarker();
		await T.put(id('team', 'after'), { value: 'after' });
		await T.put(id('other', 'after'), { value: 'other-after' });
		return { T, startTime };
	}

	async function subscribed(T, request) {
		const events = [];
		const subscription = await T.subscribe({ ...request, listener: (event) => events.push(event) });
		return { subscription, events };
	}

	const delivered = (events) => events.filter((event) => !(event instanceof Error)).map((event) => event.value?.value);
	const errors = (events) => events.filter((event) => event instanceof Error);
	const saw = (events) => () =>
		`saw ${JSON.stringify(events.map((event) => (event instanceof Error ? `${event.name}: ${event.message}` : [event.type, event.id, event.value?.value])))}`;
	const refused = (events) => {
		const last = events.at(-1);
		return last instanceof ResumeHistoryUnavailableError && /bulk reload/.test(last.message);
	};

	const scopes = [
		['root', {}, pathId, ['back', 'other-back']],
		['array-prefix', { id: 'team', isCollection: true }, (group, name) => [group, name], ['back']],
		// the current-scope scan reads no string-path descendants (harper#3481)
		['path-prefix', { id: 'team/', isCollection: true }, pathId, []],
	];

	for (const [label, scope, id, backfilled] of scopes) {
		it(`re-delivers the current ${label} scope after a startTime replay across the marker`, async () => {
			const { T, startTime } = await reloadedAfterPosition(undefined, id);
			const { subscription, events } = await subscribed(T, { startTime, ...scope });
			await waitFor(() => backfilled.every((value) => delivered(events).includes(value)), { message: saw(events) });
			await waitFor(() => delivered(events).includes('after'), { message: saw(events) });
			if (label !== 'root') {
				assert.ok(
					!delivered(events).some((value) => String(value).startsWith('other')),
					'the re-delivery keeps to the scope'
				);
			}
			assert.ok(!events.some((event) => event.type === 'reload'), 'the marker is not delivered as an event');
			assert.deepStrictEqual(errors(events), []);
			assert.strictEqual(subscription.closed, false);
			subscription.end();
		});

		it(`refuses a ${label} startTime replay that reports progress, at the marker`, async () => {
			const { T, startTime } = await reloadedAfterPosition(undefined, id);
			const { subscription, events } = await subscribed(T, { startTime, reportProgress: true, ...scope });
			await waitFor(() => subscription.closed, { message: saw(events) });
			assert.ok(refused(events), `refused with the 410, not ${events.at(-1)}`);
			assert.strictEqual(events.at(-1).code, 'RESUME_HISTORY_UNAVAILABLE');
			assert.ok(!delivered(events).includes('after'), 'nothing past the marker is delivered');
		});

		it(`hands a previousCount backfill across the marker the current ${label} scope, spending no slot on it`, async function () {
			// collection previousCount reads the log in reverse, which the RocksDB transaction log cannot
			if (!isLMDB) return this.skip();
			const { T } = await reloadedAfterPosition(undefined, id);
			const slots = label === 'root' ? 3 : 2;
			const history = label === 'root' ? ['before', 'after', 'other-after'] : ['before', 'after'];
			const { subscription, events } = await subscribed(T, { previousCount: slots, ...scope });
			await waitFor(() => backfilled.every((value) => delivered(events).includes(value)), { message: saw(events) });
			await waitFor(() => delivered(events).length >= history.length, { message: saw(events) });
			assert.deepStrictEqual(delivered(events).slice(0, history.length), history);
			assert.ok(!events.some((event) => event.type === 'reload'));
			assert.deepStrictEqual(errors(events), []);
			subscription.end();
		});

		it(`refuses a ${label} previousCount backfill that reports progress, at the marker`, async function () {
			if (!isLMDB) return this.skip();
			const { T } = await reloadedAfterPosition(undefined, id);
			const { subscription, events } = await subscribed(T, { previousCount: 10, reportProgress: true, ...scope });
			await waitFor(() => subscription.closed, { message: saw(events) });
			assert.ok(refused(events), `refused with the 410, not ${events.at(-1)}`);
			assert.deepStrictEqual(delivered(events), [], 'none of the history is delivered');
		});
	}

	it('keeps its cursor before the marker until the current scope is handed off', async () => {
		const { T, startTime } = await reloadedAfterPosition();
		const first = await T.subscribe({
			startTime,
			listener() {
				this.end();
			},
		});
		await waitFor(() => first.closed);
		const { subscription, events } = await subscribed(T, { startTime: first.startTime });
		await waitFor(() => delivered(events).includes('back'), { message: saw(events) });
		subscription.end();
	});

	it('delivers a commit that lands while the re-snapshot after the last marker waits for its consumer', async () => {
		const T = reloadTable();
		const startTime = await putAndPosition(T, 'team/before', 'before');
		for (let i = 0; i < 150; i++) await backfill(T, `team/back${i}`, `back${i}`);
		await T.writeReloadMarker();
		const subscription = await T.subscribe({ startTime });
		await waitFor(() => subscription.queue?.length > 100, { message: 'the re-snapshot fills the queue and waits' });
		const witness = [];
		const live = await T.subscribe({ omitCurrent: true, listener: (event) => witness.push(event.value?.value) });
		await T.put('team/live', { value: 'live' });
		await waitFor(() => witness.includes('live'));
		live.end();
		const events = [];
		subscription.on('data', (event) => events.push(event));
		await waitFor(() => delivered(events).includes('live'), { message: saw(events) });
		assert.ok(delivered(events).includes('back149'));
		subscription.end();
	});

	it('refreshes a row buffered behind the re-snapshot to its current value', async () => {
		const T = reloadTable();
		const startTime = await putAndPosition(T, 'team/before', 'before');
		for (let i = 0; i < 150; i++) await backfill(T, `team/back${i}`, `back${i}`);
		await T.writeReloadMarker();
		const subscription = await T.subscribe({ startTime });
		await waitFor(() => subscription.queue?.length > 100, { message: 'the re-snapshot fills the queue and waits' });
		const witness = [];
		const live = await T.subscribe({ omitCurrent: true, listener: (event) => witness.push(event.value?.value) });
		await T.put('zz', { value: 'buffered' });
		await waitFor(() => witness.includes('buffered'));
		// when the publish commits before the put is broadcast, the put's own live event is dropped
		await Promise.all([T.put('zz', { value: 'current' }), T.publish('zz', { value: 'message' })]);
		await waitFor(() => witness.includes('message'));
		live.end();
		const events = [];
		subscription.on('data', (event) => events.push(event));
		await waitFor(() => delivered(events).includes('message'), { message: saw(events) });
		const current = (await T.get('zz')).value;
		const rowValues = events
			.filter((event) => event.id === 'zz' && event.type !== 'message')
			.map((event) => event.value?.value);
		assert.ok(rowValues.length > 0 && rowValues.every((value) => value === current), `deliveries: ${rowValues}`);
		subscription.end();
	});

	it('ends the last delivery of each row on its current value', async () => {
		const T = reloadTable();
		const startTime = await putAndPosition(T, 'seed', 'seed');
		await T.put('team/x', { value: 'audited' });
		await backfill(T, 'team/x', 'back-filled');
		await T.writeReloadMarker();
		const { subscription, events } = await subscribed(T, { startTime, includeSuperseded: true });
		await waitFor(() => delivered(events).includes('back-filled'), { message: saw(events) });
		const forRow = events.filter((event) => event.id === 'team/x').map((event) => event.value?.value);
		assert.strictEqual(forRow.at(-1), 'back-filled', `deliveries: ${forRow}`);
		subscription.end();
	});

	it('re-delivers once for consecutive markers', async () => {
		const T = reloadTable();
		const startTime = await putAndPosition(T, 'team/before', 'before');
		await backfill(T, 'team/back', 'back');
		await T.writeReloadMarker();
		await T.writeReloadMarker();
		await T.put('team/after', { value: 'after' });
		let scans = 0;
		const getRange = T.primaryStore.getRange;
		T.primaryStore.getRange = function (options) {
			if (options?.versions) scans++;
			return getRange.apply(this, arguments);
		};
		try {
			const { subscription, events } = await subscribed(T, { startTime });
			await waitFor(() => delivered(events).filter((value) => value === 'after').length === 2, {
				message: saw(events),
			});
			assert.strictEqual(scans, 1);
			assert.deepStrictEqual(delivered(events), ['after', 'back', 'before', 'after']);
			subscription.end();
		} finally {
			T.primaryStore.getRange = getRange;
		}
	});

	it("is not affected by another table's marker", async () => {
		const T = reloadTable('replay_reload_shared');
		const Other = reloadTable('replay_reload_shared');
		const startTime = await putAndPosition(T, 'team/before', 'before');
		await Other.writeReloadMarker();
		await T.put('team/after', { value: 'after' });
		const { subscription, events } = await subscribed(T, {
			startTime,
			reportProgress: true,
			id: 'team/',
			isCollection: true,
		});
		await waitFor(() => delivered(events).includes('after'), { message: saw(events) });
		assert.strictEqual(subscription.closed, false);
		subscription.end();
	});

	for (const [label, database, request] of [
		['a rawEvents', undefined, { rawEvents: true }],
		['a system-database', 'system', {}],
	]) {
		it(`delivers the raw marker to ${label} prefix replay, as to its root replay`, async () => {
			const { T, startTime } = await reloadedAfterPosition(database);
			for (const scope of [{}, { id: 'team/', isCollection: true }]) {
				const { subscription, events } = await subscribed(T, { startTime, ...request, ...scope });
				await waitFor(() => delivered(events).includes('after'), { message: saw(events) });
				assert.ok(
					events.some((event) => event.type === 'reload' && event.id == null),
					`the marker reaches ${JSON.stringify(scope)}`
				);
				assert.deepStrictEqual(errors(events), []);
				subscription.end();
			}
		});
	}

	it('passes over a root publish in a prefix replay', async () => {
		const T = reloadTable();
		const startTime = await putAndPosition(T, 'team/before', 'before');
		await T.publish(null, { value: 'root message' });
		await T.put('team/after', { value: 'after' });
		const { subscription, events } = await subscribed(T, { startTime, id: 'team/', isCollection: true });
		await waitFor(() => delivered(events).includes('after'), { message: saw(events) });
		assert.deepStrictEqual(errors(events), []);
		assert.ok(!delivered(events).includes('root message'));
		subscription.end();
	});

	for (const [label, replayed] of [
		['a replay', true],
		['a live subscription', false],
	]) {
		it(`ends ${label} whose re-delivery fails, rather than leaving it open past the marker`, async () => {
			const T = reloadTable();
			const startTime = await putAndPosition(T, 'team/before', 'before');
			const listener = (event) => {
				if (event.value?.value === 'back') throw new Error('the consumer failed');
			};
			const live = replayed ? undefined : await T.subscribe({ omitCurrent: true, listener });
			await backfill(T, 'team/back', 'back');
			await T.writeReloadMarker();
			const subscription = live ?? (await T.subscribe({ startTime, listener }));
			await waitFor(() => subscription.closed);
			assert.match(String(subscription.closedWith), /the consumer failed/);
			if (!replayed) return;
			const { subscription: resumed, events } = await subscribed(T, { startTime: subscription.startTime });
			await waitFor(() => delivered(events).includes('back'), { message: saw(events) });
			resumed.end();
		});
	}
});
