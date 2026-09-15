const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { table, dropDatabase } = require('#src/resources/databases');
const {
	registerReplicatedApplyFailureListener: register,
	unregisterReplicatedApplyFailureListener: unregister,
	notifyReplicatedApplyFailure,
} = require('#src/resources/replicatedApplyFailure');
const { waitFor } = require('../waitFor');
const { pinLogConfig } = require('../logConfigFixture');

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const DATABASE = 'replicated-apply-failures';
let serial = 0;

describe('replicated apply failure listeners', function () {
	this.timeout(10000);
	let restoreLogging;
	let logRoot;
	const subscriptions = [];
	const registrations = [];

	before(() => {
		setupTestDBPath();
		logRoot = path.join(process.env.ROOTPATH, 'apply-failure-logs');
		restoreLogging = pinLogConfig({ logRoot });
	});

	after(() => restoreLogging());
	afterEach(async () => {
		for (const { done, held } of subscriptions.splice(0)) {
			held.resolve();
			await done.promise;
		}
		for (const [database, listener] of registrations.splice(0)) unregister(database, listener);
	});

	function listen(listener, database = DATABASE) {
		register(database, listener);
		registrations.push([database, listener]);
	}

	function fixture(database = DATABASE) {
		const Table = table({
			database,
			table: `ApplyFailures${++serial}`,
			attributes: [{ name: 'id', isPrimaryKey: true }],
			audit: true,
		});
		const pulls = [];
		const held = deferred();
		const done = deferred();
		return {
			Table,
			pulls,
			start(events) {
				subscriptions.push({ held, done });
				Table.sourcedFrom(
					{
						subscribeOnThisThread: () => true,
						async *subscribe() {
							try {
								for (const event of events) {
									pulls.push(event.id ?? event.type);
									yield event;
								}
								await held.promise;
							} finally {
								done.resolve();
							}
						},
					},
					{ intermediateSource: true }
				);
			},
		};
	}

	function put(id, extra = {}) {
		return Object.defineProperties(
			{ type: 'put', id, value: { id }, nodeId: 21, timestamp: Date.now() },
			Object.getOwnPropertyDescriptors(extra)
		);
	}

	function commitFailure(event, Table) {
		const completion = deferred();
		let txn;
		let committing = false;
		event.finished = {
			then(resolve) {
				txn = event.transaction;
				while (!txn.db && txn.next) txn = txn.next;
				// Exercise the real pre-commit hook on both engines without replacing commit or storage methods.
				txn.addWrite({
					key: `${event.id}-failure`,
					store: Table.primaryStore,
					deferSave: true,
					before() {
						committing = true;
						return completion.promise;
					},
					commit() {},
				});
				resolve();
			},
		};
		return {
			resolve: completion.resolve,
			async reject(error) {
				await waitFor(() => committing, { message: 'the source transaction must reach commit' });
				assert.ok(
					txn.writes.some((write) => write?.key === event.id),
					'the failed write must be staged'
				);
				completion.reject(error);
			},
		};
	}

	for (const boundary of ['beginTxn', 'end_txn', 'standalone', 'standalone with onCommit']) {
		it(`awaits every listener after a ${boundary} commit rejection before staging the next write`, async () => {
			const { Table, pulls, start } = fixture();
			const failed = put('failed', { localTime: 123, version: 456, viaNodeId: 99, remoteNodeIds: [99] });
			if (boundary === 'beginTxn' || boundary === 'end_txn') failed.beginTxn = true;
			let onCommitCalls = 0;
			if (boundary === 'standalone with onCommit') failed.onCommit = () => onCommitCalls++;
			const fault = commitFailure(failed, Table);
			const error = new Error(`terminal ${boundary} commit failure`);
			const firstGate = deferred();
			const secondGate = deferred();
			const failures = [];
			let settled = false;
			listen(async (failure) => {
				failures.push(failure);
				await firstGate.promise;
			});
			listen(async (failure) => {
				failures.push(failure);
				await secondGate.promise;
				settled = true;
			});
			let nextStarted = false;
			const next = put('next', {
				nodeId: 22,
				timestamp: failed.timestamp + 1,
				beginTxn: true,
				get value() {
					nextStarted = true;
					assert.ok(settled, 'listeners must resolve before the next write can be staged');
					return { id: 'next' };
				},
			});
			const end = { type: 'end_txn', timestamp: next.timestamp, localTime: Date.now() + 10, remoteNodeIds: [99] };
			const events = [failed];
			if (boundary === 'end_txn') events.push({ type: 'end_txn', timestamp: failed.timestamp + 2 });
			events.push(next, end);
			try {
				start(events);
				await fault.reject(error);
				await waitFor(() => failures.length === 1, { message: 'first failure listener called' });
				assert.equal(nextStarted, false);
				assert.equal(pulls.length, failed.beginTxn ? 2 : 1, 'no further source event may be pulled after failure');
				assert.deepStrictEqual(failures[0], {
					database: DATABASE,
					table: Table.tableName,
					nodeId: 21,
					position: failed.timestamp,
					localTime: 123,
					error,
				});
				firstGate.resolve();
				await waitFor(() => failures.length === 2, { message: 'second failure listener called' });
				assert.equal(nextStarted, false);
				assert.equal(pulls.length, failed.beginTxn ? 2 : 1);
				secondGate.resolve();
				await waitFor(async () => await Table.get('next'), { message: 'next transaction commits' });
				assert.equal(await Table.get('failed'), undefined);
				assert.equal(onCommitCalls, 0);
				await waitFor(() => Table.dbisDB.getSync([Symbol.for('seq'), 99])?.seqId === end.localTime, {
					message: 'the later cursor advances only after the hole was reported',
				});
			} finally {
				fault.resolve();
				firstGate.resolve();
				secondGate.resolve();
			}
		});
	}

	for (const kind of ['staging', 'empty transaction', 'unknown operation', 'lock control', 'valueless put']) {
		it(`awaits notification for a ${kind} failure before pulling another event`, async () => {
			const { Table, pulls, start } = fixture();
			const failed = put('failed');
			if (kind === 'staging') failed.table = 'MissingTable';
			if (kind === 'valueless put') Object.assign(failed, { value: null, beginTxn: true });
			if (kind === 'empty transaction') Object.assign(failed, { type: 'transaction', writes: [] });
			if (kind === 'unknown operation') Object.assign(failed, { type: 'invalid-operation', beginTxn: true });
			if (kind === 'lock control') Object.assign(failed, { type: 'lockGrant', value: [], beginTxn: true });
			const gate = deferred();
			const failures = [];
			listen(async (failure) => {
				failures.push(failure);
				await gate.promise;
			});
			try {
				start([failed, put('next', { beginTxn: true }), { type: 'end_txn' }]);
				await waitFor(() => failures.length === 1, { message: 'failure is observable' });
				assert.equal(failures[0].position, failed.timestamp);
				assert.equal(failures[0].nodeId, failed.nodeId);
				assert.equal(failures[0].table, failed.table ?? Table.tableName);
				assert.equal(pulls.length, 1, 'no event is pulled until every registered listener has been awaited');
				gate.resolve();
				await waitFor(async () => await Table.get('next'), { message: 'apply continues after notification' });
			} finally {
				gate.resolve();
			}
		});
	}

	it('logs throwing and rejecting listeners, then awaits later listeners outside the source transaction', async () => {
		const { Table, start } = fixture();
		const syncError = `sync listener failure ${serial}`;
		const asyncError = `async listener failure ${serial}`;
		listen(() => {
			throw new Error(syncError);
		});
		listen(async () => {
			throw new Error(asyncError);
		});
		let persisted = false;
		listen(async () => {
			await Table.put('hole', { id: 'hole' });
			persisted = true;
		});
		start([
			put('bad', { type: 'lockGrant', value: [], beginTxn: true }),
			put('next', { beginTxn: true }),
			{ type: 'end_txn' },
		]);
		await waitFor(async () => await Table.get('next'), { message: 'listener failures cannot stop apply' });
		assert.ok(persisted, 'the subsequent listener must finish its own durable transaction');
		assert.ok(await Table.get('hole'), 'listener write committed independently');
		await waitFor(
			() => {
				const text = fs
					.readdirSync(logRoot)
					.filter((name) => name.endsWith('.log'))
					.map((name) => fs.readFileSync(path.join(logRoot, name), 'utf8'))
					.join('\n');
				return (
					text.includes('replicated apply failure listener failed') &&
					text.includes(syncError) &&
					text.includes(asyncError)
				);
			},
			{ message: 'both listener failures logged' }
		);
	});

	it('isolates databases, deduplicates registration, and unregisters only the named listener', async () => {
		const { Table, start } = fixture();
		const calls = [];
		const removed = () => calls.push('removed');
		const retained = () => calls.push('retained');
		listen(removed);
		listen(retained);
		listen(retained);
		listen(() => calls.push('other'), 'other-apply-failures');
		unregister(DATABASE, removed);
		start([put('bad', { table: 'MissingTable' }), put('next')]);
		await waitFor(async () => await Table.get('next'));
		assert.deepStrictEqual(calls, ['retained']);
	});

	it('awaits the captured listener set even if an earlier listener unregisters another', async () => {
		const { Table, start } = fixture();
		const calls = [];
		const later = () => calls.push('later');
		listen(() => {
			calls.push('first');
			unregister(DATABASE, later);
		});
		listen(later);
		start([put('bad', { table: 'MissingTable' }), put('next')]);
		await waitFor(async () => await Table.get('next'));
		assert.deepStrictEqual(calls, ['first', 'later']);
	});

	it('clears listeners when their database is removed', async () => {
		const database = 'removed-apply-failures';
		let calls = 0;
		table({ database, table: 'BeforeDrop', attributes: [{ name: 'id', isPrimaryKey: true }] });
		listen(() => calls++, database);
		await dropDatabase(database);
		await notifyReplicatedApplyFailure(database, { nodeId: 21 }, Date.now(), new Error('after removal'));
		assert.equal(calls, 0);
	});

	it('does not report cache versions or successful writes with a failing onCommit as apply holes', async () => {
		const { Table, start } = fixture();
		const failures = [];
		listen((failure) => failures.push(failure));
		start([
			put('bad', { timestamp: undefined, version: Date.now(), table: 'MissingTable' }),
			put('committed', {
				onCommit() {
					throw new Error('post-commit callback failed');
				},
			}),
			put('next'),
		]);
		await waitFor(async () => await Table.get('next'));
		assert.ok(await Table.get('committed'));
		assert.deepStrictEqual(failures, []);
	});
});
