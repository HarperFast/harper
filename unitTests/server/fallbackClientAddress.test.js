'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { Readable } = require('node:stream');

const {
	bunDelegateToNodeServer,
	httpServer,
	makeUwsHandler,
	registerFallbackServer,
	registerFastifyInstance,
} = require('#src/server/http');
const { clientAddressOf, handlePostRequest } = require('#src/server/serverHelpers/serverHandlers');
const { databases } = require('#src/resources/databases');
const terms = require('#src/utility/hdbTerms');

const PORT = 19451;
const TABLE = terms.SYSTEM_TABLE_NAMES.NETWORK_ACCESS_TABLE_NAME;
const SUPER_USER = { username: 'admin', role: { permission: { super_user: true } } };

// The lockout check requires a verified client address and rejects unknown injected peers.
describe('set_network_access caller address', () => {
	describe('clientAddressOf', () => {
		const pipeServer = { _pipeName: '/tmp/operations.sock', bypassLocalAuth: true };
		const nodeRequest = (ip, server = {}) => ({ baseRequest: { ip, _nodeRequest: { socket: { server } } } });

		it("uses the Node request's address, ignoring the header beside it", () => {
			const headers = { 'x-harper-internal-client-address': '10.0.0.1' };
			assert.strictEqual(clientAddressOf({ raw: nodeRequest('203.0.113.9'), headers }), '203.0.113.9');
		});
		it("is undefined only for Node's operations domain socket", () => {
			assert.strictEqual(clientAddressOf({ raw: nodeRequest(undefined, pipeServer), headers: {} }), undefined);
		});
		it('is null for a Node mirror request without a PROXY address, and an injected one without the header', () => {
			assert.strictEqual(
				clientAddressOf({ raw: nodeRequest(undefined, { isPerThreadSocket: true }), headers: {} }),
				null
			);
			assert.strictEqual(clientAddressOf({ raw: {}, headers: {} }), null);
		});
		it('never reads the header on a Node request, where nothing strips it from client input', () => {
			const headers = { 'x-harper-internal-client-address': '10.1.2.3' };
			assert.strictEqual(clientAddressOf({ raw: nodeRequest(undefined, { isPerThreadSocket: true }), headers }), null);
		});
	});

	describe('Bun injection into the real operation', () => {
		let injected, prior;
		const rows = new Map();
		const nodeServer = { bunFallback: 'client address' };
		before(async () => {
			await testUtils.ensureSystemTables();
			prior = databases.system[TABLE];
			databases.system[TABLE] = {
				get: async (id) => rows.get(id),
				put: async (id, row) => rows.set(id, row),
				delete: async (id) => rows.delete(id),
			};
			registerFallbackServer(PORT, nodeServer);
			registerFastifyInstance(PORT, {
				inject: async (options) => {
					injected = options;
					return { statusCode: 200, headers: {}, stream: () => Readable.from([Buffer.from('{}')]), raw: {} };
				},
			});
		});
		after(() => {
			databases.system[TABLE] = prior;
		});
		beforeEach(() => rows.clear());

		async function setThroughBun(bunRequest, headers = {}) {
			await bunDelegateToNodeServer(nodeServer, new globalThis.Request('http://localhost/', { headers }), bunRequest);
			const body = {
				operation: 'set_network_access',
				scope: 'operations',
				allow: ['10.0.0.0/8'],
				hdb_user: SUPER_USER,
			};
			return handlePostRequest({ body, raw: {}, headers: injected.headers });
		}

		it("refuses a list excluding an operations request's address, and accepts one including it", async () => {
			await assert.rejects(setThroughBun({ ip: '203.0.113.9', isOperationsServer: true }), {
				statusCode: 409,
				message: /203\.0\.113\.9/,
			});
			assert.strictEqual(rows.size, 0);
			await setThroughBun({ ip: '10.1.2.3', isOperationsServer: true });
			assert.ok(rows.has('operations'));
		});

		it('ignores a client-supplied header', async () => {
			const forged = { 'x-harper-internal-client-address': '10.0.0.1' };
			await assert.rejects(setThroughBun({ ip: '203.0.113.9', isOperationsServer: true }, forged), { statusCode: 409 });
			await assert.rejects(setThroughBun({ ip: '', isOperationsServer: true }, forged), {
				statusCode: 409,
				message: /unknown/,
			});
			assert.strictEqual(rows.size, 0);
		});

		it('forwards the verified application peer too', async () => {
			await assert.rejects(setThroughBun({ isOperationsServer: false, ip: '203.0.113.9' }), {
				statusCode: 409,
				message: /203\.0\.113\.9/,
			});
			assert.strictEqual(injected.remoteAddress, '203.0.113.9');
		});
	});
});

