'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const jwt = require('jsonwebtoken');
const { generate, parser: mqttParser } = require('mqtt-packet');
const testUtils = require('../testUtils.js');
const { waitFor } = require('../waitFor');
const { databases, table } = require('#src/resources/databases');
const password = require('#src/utility/password');
const { Headers } = require('#src/server/serverHelpers/Headers');
const user = require('#src/security/user');
const tokenAuthentication = require('#src/security/tokenAuthentication');
const { authentication } = require('#src/security/auth');
const mqtt = require('#src/server/mqtt');
const { runStartup } = require('#src/utility/lifecycle');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { _liveSubscriptionCount, _sweepNow, _tickNow } = require('#src/server/liveSubscriptionAuth');
const { hdbErrors } = require('#src/utility/errors/hdbError');
const { AUTHENTICATION_ERROR_MSGS, HDB_ERROR_MSGS } = hdbErrors;

const PASSWORD = 'local-principal-password';
const storedUser = (username, role, overrides = {}) => ({
	username,
	active: true,
	password: password.hash(PASSWORD, password.HASH_FUNCTION.SHA256),
	hash_function: password.HASH_FUNCTION.SHA256,
	role,
	...overrides,
});
const decode = (token) => jwt.decode(token, { json: true });

function domainSocketRequest(headerObject = {}) {
	return {
		method: 'GET',
		url: '/',
		pathname: '/',
		ip: undefined,
		headers: { asObject: { host: 'example.com', ...headerObject }, get: (name) => headerObject[name.toLowerCase()] },
		peerCertificate: { subject: null },
		_nodeRequest: { socket: { server: { _pipeName: '/run/harper/operations-server', bypassLocalAuth: true } } },
	};
}

function remoteRequest(headerObject = {}) {
	return {
		method: 'GET',
		url: '/',
		pathname: '/',
		ip: '203.0.113.7',
		headers: { asObject: { host: 'example.com', ...headerObject }, get: (name) => headerObject[name.toLowerCase()] },
		peerCertificate: { subject: null },
	};
}

async function authenticate(request, handler = () => {}) {
	let seen;
	const response = await authentication(request, async (authenticated) => {
		seen = authenticated.user;
		await handler(authenticated);
		return { status: 200, headers: new Headers() };
	});
	return { user: seen, response };
}

function countRecordReads() {
	const stores = [databases.system.hdb_user.primaryStore, databases.system.hdb_role.primaryStore];
	const originals = stores.map((store) => store.getEntry);
	const counter = { reads: 0 };
	stores.forEach((store, i) => {
		store.getEntry = function (...args) {
			counter.reads++;
			return originals[i].apply(this, args);
		};
	});
	counter.restore = () => stores.forEach((store, i) => (store.getEntry = originals[i]));
	return counter;
}

