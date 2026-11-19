const assert = require('node:assert');
const indexMod = require('#src/components/mcp/index');
const {
	registerMcpProfile,
	handleApplication,
	_resetApplicationStartedForTest,
	_setGetConfigObjForTest,
	_restoreGetConfigObj,
} = indexMod;
const { _setSessionTableForTest } = require('#src/components/mcp/session');
const { Readable } = require('node:stream');
const { Headers } = require('#src/server/serverHelpers/Headers');

function makeHeaders(init) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(init)) headers.set(name, value);
	return headers;
}

function makeFakeFastify() {
	const calls = [];
	function record(method) {
		return function (path, optsOrHandler, maybeHandler) {
			if (typeof optsOrHandler === 'function') {
				calls.push({ method, path, options: undefined, handler: optsOrHandler });
			} else {
				calls.push({ method, path, options: optsOrHandler, handler: maybeHandler });
			}
		};
	}
	return {
		calls,
		post: record('post'),
		get: record('get'),
		delete: record('delete'),
	};
}

function makeFakeScope() {
	const calls = [];
	return {
		calls,
		server: {
			http(handler, options) {
				calls.push({ handler, options });
			},
		},
	};
}

function makeFakeTable() {
	return {
		async put() {},
		async get() {
			return undefined;
		},
		async delete() {},
	};
}

describe('components/mcp/index', () => {
	beforeEach(() => _setSessionTableForTest(makeFakeTable()));
	afterEach(() => {
		_setSessionTableForTest(undefined);
		_resetApplicationStartedForTest();
	});

	describe('registerMcpProfile (operations side, Fastify)', () => {
		it('does nothing when the mcp config block is absent', () => {
			const host = makeFakeFastify();
			registerMcpProfile({ profile: 'operations', host, config: {} });
			assert.equal(host.calls.length, 0);
		});

		it('does nothing when the profile sub-block is absent under mcp', () => {
			const host = makeFakeFastify();
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { application: { mountPath: '/x' } } },
			});
			assert.equal(host.calls.length, 0);
		});

		it('registers POST/GET/DELETE on /mcp when the operations profile block is present', () => {
			const host = makeFakeFastify();
			registerMcpProfile({ profile: 'operations', host, config: { mcp: { operations: {} } } });
			assert.equal(host.calls.length, 3);
			assert.deepEqual(
				host.calls.map((c) => c.method),
				['post', 'get', 'delete']
			);
			for (const call of host.calls) {
				assert.equal(call.path, '/mcp');
				assert.equal(typeof call.handler, 'function');
			}
		});

		it('registers on enabled: true (the env-var config form) and skips on enabled: false', () => {
			const on = makeFakeFastify();
			registerMcpProfile({ profile: 'operations', host: on, config: { mcp: { operations: { enabled: true } } } });
			assert.equal(on.calls.length, 3);
			const off = makeFakeFastify();
			registerMcpProfile({ profile: 'operations', host: off, config: { mcp: { operations: { enabled: false } } } });
			assert.equal(off.calls.length, 0);
		});

		it('honors a custom mountPath on all three methods', () => {
			const host = makeFakeFastify();
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { operations: { mountPath: '/agent' } } },
			});
			for (const call of host.calls) assert.equal(call.path, '/agent');
		});

		it('forwards routeOptions to every method registration', () => {
			const host = makeFakeFastify();
			const sentinel = { preValidation: ['fake-auth-handler'] };
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { operations: {} } },
				routeOptions: sentinel,
			});
			for (const call of host.calls) assert.deepEqual(call.options, sentinel);
		});
	});

	describe('handleApplication (application side, Harper-HTTP)', () => {
		let configReturn;
		beforeEach(() => {
			_setGetConfigObjForTest(() => configReturn);
		});
		afterEach(() => {
			_restoreGetConfigObj();
		});

		it('does nothing when the mcp.application sub-block is absent', () => {
			configReturn = { mcp: { operations: {} } };
			const scope = makeFakeScope();
			handleApplication(scope);
			assert.equal(scope.calls.length, 0);
		});

		it('registers via scope.server.http when mcp.application is present', () => {
			configReturn = { mcp: { application: {} } };
			const scope = makeFakeScope();
			handleApplication(scope);
			assert.equal(scope.calls.length, 1);
			assert.equal(scope.calls[0].options.urlPath, '/mcp');
			assert.equal(scope.calls[0].options.after, 'authentication');
			assert.equal(typeof scope.calls[0].handler, 'function');
		});

		it('registers on enabled: true and skips on enabled: false', () => {
			configReturn = { mcp: { application: { enabled: false } } };
			const off = makeFakeScope();
			handleApplication(off);
			assert.equal(off.calls.length, 0);
			configReturn = { mcp: { application: { enabled: true } } };
			const on = makeFakeScope();
			handleApplication(on);
			assert.equal(on.calls.length, 1);
		});

		it('honors a custom mountPath', () => {
			configReturn = { mcp: { application: { mountPath: '/agent' } } };
			const scope = makeFakeScope();
			handleApplication(scope);
			assert.equal(scope.calls[0].options.urlPath, '/agent');
		});

		it('is idempotent on repeated invocations', () => {
			configReturn = { mcp: { application: {} } };
			const scopeA = makeFakeScope();
			const scopeB = makeFakeScope();
			handleApplication(scopeA);
			handleApplication(scopeB);
			assert.equal(scopeA.calls.length, 1);
			assert.equal(scopeB.calls.length, 0);
		});

		it('does nothing when getConfigObj returns undefined', () => {
			configReturn = undefined;
			const scope = makeFakeScope();
			handleApplication(scope);
			assert.equal(scope.calls.length, 0);
		});

		describe('authentication (#4344)', () => {
			const PRM = 'https://app.example.com/.well-known/oauth-protected-resource/mcp';

			async function anonymousInitialize(authentication) {
				configReturn = { mcp: { application: { authentication } } };
				const scope = makeFakeScope();
				handleApplication(scope);
				return scope.calls[0].handler(
					{
						method: 'POST',
						headers: makeHeaders({ 'content-type': 'application/json', 'accept': 'application/json' }),
						body: Readable.from([
							Buffer.from(
								JSON.stringify({
									jsonrpc: '2.0',
									id: 1,
									method: 'initialize',
									params: { protocolVersion: '2025-06-18' },
								})
							),
						]),
					},
					async () => undefined
				);
			}

			it('requires a principal when authentication.required is true, naming the configured metadata', async () => {
				const result = await anonymousInitialize({ required: true, resourceMetadata: PRM });
				assert.equal(result.status, 401);
				assert.equal(result.headers.get('WWW-Authenticate'), `Bearer resource_metadata="${PRM}"`);
			});

			it('stays optional unless required is the boolean true', async () => {
				const result = await anonymousInitialize({ required: 'true', resourceMetadata: PRM });
				assert.equal(result.status, 200);
			});

			it('ignores a resourceMetadata that is not a header-safe absolute URL, and still requires a principal', async () => {
				const result = await anonymousInitialize({ required: true, resourceMetadata: 'https://x.example/"' });
				assert.equal(result.status, 401);
				assert.equal(result.headers.get('WWW-Authenticate'), 'Bearer realm="Harper"');
			});
		});
	});
});
