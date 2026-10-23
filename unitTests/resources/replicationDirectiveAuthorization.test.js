const assert = require('node:assert');
const { Readable } = require('node:stream');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { handleApplication } = require('#src/server/REST');
const { replicationConfirmation: rocksReplicationConfirmation } = require('#src/resources/DatabaseTransaction');
const { replicationConfirmation: lmdbReplicationConfirmation } = require('#src/resources/LMDBTransaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const setReplicationConfirmation = isLMDB ? lmdbReplicationConfirmation : rocksReplicationConfirmation;

let mountCounter = 0;
function mountRest(resources) {
	let listener;
	handleApplication({
		resources,
		options: { getAll: () => ({ webSocket: false }) },
		routeFor: () => ({ host: undefined, urlPath: `/rest-replication-directives-${mountCounter++}` }),
		server: { http: (fn) => (listener = fn) },
	});
	return (request) => listener(request, () => ({ status: 404 }));
}

function restRequest(method, pathname, headerObject, { user, body } = {}) {
	const headers = { ...headerObject };
	let bodyStream;
	if (body) {
		const encoded = Buffer.from(JSON.stringify(body));
		headers['content-type'] = 'application/json';
		headers['content-length'] = String(encoded.length);
		bodyStream = Readable.from([encoded]);
	}
	return {
		method,
		url: pathname,
		pathname,
		ip: '203.0.113.7',
		user,
		body: bodyStream,
		headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] },
	};
}

const superUser = { username: 'admin', role: { permission: { super_user: true } } };
function memberWith(tablePermission) {
	return {
		username: 'member',
		role: {
			permission: {
				super_user: false,
				test: {
					tables: {
						ReplicationDirectiveAccounts: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [],
							...tablePermission,
						},
					},
				},
			},
		},
	};
}

describe('X-Replicate-To is honored only for a super user (harper#2898)', () => {
	let Accounts;
	let rest;
	let confirmations;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Accounts = table({
			table: 'ReplicationDirectiveAccounts',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		class Signup extends Resource {
			static loadAsInstance = false;
			async post(target) {
				await Accounts.put({ id: target.id, name: 'created' });
				return 'created';
			}
		}
		class Visit extends Resource {
			static loadAsInstance = false;
			async get(target) {
				await Accounts.put({ id: target.id, name: 'visited' });
				return 'visited';
			}
		}
		class PublicAccounts extends Accounts {
			allowCreate() {
				return true;
			}
		}
		const resources = new Resources();
		resources.set('Signup', Signup);
		resources.set('Visit', Visit);
		resources.set('PublicAccounts', PublicAccounts);
		resources.set('Accounts', Accounts);
		rest = mountRest(resources);
		confirmations = [];
		setReplicationConfirmation((databaseName, txnTime, count) => {
			confirmations.push(count);
		});
	});
	after(() => setReplicationConfirmation(undefined));
	beforeEach(() => {
		confirmations.length = 0;
	});

	for (const header of ['1;confirm=5', '0', 'node-1, node-2', '*']) {
		it(`rejects an anonymous X-Replicate-To: ${header} before the resource runs`, async () => {
			const id = `anonymous-${header}`;
			const response = await rest(restRequest('POST', `/Signup/${id}`, { 'x-replicate-to': header }));
			assert.strictEqual(response.status, 403);
			assert.equal(await Accounts.get(id), null, 'the write must not have happened');
			assert.deepStrictEqual(confirmations, []);
		});
	}

	it('rejects a non-super-user principal on an application resource', async () => {
		const user = memberWith({ insert: true });
		const response = await rest(restRequest('POST', '/Signup/member', { 'x-replicate-to': '1;confirm=1' }, { user }));
		assert.strictEqual(response.status, 403);
		assert.equal(await Accounts.get('member'), null);
	});

	it('rejects it on a GET that writes', async () => {
		const response = await rest(restRequest('GET', '/Visit/get-writer', { 'x-replicate-to': '0' }));
		assert.strictEqual(response.status, 403);
		assert.equal(await Accounts.get('get-writer'), null);
	});

	it('rejects it on a table whose allowCreate admits anonymous callers', async () => {
		const response = await rest(
			restRequest('POST', '/PublicAccounts/', { 'x-replicate-to': '0' }, { body: { id: 'public', name: 'p' } })
		);
		assert.strictEqual(response.status, 403);
		assert.equal(await Accounts.get('public'), null);
		const allowed = await rest(restRequest('POST', '/PublicAccounts/', {}, { body: { id: 'public', name: 'p' } }));
		assert.strictEqual(allowed.status, 201, 'the override still admits the write without the header');
		assert.strictEqual((await Accounts.get('public')).name, 'p');
	});

	it('rejects it on a table using its default permission checks', async () => {
		const user = memberWith({ insert: true });
		const response = await rest(
			restRequest('POST', '/Accounts/', { 'x-replicate-to': '0' }, { user, body: { id: 'default', name: 'd' } })
		);
		assert.strictEqual(response.status, 403);
		assert.equal(await Accounts.get('default'), null);
	});

	it('still serves the request without the header', async () => {
		const response = await rest(restRequest('POST', '/Signup/no-header', {}));
		assert.strictEqual(response.status, 200);
		assert.strictEqual((await Accounts.get('no-header')).name, 'created');
	});

	it('applies the directives for a super user', async () => {
		const response = await rest(
			restRequest('POST', '/Signup/admin', { 'x-replicate-to': '1;confirm=1' }, { user: superUser })
		);
		assert.strictEqual(response.status, 200);
		assert.strictEqual((await Accounts.get('admin')).name, 'created');
		// LMDB: transaction.ts sets the count on the generic root transaction, and the LMDB child the
		// write lands in does not inherit it, so the hook is never called.
		if (!isLMDB) assert.deepStrictEqual(confirmations, [1]);
	});

	it('trusts directives application code sets on a context, while table permissions still apply', async () => {
		const write = (user, id) => {
			const target = new RequestTarget('/');
			target.checkPermission = user.role.permission;
			return Accounts.post(target, { id, name: 'app' }, { user, replicateTo: 1 });
		};
		await write(memberWith({ insert: true }), 'app-set');
		assert.strictEqual((await Accounts.get('app-set')).name, 'app');
		await assert.rejects(
			async () => write(memberWith({ insert: false }), 'app-set-denied'),
			(error) => error.statusCode === 403
		);
		assert.equal(await Accounts.get('app-set-denied'), null);
	});
});
