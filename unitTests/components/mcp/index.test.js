const assert = require('node:assert/strict');
const { registerMcpProfile, createStubHandler } = require('#src/components/mcp/index');

function makeFakeFastify() {
	const calls = [];
	return {
		calls,
		post(path, optsOrHandler, maybeHandler) {
			if (typeof optsOrHandler === 'function') {
				calls.push({ path, options: undefined, handler: optsOrHandler });
			} else {
				calls.push({ path, options: optsOrHandler, handler: maybeHandler });
			}
		},
	};
}

function makeFakeReply() {
	const reply = {
		statusCode: undefined,
		headers: {},
		body: undefined,
		code(status) {
			this.statusCode = status;
			return this;
		},
		header(name, value) {
			this.headers[name] = value;
			return this;
		},
		send(payload) {
			this.body = payload;
			return this;
		},
	};
	return reply;
}

describe('components/mcp/index', () => {
	describe('registerMcpProfile', () => {
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

		it('registers POST /mcp when the operations profile block is present', () => {
			const host = makeFakeFastify();
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { operations: {} } },
			});
			assert.equal(host.calls.length, 1);
			assert.equal(host.calls[0].path, '/mcp');
			assert.equal(typeof host.calls[0].handler, 'function');
		});

		it('honors a custom mountPath', () => {
			const host = makeFakeFastify();
			registerMcpProfile({
				profile: 'application',
				host,
				config: { mcp: { application: { mountPath: '/agent' } } },
			});
			assert.equal(host.calls.length, 1);
			assert.equal(host.calls[0].path, '/agent');
		});

		it('forwards routeOptions to the host as the second argument', () => {
			const host = makeFakeFastify();
			const sentinel = { preValidation: ['fake-auth-handler'] };
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { operations: {} } },
				routeOptions: sentinel,
			});
			assert.equal(host.calls.length, 1);
			assert.deepEqual(host.calls[0].options, sentinel);
			assert.equal(typeof host.calls[0].handler, 'function');
		});
	});

	describe('stub handler', () => {
		it('returns 503 with mcp_not_implemented body for the operations profile', async () => {
			const handler = createStubHandler('operations');
			const reply = makeFakeReply();
			await handler({}, reply);
			assert.equal(reply.statusCode, 503);
			assert.equal(reply.headers['Retry-After'], '0');
			assert.equal(reply.headers['Content-Type'], 'application/json');
			assert.deepEqual(reply.body, { error: 'mcp_not_implemented', profile: 'operations' });
		});

		it('returns 503 with mcp_not_implemented body for the application profile', async () => {
			const handler = createStubHandler('application');
			const reply = makeFakeReply();
			await handler({}, reply);
			assert.equal(reply.statusCode, 503);
			assert.deepEqual(reply.body, { error: 'mcp_not_implemented', profile: 'application' });
		});
	});
});
