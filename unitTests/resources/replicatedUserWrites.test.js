const assert = require('node:assert');
const { setImmediate: yieldMacrotask } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { databases, table } = require('#src/resources/databases');
const {
	registerReplicatedApplyFailureListener,
	unregisterReplicatedApplyFailureListener,
} = require('#src/resources/replicatedApplyFailure');
const { findAndValidateUser, getUserWithRole, onUserChange } = require('#src/security/user');
const { waitFor } = require('../waitFor');

function deferred() {
	let resolve;
	const promise = new Promise((yes) => (resolve = yes));
	return { promise, resolve };
}

let serial = 0;
let userChanges = 0;
onUserChange(() => userChanges++);

async function noFurtherUserChange(since) {
	// a non-event: give the audit-log notify pass and its setImmediate fan-out time to run
	for (let i = 0; i < 5; i++) await yieldMacrotask();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.strictEqual(userChanges, since, 'no user change was notified');
}

describe('replicated system-database apply: user and role writes', function () {
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
		await databases.system.hdb_role.put({ id: 'replicated_role', role: 'replicated_role', permission: {} });
	});

	after(async () => {
		await databases.system.hdb_role.delete('replicated_role');
	});

	beforeEach(() => {
		unhandled = [];
		applyFailures = [];
		process.on('unhandledRejection', onUnhandled);
		registerReplicatedApplyFailureListener('system', onApplyFailure);
	});

	afterEach(async () => {
		for (const { held, done } of subscriptions.splice(0)) {
			held.resolve();
			await done.promise;
		}
		unregisterReplicatedApplyFailureListener('system', onApplyFailure);
		process.off('unhandledRejection', onUnhandled);
		for (const username of createdUsers.splice(0)) await databases.system.hdb_user.delete(username);
		for (const name of createdNodes.splice(0)) await databases.system.hdb_nodes.delete(name);
	});

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

	function rolePut(id, permission) {
		return {
			type: 'put',
			table: 'hdb_role',
			id,
			value: { id, role: id, permission },
			nodeId: 21,
			timestamp: Date.now(),
		};
	}

	it('makes a replicated user write visible to the next lookup, and notifies user-change listeners', async () => {
		const username = `replicated_user_${++serial}`;
		const before = userChanges;
		await applyFromSource([userPut(username)]);
		const user = await findAndValidateUser(username, null, false);
		assert.strictEqual(user.role?.permission.super_user, true, 'the lookup reads the committed record');
		await waitFor(() => userChanges > before, { message: 'a user-change listener ran' });
	});

	it('does not notify for later non-user commits on the subscription', async () => {
		const id = ++serial;
		const before = userChanges;
		await applyFromSource([userPut(`quiet_user_${id}`)]);
		await waitFor(() => userChanges > before, { message: 'the user write notified' });
		const settled = userChanges;
		await applyFromSource([
			nodePut(`quiet-node-${id}-a`),
			nodePut(`quiet-node-${id}-b`),
			nodePut(`quiet-node-${id}-c`),
		]);
		assert.ok(await databases.system.hdb_nodes.get(`quiet-node-${id}-c`), 'the later system commits applied');
		await noFurtherUserChange(settled);
	});

	it('applies a replicated role change to the next lookup of a user holding it', async () => {
		const username = `role_holder_${++serial}`;
		await applyFromSource([userPut(username, { value: { username, role: 'replicated_role', active: true } })]);
		assert.notStrictEqual(getUserWithRole(username).role.permission.super_user, true);
		await applyFromSource([rolePut('replicated_role', { super_user: true })]);
		assert.strictEqual(getUserWithRole(username).role.permission.super_user, true);
		await applyFromSource([rolePut('replicated_role', {})]);
		assert.notStrictEqual(getUserWithRole(username).role.permission.super_user, true);
	});

	it('leaves no user, notification, or unhandled rejection when a user-write commit fails', async () => {
		const id = ++serial;
		const error = new Error('injected replicated commit failure');
		const before = userChanges;
		await applyFromSource([failCommit(userPut(`failed_user_${id}`), error), nodePut(`after-failure-node-${id}`)]);
		assert.ok(await databases.system.hdb_nodes.get(`after-failure-node-${id}`), 'apply continued past the failure');
		assert.strictEqual(getUserWithRole(`failed_user_${id}`), undefined);
		assert.strictEqual(applyFailures.length, 1, 'the apply loop still reports the failed commit');
		assert.strictEqual(applyFailures[0].error, error);
		// also long enough for an unhandledRejection, which is emitted after the microtask queue drains
		await noFurtherUserChange(before);
		assert.deepStrictEqual(unhandled, []);
	});

	it('makes a user staged late in a begin_txn transaction visible once it commits', async () => {
		const id = ++serial;
		const username = `txn_user_${id}`;
		await applyFromSource([nodePut(`txn-node-${id}`, { beginTxn: true }), userPut(username), { type: 'end_txn' }]);
		assert.ok(getUserWithRole(username), 'the transaction committed and the lookup sees it');
	});
});
