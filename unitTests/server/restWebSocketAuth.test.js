const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	credentialRejectionError,
	deferCredentialRejection,
	markAuthenticationRejectedInPlace,
} = require('#src/security/deferredAuthentication');
const { handleApplication } = require('#src/server/REST');

// The REST upgrade must settle a credential rejection BEFORE it looks the route up, or a rejected
// client learns from the close code whether the resource exists — and gets 1011 where the same
// credential is a 401 over HTTP (harper#2703).
const UNAUTHORIZED_CLOSE_CODE = 3000;
const NO_RESOURCE_CLOSE_CODE = 1011;

let mountCounter = 0;

function webSocketListener() {
	let listener;
	// `getMatch` returning undefined is the no-ws-resource case this ordering is about
	const scope = {
		resources: { getMatch: () => undefined },
		options: { getAll: () => ({ webSocket: {} }) },
		// each mount needs its own route or REST's startedMounts dedupe skips registration
		routeFor: () => ({ host: undefined, urlPath: `/rest-ws-auth-${mountCounter++}` }),
		server: {
			http: () => {},
			ws: (fn) => ((listener = fn), []),
		},
	};
	handleApplication(scope);
	return listener;
}

function fakeWebSocket() {
	const closes = [];
	return {
		closes,
		close: (code, reason) => closes.push({ code, reason }),
		send: () => {},
		on: () => {},
	};
}

function upgradeRequest(pathname = '/NoSuchResource') {
	const headerObject = {};
	return {
		method: 'GET',
		url: pathname,
		pathname,
		ip: '127.0.0.1',
		isWebSocket: true,
		headers: { asObject: headerObject, get: (name) => headerObject[name.toLowerCase()] },
	};
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('REST WebSocket upgrade settles authentication before the route lookup (harper#2703)', () => {
	it('closes an in-place rejection as unauthorized, not as a missing resource', async () => {
		const listener = webSocketListener();
		const ws = fakeWebSocket();
		const request = upgradeRequest();
		markAuthenticationRejectedInPlace(request, 401, 'Certificate revoked or verification failed');

		await listener(ws, request, Promise.resolve({ status: 401 }));
		await settle();

		// the handler always runs a bare ws.close() afterwards, which a real socket ignores; the
		// first close is the one that carries the decision
		assert.strictEqual(
			ws.closes[0].code,
			UNAUTHORIZED_CLOSE_CODE,
			`expected an unauthorized close, got ${JSON.stringify(ws.closes[0])}`
		);
		assert.match(ws.closes[0].reason, /Certificate revoked/);
	});

	it('closes a deferred rejection as unauthorized too', async () => {
		const listener = webSocketListener();
		const ws = fakeWebSocket();
		const request = upgradeRequest();
		deferCredentialRejection(request, credentialRejectionError('SSO session expired', 401), 'Session');

		await listener(ws, request, Promise.resolve(undefined));
		await settle();

		assert.strictEqual(ws.closes[0].code, UNAUTHORIZED_CLOSE_CODE);
		assert.match(ws.closes[0].reason, /SSO session expired/);
	});

	it('still reports a genuinely missing resource when authentication succeeded', async () => {
		const listener = webSocketListener();
		const ws = fakeWebSocket();
		const request = upgradeRequest();

		await listener(ws, request, Promise.resolve(undefined));
		await settle();

		assert.strictEqual(ws.closes[0].code, NO_RESOURCE_CLOSE_CODE);
		assert.match(ws.closes[0].reason, /No resource was found/);
	});
});
