const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { contextStorage } = require('#src/resources/transaction');
const { getSession, replayLastWill } = require('#src/server/DurableSubscriptionsSession');
const { server } = require('#src/server/Server');
const { localPrincipal } = require('#src/security/user');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');

let sequence = 0;
function topicTable() {
	const name = `WillTopic${++sequence}`;
	const database = `will_${name}`;
	const T = table({
		table: name,
		database,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	Resources.resources.set(name, T, { mqtt: true });
	const role = (canPublish) => ({
		role: `${name}-${canPublish ? 'publisher' : 'reader'}`,
		permission: {
			super_user: false,
			[database]: {
				tables: {
					[name]: { read: true, insert: canPublish, update: canPublish, delete: false, attribute_permissions: [] },
				},
			},
		},
	});
	return {
		T,
		name,
		publisher: { username: `${name}-publisher`, role: role(true) },
		reader: { username: `${name}-reader`, role: role(false) },
	};
}

const willRows = async (clientId) => {
	const rows = [];
	for await (const will of databases.system.hdb_session_will.search({})) if (will.id[0] === clientId) rows.push(will);
	return rows;
};

function spyWills(methods) {
	const wills = databases.system.hdb_session_will;
	const original = Object.fromEntries(methods.map((method) => [method, wills[method]]));
	const own = methods.filter((method) => Object.hasOwn(wills, method));
	const calls = [];
	for (const method of methods)
		wills[method] = function (...args) {
			calls.push(method);
			return original[method].apply(this, args);
		};
	return {
		calls,
		restore() {
			for (const method of methods) {
				if (own.includes(method)) wills[method] = original[method];
				else delete wills[method];
			}
		},
	};
}

async function connectWithWill(name, user, clientId, value) {
	const will = { topic: `${name}/${clientId}`, data: { value }, qos: 0, retain: true };
	const session = await getSession({ clientId, user, clean: true, will });
	assert.strictEqual((await willRows(clientId)).length, 1, 'the will is stored once the CONNECT is accepted');
	return session;
}

describe('MQTT last will authorization', function () {
	this.timeout(30_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	it('publishes the will of a non-super user who may publish to its topic', async () => {
		const { T, name, publisher } = topicTable();
		const session = await connectWithWill(name, publisher, 'publisher', 1);
		session.disconnect(false);
		await waitFor(async () => (await T.get('publisher'))?.value === 1, { message: 'the will was published' });
		await waitFor(async () => (await willRows('publisher')).length === 0, { message: 'the will row was deleted' });
	});

	it('does not publish a will its user may not publish, and still deletes the will row', async () => {
		const { T, name, reader } = topicTable();
		const session = await connectWithWill(name, reader, 'reader', 2);
		session.disconnect(false);
		await waitFor(async () => (await willRows('reader')).length === 0, { message: 'the will row was deleted' });
		assert.strictEqual((await T.get('reader'))?.value, undefined, 'the will was not published');
	});

	it('does not publish the will on a clean DISCONNECT, and deletes the will row without reading it', async () => {
		const { T, name, publisher } = topicTable();
		const session = await connectWithWill(name, publisher, 'clean', 3);
		const spy = spyWills(['get']);
		try {
			session.disconnect(true);
			await waitFor(async () => (await willRows('clean')).length === 0, { message: 'the will row was deleted' });
		} finally {
			spy.restore();
		}
		assert.strictEqual((await T.get('clean'))?.value, undefined, 'the will was not published');
		assert.deepStrictEqual(spy.calls, []);
	});

	it('settles a will once, however many times its session disconnects', async () => {
		const { T, name, publisher } = topicTable();
		const session = await connectWithWill(name, publisher, 'twice', 4);
		const spy = spyWills(['get', 'delete']);
		try {
			session.disconnect(false);
			session.disconnect(false);
			await waitFor(async () => (await willRows('twice')).length === 0, { message: 'the will row was deleted' });
		} finally {
			spy.restore();
		}
		assert.strictEqual((await T.get('twice'))?.value, 4);
		assert.deepStrictEqual(spy.calls, ['get', 'delete']);
	});

	it('publishes a scoped token’s will under its own role, and drops it once the token expires', async () => {
		const { T, name, publisher, reader } = topicTable();
		const inAnHour = Math.floor(Date.now() / 1000) + 3600;
		const scoped = (user, authExpiresAt) => ({ ...user, _scopedToken: true, authExpiresAt });
		const sessions = [
			await connectWithWill(name, scoped(publisher, inAnHour), 'scoped-live', 5),
			await connectWithWill(name, scoped(publisher, Math.floor(Date.now() / 1000) - 1), 'scoped-expired', 6),
			await connectWithWill(name, scoped(reader, inAnHour), 'scoped-denied', 7),
		];
		// each session's own user would decide the publish the other way, so only the will's role and expiry can
		sessions[0].user = reader;
		sessions[1].user = publisher;
		sessions[2].user = publisher;
		for (const session of sessions) session.disconnect(false);
		await waitFor(async () => (await T.get('scoped-live'))?.value === 5, { message: 'the live will was published' });
		for (const clientId of ['scoped-live', 'scoped-expired', 'scoped-denied'])
			await waitFor(async () => (await willRows(clientId)).length === 0, { message: `${clientId}'s row was deleted` });
		assert.strictEqual((await T.get('scoped-expired'))?.value, undefined, 'the expired token’s will was not published');
		assert.strictEqual(
			(await T.get('scoped-denied'))?.value,
			undefined,
			'a role that may not publish does not publish'
		);
	});

	it('stores a local connection’s will without a stored user, and replays it after a restart as the local principal', async () => {
		const { T, name } = topicTable();
		await connectWithWill(name, localPrincipal(), 'local-will', 9);
		const [row] = await willRows('local-will');
		assert.deepStrictEqual(row.user, { username: 'local', _localPrincipal: true });
		const getUser = server.getUser;
		server.getUser = () => {
			throw new Error('a local will must not be resolved by name');
		};
		try {
			await replayLastWill(row);
		} finally {
			server.getUser = getUser;
		}
		assert.strictEqual((await T.get('local-will'))?.value, 9);
		assert.deepStrictEqual(await willRows('local-will'), []);
	});

	it('settles the will row the same under an ambient context that requests authorization', async () => {
		const { T, name, publisher, reader } = topicTable();
		const session = await connectWithWill(name, publisher, 'ambient', 8);
		contextStorage.run({ user: reader, authorize: true }, () => session.disconnect(false));
		await waitFor(async () => (await T.get('ambient'))?.value === 8, { message: 'the will was published' });
		await waitFor(async () => (await willRows('ambient')).length === 0, { message: 'the will row was deleted' });
	});

	it('does not touch the will table for a session that set no will', async () => {
		const session = await getSession({ clientId: 'no-will', user: undefined, clean: true });
		const spy = spyWills(['get', 'delete', 'put', 'search']);
		try {
			session.disconnect(false);
			await new Promise((resolve) => setTimeout(resolve, 50));
		} finally {
			spy.restore();
		}
		assert.deepStrictEqual(spy.calls, []);
	});
});
