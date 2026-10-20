'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { Readable } = require('node:stream');

const { bunDelegateToNodeServer, registerFallbackServer, registerFastifyInstance } = require('#src/server/http');
const { clientAddressOf, handlePostRequest } = require('#src/server/serverHelpers/serverHandlers');
const { databases } = require('#src/resources/databases');
const terms = require('#src/utility/hdbTerms');

const PORT = 19451;
const TABLE = terms.SYSTEM_TABLE_NAMES.NETWORK_ACCESS_TABLE_NAME;
const SUPER_USER = { username: 'admin', role: { permission: { super_user: true } } };

// An injected request's mock socket always reports 127.0.0.1, so set_network_access's lockout check
// depends on the header reaching handlePostRequest intact, and on a client never supplying it.
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

		it('does not look up the address for an application request', async () => {
			const bunRequest = {
				isOperationsServer: false,
				get ip() {
					throw new Error('looked up');
				},
			};
			await assert.rejects(setThroughBun(bunRequest), { statusCode: 409, message: /unknown/ });
		});
	});
});
