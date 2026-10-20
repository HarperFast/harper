'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { Readable } = require('node:stream');

const { bunDelegateToNodeServer, registerFallbackServer, registerFastifyInstance } = require('#src/server/http');
const { clientAddressOf } = require('#src/server/serverHelpers/serverHandlers');

const PORT = 19451;

// An injected request's mock socket always reports 127.0.0.1, so set_network_access's lockout check
// depends on the header reaching clientAddressOf intact, and on a client never supplying it.
describe('set_network_access caller address', () => {
	describe('clientAddressOf', () => {
		it("uses the Node request's address, ignoring the header beside it", () => {
			const headers = { 'x-harper-internal-client-address': '10.0.0.1' };
			assert.strictEqual(clientAddressOf({ raw: { baseRequest: { ip: '203.0.113.9' } }, headers }), '203.0.113.9');
		});
		it('is undefined for a Node local connection (the operations domain socket)', () => {
			assert.strictEqual(clientAddressOf({ raw: { baseRequest: { ip: undefined } }, headers: {} }), undefined);
		});
		it('is null for an injected request that carried no address', () => {
			assert.strictEqual(clientAddressOf({ raw: {}, headers: {} }), null);
		});
	});

	describe('Bun injection into Fastify', () => {
		let injected;
		const nodeServer = { bunFallback: 'client address' };
		before(() => {
			registerFallbackServer(PORT, nodeServer);
			registerFastifyInstance(PORT, {
				inject: async (options) => {
					injected = options;
					return { statusCode: 200, headers: {}, stream: () => Readable.from([Buffer.from('{}')]), raw: {} };
				},
			});
		});

		async function addressSeen(bunRequest, headers = {}) {
			await bunDelegateToNodeServer(nodeServer, new globalThis.Request('http://localhost/', { headers }), bunRequest);
			return clientAddressOf({ raw: {}, headers: injected.headers });
		}

		it("passes an operations request's address", async () => {
			assert.strictEqual(await addressSeen({ ip: '203.0.113.9', isOperationsServer: true }), '203.0.113.9');
		});

		it('drops a client-supplied header, with or without a known address', async () => {
			const forged = { 'x-harper-internal-client-address': '10.0.0.1' };
			assert.strictEqual(await addressSeen({ ip: '203.0.113.9', isOperationsServer: true }, forged), '203.0.113.9');
			assert.strictEqual(await addressSeen({ ip: '', isOperationsServer: true }, forged), null);
		});

		it('does not look up the address for an application request', async () => {
			const bunRequest = {
				isOperationsServer: false,
				get ip() {
					throw new Error('looked up');
				},
			};
			assert.strictEqual(await addressSeen(bunRequest), null);
		});
	});
});