describe('the local principal of a request trusted by its transport', function () {
	let removeJwtKeys;

	before(async () => {
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		await testUtils.ensureSystemTables();
		await runStartup();
		setMainIsWorker(true);
		removeJwtKeys = testUtils.installTestJwtKeys();
		tokenAuthentication.clearJWTRSAKeysCache();
	});

	after(() => {
		removeJwtKeys?.();
		tokenAuthentication.clearJWTRSAKeysCache();
	});

	afterEach(() => testUtils.seedUsers());

	describe('the principal', () => {
		it('is a super user named local with the system-table permissions of a stored super user', () => {
			const principal = user.localPrincipal();
			assert.strictEqual(principal.username, user.LOCAL_USERNAME);
			assert.strictEqual(principal.username, 'local');
			assert.strictEqual(principal.active, true);
			assert.strictEqual(principal.role.role, 'super_user');
			assert.strictEqual(principal.role.id, 'super_user');
			assert.strictEqual(principal.role.permission.super_user, true);
			assert.strictEqual(principal.role.permission.system.tables.hdb_user.read, true);
			assert.strictEqual(principal.role.permission.system.tables.hdb_user.insert, false);
			assert.strictEqual(user.isLocalPrincipal(principal), true);
		});

		it('gives each call its own user, role and permission, and shares only a frozen system-table tree', () => {
			const first = user.localPrincipal();
			const second = user.localPrincipal();
			assert.notStrictEqual(first, second);
			assert.notStrictEqual(first.role, second.role);
			assert.notStrictEqual(first.role.permission, second.role.permission);
			first.role.permission = { super_user: false };
			first.role.role = 'changed';
			first.username = 'changed';
			const third = user.localPrincipal();
			for (const principal of [second, third]) {
				assert.strictEqual(principal.username, 'local');
				assert.strictEqual(principal.role.role, 'super_user');
				assert.strictEqual(principal.role.permission.super_user, true);
			}
			assert.ok(Object.isFrozen(second.role.permission.system.tables.hdb_user));
			assert.throws(() => {
				second.role.permission.system.tables.hdb_user.insert = true;
			}, TypeError);
		});

		it('is recognized by its marker, never by its name', async () => {
			assert.strictEqual(
				user.isLocalPrincipal({ username: 'local', role: { role: 'super_user', permission: { super_user: true } } }),
				false
			);
			assert.strictEqual(user.isLocalPrincipal({ ...user.localPrincipal(), username: 'admin' }), false);
			assert.strictEqual(user.isLocalPrincipal(JSON.parse(JSON.stringify(user.localPrincipal()))), true);
			await testUtils.seedUsers([storedUser('local', { role: 'local_role', permission: { super_user: false } })]);
			assert.strictEqual(user.isLocalPrincipal(await user.findAndValidateUser('local', PASSWORD)), false);
			assert.strictEqual(user.isLocalPrincipal(user.getUserWithRole('local')), false);
		});

		it('user_info describes the principal without a role lookup', async () => {
			assert.deepStrictEqual(await user.userInfo({ hdb_user: user.localPrincipal() }), {
				username: 'local',
				active: true,
				role: {
					role: 'super_user',
					id: 'super_user',
					permission: { super_user: true },
					__createdtime__: 0,
					__updatedtime__: 0,
				},
			});
		});
	});

	describe('authentication', () => {
		it('authorizes the operations domain socket as the local principal without reading a user record', async () => {
			const reads = countRecordReads();
			let first, second;
			try {
				({ user: first } = await authenticate(domainSocketRequest()));
				({ user: second } = await authenticate(domainSocketRequest()));
			} finally {
				reads.restore();
			}
			assert.strictEqual(reads.reads, 0);
			assert.strictEqual(user.isLocalPrincipal(first), true);
			assert.notStrictEqual(first, second, 'each request gets its own principal');
		});

		it('authorizes the domain socket with no stored users, and with an admin role of another name', async () => {
			const users = [];
			for await (const record of databases.system.hdb_user.search([])) users.push({ ...record, active: false });
			users.push(storedUser('ops_admin', { role: 'ops_admin', permission: { super_user: true } }));
			await testUtils.seedUsers(users);
			assert.strictEqual(user.isLocalPrincipal((await authenticate(domainSocketRequest())).user), true);
		});

		for (const [what, sessionUser] of [
			['its username', (request) => request.user.username],
			['a copy of it', (request) => JSON.parse(JSON.stringify(request.user))],
		])
			it(`keeps the principal out of the session row given ${what}, so the cookie authenticates nobody elsewhere`, async () => {
				const { user: principal, response } = await authenticate(domainSocketRequest(), (request) =>
					request.session.update({ user: sessionUser(request), cart: ['widget'] })
				);
				assert.strictEqual(user.isLocalPrincipal(principal), true);
				const cookie = response.headers.get('Set-Cookie').split(';')[0];
				const sessionId = cookie.slice(cookie.indexOf('=') + 1);
				const session = await databases.system.hdb_session.get(sessionId);
				assert.deepStrictEqual(session.cart, ['widget'], 'the rest of the session is kept');
				assert.strictEqual(session.user, undefined);
				const replayed = await authenticate(remoteRequest({ cookie }));
				assert.strictEqual(replayed.user, undefined);
				const local = await authenticate(domainSocketRequest({ cookie }));
				assert.strictEqual(user.isLocalPrincipal(local.user), true, 'the cookie does not displace local trust');
				await databases.system.hdb_session.delete(sessionId);
			});

		it('still persists a stored user who logs in over a local connection', async () => {
			const { response } = await authenticate(domainSocketRequest(), (request) => request.login('admin', 'password'));
			const cookie = response.headers.get('Set-Cookie').split(';')[0];
			const sessionId = cookie.slice(cookie.indexOf('=') + 1);
			// request.login does not wait for its session write
			await waitFor(async () => (await databases.system.hdb_session.get(sessionId))?.user === 'admin');
			const replayed = await authenticate(remoteRequest({ cookie }));
			assert.strictEqual(replayed.user.username, 'admin');
			assert.strictEqual(user.isLocalPrincipal(replayed.user), false);
			await databases.system.hdb_session.delete(sessionId);
		});
	});

	describe('the reserved name', () => {
		it('add_user refuses to create a user named local', async () => {
			await assert.rejects(
				user.addUser({ username: 'local', password: PASSWORD, role: 'super_user', active: true }),
				(error) => error.statusCode === 400 && error.message === HDB_ERROR_MSGS.RESERVED_USERNAME('local')
			);
			assert.strictEqual(await databases.system.hdb_user.get('local'), null);
		});

		it('leaves an existing stored local user an ordinary user that can be altered and dropped', async () => {
			await testUtils.seedUsers([storedUser('local', { role: 'local_role', permission: { super_user: false } })]);
			const { operation_token } = await tokenAuthentication.createTokens({ username: 'local', password: PASSWORD });
			const bearer = await tokenAuthentication.validateOperationToken(operation_token);
			assert.strictEqual(bearer.username, 'local');
			assert.strictEqual(bearer.role.role, 'local_role');
			assert.strictEqual(user.isLocalPrincipal(bearer), false);
			await user.alterUser({ username: 'local', password: 'rotated-password' });
			await user.findAndValidateUser('local', 'rotated-password');
			await user.alterUser({ username: 'local', active: false });
			await assert.rejects(user.findAndValidateUser('local', 'rotated-password'));
			await user.dropUser({ username: 'local' });
			assert.strictEqual(await databases.system.hdb_user.get('local'), null);
		});
	});

	describe('create_authentication_tokens from the local principal', () => {
		// admin is deactivated in place: seedUsers would repair an unusable admin before restoring it, and
		// the repair refuses a second role named super_user
		async function seedAdmins() {
			await testUtils.seedUsers([
				storedUser('named_like_admin', {
					role: 'super_user',
					id: 'not_actually_super',
					permission: { super_user: false },
				}),
				storedUser('ops_admin', { role: 'ops_admin', permission: { super_user: true } }),
			]);
			await databases.system.hdb_user.patch('admin', { active: false });
		}
		afterEach(() => databases.system.hdb_user.patch('admin', { active: true }));

		it('mints for an active stored user whose role grants super_user by flag, with a refresh token', async () => {
			await seedAdmins();
			const tokens = await tokenAuthentication.createTokens({ hdb_user: user.localPrincipal(), expires_in: '5m' });
			const claims = decode(tokens.operation_token);
			assert.strictEqual(claims.username, 'ops_admin');
			assert.strictEqual(claims.super_user, true);
			assert.strictEqual(claims.exp - claims.iat, 300);
			const bearer = await tokenAuthentication.validateOperationToken(tokens.operation_token);
			assert.strictEqual(bearer.username, 'ops_admin');
			assert.strictEqual(user.isLocalPrincipal(bearer), false);
			const refreshed = await tokenAuthentication.validateRefreshToken(tokens.refresh_token);
			assert.strictEqual(refreshed.username, 'ops_admin');
		});

		it('mints a login token for the same user', async () => {
			await seedAdmins();
			const { operation_token } = await tokenAuthentication.createTokens({
				hdb_user: user.localPrincipal(),
				purpose: 'login',
			});
			assert.strictEqual((await tokenAuthentication.validateLoginToken(operation_token)).username, 'ops_admin');
		});

		it('fails clearly when no active stored super user exists', async () => {
			const users = [];
			for await (const record of databases.system.hdb_user.search([])) users.push({ ...record, active: false });
			await testUtils.seedUsers(users);
			await assert.rejects(
				tokenAuthentication.createTokens({ hdb_user: user.localPrincipal() }),
				(error) => error.statusCode === 409 && error.message === AUTHENTICATION_ERROR_MSGS.NO_USER_TO_MINT_FOR
			);
		});

		it('still requires a password to mint for a named user', async () => {
			await seedAdmins();
			await assert.rejects(
				tokenAuthentication.createTokens({ hdb_user: user.localPrincipal(), username: 'ops_admin' }),
				(error) => error.statusCode === 401
			);
		});

		it('does not resolve a stored super user for a principal-shaped object without the marker', async () => {
			await seedAdmins();
			const lookalike = {
				username: 'local',
				active: true,
				role: { role: 'super_user', permission: { super_user: true } },
			};
			await assert.rejects(
				tokenAuthentication.createTokens({ hdb_user: lookalike }),
				(error) => error.message !== AUTHENTICATION_ERROR_MSGS.NO_USER_TO_MINT_FOR
			);
		});

		it('mints a scoped token attributed to local, as it does for a named super user', async () => {
			await seedAdmins();
			const role = { permission: { operations: ['read_only'] } };
			const fromLocal = await tokenAuthentication.createTokens({ hdb_user: user.localPrincipal(), role });
			assert.strictEqual(decode(fromLocal.operation_token).minted_by, 'local');
			assert.strictEqual(decode(fromLocal.operation_token).username, 'scoped:local');
			const scopedBearer = await tokenAuthentication.validateOperationToken(fromLocal.operation_token);
			assert.strictEqual(scopedBearer._scopedToken, true);
			assert.strictEqual(scopedBearer.role.permission.super_user, false);
			const opsAdmin = await user.findAndValidateUser('ops_admin', PASSWORD);
			const fromNamed = await tokenAuthentication.createTokens({ hdb_user: opsAdmin, role });
			assert.strictEqual(decode(fromNamed.operation_token).minted_by, 'ops_admin');
			assert.strictEqual(
				(await tokenAuthentication.validateOperationToken(fromNamed.operation_token)).username,
				'scoped:ops_admin'
			);
		});
	});

	describe('live subscriptions', () => {
		let Records;
		before(() => {
			Records = class extends (
				table({
					table: 'LocalPrincipalRecords',
					database: 'local_principal',
					audit: true,
					attributes: [{ name: 'id', isPrimaryKey: true }],
				})
			) {
				static loadAsInstance = false;
			};
		});

		it('are not re-authorized against user records, so user changes and ticks leave them open', async () => {
			const registered = _liveSubscriptionCount();
			const subscription = await Records.subscribe({ omitCurrent: true }, undefined, {
				user: user.localPrincipal(),
				authorize: true,
			});
			try {
				assert.strictEqual(_liveSubscriptionCount(), registered);
				await testUtils.seedUsers([storedUser('local', { role: 'local_role', permission: { super_user: false } })]);
				await _sweepNow();
				await _tickNow();
				assert.strictEqual(subscription.closed, false);
			} finally {
				subscription.end();
			}
		});
	});

	describe('MQTT over TCP', () => {
		let restoreAuthorizeLocal;
		before(() => (restoreAuthorizeLocal = mqtt.bypassAuth()));
		after(() => restoreAuthorizeLocal());

		async function connectOverTcp(remoteAddress, clientId) {
			let listener;
			const server = { socket: (fn) => ((listener = fn), {}) };
			mqtt.handleApplication({
				options: { getAll: () => ({ network: { port: 1883 }, requireAuthentication: true }) },
				server,
			});
			let session;
			server.mqtt.events.once('connected', (connected) => (session = connected));
			const socket = new EventEmitter();
			socket.remoteAddress = remoteAddress;
			socket.sends = [];
			socket.write = (message) => socket.sends.push(message);
			socket.end = socket.destroy = () => {};
			await listener(socket);
			socket.emit('data', generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 5, clientId, clean: true }));
			try {
				const connack = await waitFor(() => {
					const packets = [];
					const parser = mqttParser({ protocolVersion: 5 });
					parser.on('packet', (packet) => packets.push(packet));
					for (const sent of socket.sends) parser.parse(sent);
					return packets.find((packet) => packet.cmd === 'connack');
				});
				return { connack, session };
			} finally {
				socket.emit('close');
			}
		}

		for (const address of ['127.0.0.1', '::1']) {
			it(`connects from ${address} with no credentials as the local principal`, async () => {
				const { connack, session } = await connectOverTcp(address, `local-tcp-${address}`);
				assert.strictEqual(connack.reasonCode, 0);
				assert.strictEqual(user.isLocalPrincipal(session.user), true);
			});
		}

		it('refuses the same CONNECT from any other address', async () => {
			const { connack, session } = await connectOverTcp('203.0.113.7', 'remote-tcp');
			assert.notStrictEqual(connack.reasonCode, 0);
			assert.strictEqual(session, undefined);
		});
	});
});
