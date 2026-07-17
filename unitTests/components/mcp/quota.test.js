const assert = require('node:assert');
const {
	checkDurableQuota,
	_setQuotaResourcesForTest,
	_resetQuotaWarningsForTest,
} = require('#src/components/mcp/quota');
const env = require('#src/utility/environment/environmentManager');

const INFO = {
	identity: '203.0.113.7',
	tool: 'answer',
	user: { username: 'anon' },
	profile: 'application',
	sessionId: 's1',
};

describe('mcp/quota (#1610)', () => {
	let envOverrides;
	const originalEnvGet = env.get;

	beforeEach(() => {
		envOverrides = {};
		_resetQuotaWarningsForTest();
		env.get = (key) => (key in envOverrides ? envOverrides[key] : originalEnvGet.call(env, key));
	});

	afterEach(() => {
		_setQuotaResourcesForTest(undefined);
		env.get = originalEnvGet;
	});

	it('allows when no quota resource is configured (opt-in feature)', async () => {
		assert.deepEqual(await checkDurableQuota(INFO), { allowed: true });
	});

	it('fails closed when the configured resource or method does not resolve', async () => {
		envOverrides.mcp_application_quota_resource = 'McpQuota';
		_setQuotaResourcesForTest(new Map());
		const decision = await checkDurableQuota(INFO);
		assert.equal(decision.allowed, false);
		assert.equal(decision.message, 'quota policy unavailable');
	});

	it('calls the default-named static with the check info and honors boolean results', async () => {
		envOverrides.mcp_application_quota_resource = 'McpQuota';
		const calls = [];
		class McpQuota {
			static allowMcpCall(info) {
				calls.push(info);
				return info.identity !== 'blocked';
			}
		}
		_setQuotaResourcesForTest(new Map([['McpQuota', { Resource: McpQuota }]]));
		assert.deepEqual(await checkDurableQuota(INFO), { allowed: true });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].tool, 'answer');
		assert.equal(calls[0].identity, '203.0.113.7');
		const denied = await checkDurableQuota({ ...INFO, identity: 'blocked' });
		assert.equal(denied.allowed, false);
	});

	it('honors a configured method name and structured denials', async () => {
		envOverrides.mcp_application_quota_resource = 'McpQuota';
		envOverrides.mcp_application_quota_method = 'checkDaily';
		class McpQuota {
			static checkDaily() {
				return { allowed: false, message: 'daily quota reached', retryAfterSeconds: 3600 };
			}
		}
		_setQuotaResourcesForTest(new Map([['McpQuota', { Resource: McpQuota }]]));
		const decision = await checkDurableQuota(INFO);
		assert.deepEqual(decision, { allowed: false, message: 'daily quota reached', retryAfterSeconds: 3600 });
	});

	it('treats a non-denial object result as allowed and awaits async hooks', async () => {
		envOverrides.mcp_application_quota_resource = 'McpQuota';
		class McpQuota {
			static async allowMcpCall() {
				return { remaining: 12 };
			}
		}
		_setQuotaResourcesForTest(new Map([['McpQuota', { Resource: McpQuota }]]));
		assert.deepEqual(await checkDurableQuota(INFO), { allowed: true });
	});

	it('fails closed with a sanitized message when the hook throws', async () => {
		envOverrides.mcp_application_quota_resource = 'McpQuota';
		class McpQuota {
			static allowMcpCall() {
				throw new Error('table exploded: secret connection string');
			}
		}
		_setQuotaResourcesForTest(new Map([['McpQuota', { Resource: McpQuota }]]));
		const decision = await checkDurableQuota(INFO);
		assert.equal(decision.allowed, false);
		assert.equal(decision.message, 'quota check failed');
		assert.ok(!JSON.stringify(decision).includes('secret'), 'raw error does not leak');
	});

	it('dispatches on the live registry class (exported subclass wins)', async () => {
		envOverrides.mcp_application_quota_resource = 'McpQuota';
		class Base {
			static allowMcpCall() {
				return true;
			}
		}
		const registry = new Map([['McpQuota', { Resource: Base }]]);
		_setQuotaResourcesForTest(registry);
		assert.deepEqual(await checkDurableQuota(INFO), { allowed: true });
		class Sub {
			static allowMcpCall() {
				return { allowed: false, message: 'reloaded policy' };
			}
		}
		registry.get('McpQuota').Resource = Sub;
		const decision = await checkDurableQuota(INFO);
		assert.deepEqual(decision, { allowed: false, message: 'reloaded policy' });
	});
});