describe('Fastify fallback transport peer', () => {
	const fastify = require('fastify')();
	const nodeServer = {};
	before(async () => {
		fastify.get('/peer', (request) => ({
			ip: request.ip,
			remoteAddress: request.raw.socket.remoteAddress,
			clientAddress: clientAddressOf(request),
			userHeader: request.headers['x-harper-internal-pre-auth-user'],
		}));
		fastify.get(
			'/authorized',
			(request, reply) =>
				new Promise((resolve) => {
					require('#src/security/fastifyAuth').authorize(request, reply, (error, user) => {
						resolve(reply.code(error ? 401 : 200).send({ username: user?.username }));
					});
				})
		);
		await fastify.ready();
		registerFallbackServer(PORT + 1, nodeServer);
		registerFastifyInstance(PORT + 1, fastify);
	});
	after(() => fastify.close());
	it('grants local trust only to a verified loopback peer under Bun', async function () {
		if (typeof globalThis.Bun === 'undefined') this.skip();
		for (const [ip, status] of [
			['127.0.0.1', 200],
			['203.0.113.9', 401],
			['', 401],
		]) {
			const response = await bunDelegateToNodeServer(
				nodeServer,
				new globalThis.Request('http://localhost/authorized'),
				{ ip, isOperationsServer: true }
			);
			assert.strictEqual(response.status, status, `peer ${ip || 'unknown'}`);
			const body = await response.json();
			if (status === 200) assert.strictEqual(body.username, 'local');
			else assert.notStrictEqual(body.username, 'local');
		}
	});

	for (const ip of ['203.0.113.9', '']) {
		it(`preserves ${ip || 'unknown'} peer through uWS fallback`, async () => {
			const port = PORT + 2;
			httpServer(() => ({ status: -1, headers: {}, body: 'Not found' }), { port, name: 'uwsPeerFallback' });
			registerFastifyInstance(port, fastify);
			const response = await makeUwsHandler(
				port,
				false
			)({
				method: 'GET',
				url: '/peer',
				pathname: '/peer',
				ip,
				headers: { asObject: { 'X-Harper-Internal-Client-Address': '127.0.0.1' } },
			});
			let body = '';
			if (Buffer.isBuffer(response.body)) body = response.body.toString();
			else for await (const chunk of response.body) body += chunk;
			const peer = JSON.parse(body);
			assert.strictEqual(peer.ip, ip || 'unknown', body);
			assert.strictEqual(peer.remoteAddress, ip || 'unknown');
			assert.strictEqual(peer.clientAddress, ip || null);
		});
	}

	for (const isOperationsServer of [true, false]) {
		for (const ip of ['203.0.113.9', '']) {
			it(`preserves ${ip || 'unknown'} peer on ${isOperationsServer ? 'operations' : 'application'} fallback`, async () => {
				const response = await bunDelegateToNodeServer(
					nodeServer,
					new globalThis.Request('http://localhost/peer', {
						headers: {
							'X-Harper-Internal-Client-Address': '127.0.0.1',
							'X-Harper-Internal-Pre-Auth-User': JSON.stringify(SUPER_USER),
							'X-Forwarded-For': '127.0.0.1',
						},
					}),
					{ ip, isOperationsServer }
				);
				const peer = await response.json();
				assert.strictEqual(peer.ip, ip || 'unknown');
				assert.strictEqual(peer.remoteAddress, ip || 'unknown');
				assert.strictEqual(peer.clientAddress, ip || null);
				assert.strictEqual(peer.userHeader, undefined);
			});
		}
	}
});
