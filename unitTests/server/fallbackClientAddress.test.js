'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { Readable } = require('node:stream');

const { bunDelegateToNodeServer, registerFallbackServer, registerFastifyInstance } = require('#src/server/http');
const serverHandlers = require('#src/server/serverHelpers/serverHandlers');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');
const sinon = require('sinon');

const PORT = 19451;

// The injected request's mock socket always reports 127.0.0.1, so set_network_access's lockout check
// depends on this header reaching handlePostRequest intact, and on a client never supplying it.
describe('Fastify injection carries the client address to the lockout check', () => {
	let injected;
	const nodeServer = { bunFallback: 'client address' };
	const sandbox = sinon.createSandbox();

	before(() => {
		registerFallbackServer(PORT, nodeServer);
		registerFastifyInstance(PORT, {
			inject: async (options) => {
				injected = options;
				return { statusCode: 200, headers: {}, stream: () => Readable.from([Buffer.from('{}')]), raw: {} };
			},
		});
		sandbox.stub(serverUtilities, 'chooseOperation').returns('op');
		sandbox.stub(serverUtilities, 'processLocalTransaction').resolves({});
	});
	after(() => sandbox.restore());

	async function addressSeenByHandler(bunRequest, headers = {}) {
		const webRequest = new globalThis.Request('http://localhost/', { method: 'POST', headers });
		await bunDelegateToNodeServer(nodeServer, webRequest, bunRequest);
		const body = { operation: 'set_network_access' };
		await serverHandlers.handlePostRequest({ body, raw: {}, headers: injected.headers });
		return body.hdb_client_address;
	}

	it('passes the original request address', async () => {
		assert.strictEqual(await addressSeenByHandler({ ip: '203.0.113.9' }), '203.0.113.9');
	});

	it('drops a client-supplied header, with or without a known address', async () => {
		const forged = { 'x-harper-internal-client-address': '10.0.0.1' };
		assert.strictEqual(await addressSeenByHandler({ ip: '203.0.113.9' }, forged), '203.0.113.9');
		assert.strictEqual(await addressSeenByHandler({ ip: '' }, forged), undefined);
	});
});
