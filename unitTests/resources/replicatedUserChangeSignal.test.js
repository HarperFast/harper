const assert = require('node:assert');
const { setImmediate: yieldMacrotask } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { databases, table } = require('#src/resources/databases');
const {
	registerReplicatedApplyFailureListener,
	unregisterReplicatedApplyFailureListener,
} = require('#src/resources/replicatedApplyFailure');
const { getUsersWithRolesCache } = require('#src/security/user');
const { userHandler } = require('#js/server/itc/serverHandlers');
const { UserEventMsg } = require('#js/server/threads/itc');
const ITCEventObject = require('#js/server/itc/utility/ITCEventObject');
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
const { waitFor } = require('../waitFor');

function deferred() {
	let resolve;
	const promise = new Promise((yes) => (resolve = yes));
	return { promise, resolve };
}

let serial = 0;
let userChanges = 0;
let countUserChanges = false;
userHandler.addListener(() => {
	if (countUserChanges) userChanges++;
});

/**
 * Resolves with the number of user changes handled so far, once every one signalled before the call has
 * rebuilt the cache and run its listeners (it runs one more change itself, which it does not count).
 */
async function settledUserChanges() {
	await userHandler(new ITCEventObject(ITC_EVENT_TYPES.USER, new UserEventMsg(process.pid)));
	return userChanges - 1;
}

// A replicated system-database commit that writes hdb_user or hdb_role signals a user change, which
// runs userHandler on every thread; these drive the real signal and handler, with one thread.
describe('replicated system-database apply: user-change signal', function () {
	this.timeout(10000);
	let unhandled;
	const onUnhandled = (reason) => unhandled.push(reason);
	let applyFailures;
	const onApplyFailure = (failure) => applyFailures.push(failure);
	const subscriptions = [];
	const createdUsers = [];
	const createdNodes = [];

	before(async () => {
		setupTestDBPath();
		const systemTables = {
			hdb_role: [{ name: 'id', isPrimaryKey: true }, { name: 'role', indexed: true }, { name: 'permission' }],
			hdb_user: [{ name: 'username', isPrimaryKey: true }, { name: 'role' }, { name: 'active' }],
			hdb_nodes: [{ name: 'name', isPrimaryKey: true }],
		};
		for (const [name, attributes] of Object.entries(systemTables)) {
			if (!databases.system?.[name]) table({ database: 'system', table: name, attributes, audit: true });
		}
		await databases.system.hdb_role.put({ id: 'super_user', role: 'super_user', permission: { super_user: true } });
	});

	beforeEach(() => {
		unhandled = [];
		applyFailures = [];
		process.on('unhandledRejection', onUnhandled);
		registerReplicatedApplyFailureListener('system', onApplyFailure);
		userChanges = 0;
		countUserChanges = true;
	});

	afterEach(async () => {
		countUserChanges = false;
		for (const { held, done } of subscriptions.splice(0)) {
			held.resolve();
			await done.promise;
		}
		unregisterReplicatedApplyFailureListener('system', onApplyFailure);
		process.off('unhandledRejection', onUnhandled);
		for (const username of createdUsers.splice(0)) await databases.system.hdb_user.delete(username);
		for (const name of createdNodes.splice(0)) await databases.system.hdb_nodes.delete(name);
	});

	/** Runs `events` through a replicated-apply subscription on the system database. */
	function applyFromSource(events) {
		const held = deferred();
		const done = deferred();
		let drained = false;
		databases.system.hdb_nodes.sourcedFrom(
			{
				name: `user-change-signal-source-${++serial}`,
				subscribeOnThisThread: () => true,
				async *subscribe() {
					try {
						for (const event of events) yield event;
						// only pulled again once the loop has awaited the last commit
						drained = true;
						await held.promise;
					} finally {
						done.resolve();
					}
				},
			},
			{ intermediateSource: true }
		);
		subscriptions.push({ held, done });
		return waitFor(() => drained, { message: 'every source event was applied' });
	}

	function userPut(username, extra = {}) {
		createdUsers.push(username);
		return Object.assign(
			{
				type: 'put',
				table: 'hdb_user',
				id: username,
				value: { username, role: 'super_user', active: true },
				nodeId: 21,
				timestamp: Date.now(),
			},
			extra
		);
	}

	function nodePut(name, extra = {}) {
		createdNodes.push(name);
		return Object.assign(
			{ type: 'put', table: 'hdb_nodes', id: name, value: { name }, nodeId: 21, timestamp: Date.now() },
			extra
		);
	}

	/** Fails the commit of `event` by staging a write whose before-commit hook rejects with `error`. */
	function failCommit(event, error) {
		event.finished = {
			then(resolve) {
				let transaction = event.transaction;
				while (!transaction.db && transaction.next) transaction = transaction.next;
				transaction.addWrite({
					key: `${event.id}-failure`,
					store: databases.system.hdb_user.primaryStore,
					deferSave: true,
					before: () => Promise.reject(error),
					commit() {},
				});
				resolve();
			},
		};
		return event;
	}

	it('signals once for a user write, not again for later non-user commits on the subscription', async () => {
		const id = ++serial;
		const username = `signal_user_${id}`;
		await applyFromSource([
			userPut(username),
			nodePut(`signal-node-${id}-a`),
			nodePut(`signal-node-${id}-b`),
			nodePut(`signal-node-${id}-c`),
		]);
		assert.ok(await databases.system.hdb_nodes.get(`signal-node-${id}-c`), 'the later system commits applied');
		assert.strictEqual(await settledUserChanges(), 1);
		assert.ok((await getUsersWithRolesCache()).has(username), 'the signal rebuilt the user cache');
	});

	it('does not signal or leave an unhandled rejection when a user-write commit fails', async () => {
		const id = ++serial;
		const error = new Error('injected replicated commit failure');
		await applyFromSource([failCommit(userPut(`failed_user_${id}`), error), nodePut(`after-failure-node-${id}`)]);
		assert.ok(await databases.system.hdb_nodes.get(`after-failure-node-${id}`), 'apply continued past the failure');
		assert.equal(await databases.system.hdb_user.get(`failed_user_${id}`), undefined);
		assert.strictEqual(applyFailures.length, 1, 'the apply loop still reports the failed commit');
		assert.strictEqual(applyFailures[0].error, error);
		// unhandledRejection is emitted after the microtask queue drains
		await yieldMacrotask();
		await yieldMacrotask();
		assert.deepStrictEqual(unhandled, []);
		assert.strictEqual(await settledUserChanges(), 0);
	});

	it('signals for a begin_txn transaction whose user write is staged after its first write', async () => {
		const id = ++serial;
		const username = `txn_user_${id}`;
		await applyFromSource([nodePut(`txn-node-${id}`, { beginTxn: true }), userPut(username), { type: 'end_txn' }]);
		assert.ok(await databases.system.hdb_user.get(username), 'the transaction committed');
		assert.strictEqual(await settledUserChanges(), 1);
		assert.ok((await getUsersWithRolesCache()).has(username));
	});

	it('does not signal for a dropped user-table event', async () => {
		const id = ++serial;
		const username = `dropped_user_${id}`;
		await applyFromSource([userPut(username, { type: 'invalid-operation' }), nodePut(`after-drop-node-${id}`)]);
		assert.ok(await databases.system.hdb_nodes.get(`after-drop-node-${id}`));
		assert.strictEqual(applyFailures.length, 1, 'the drop is reported');
		assert.strictEqual(await settledUserChanges(), 0);
	});
});
