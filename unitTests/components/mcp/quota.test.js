const assert = require('node:assert');
const { checkDurableQuota, setMcpQuotaHandler } = require('#src/components/mcp/quota');

const INFO = {
	identity: '203.0.113.7',
	tool: 'answer',
	user: { username: 'anon' },
	profile: 'application',
	sessionId: 's1',
};

describe('mcp/quota (#1610, #1809 registration handler)', () => {
	afterEach(() => {
		setMcpQuotaHandler(undefined);
	});

	it('allows when no handler is registered (opt-in feature)', async () => {
		assert.deepEqual(await checkDurableQuota(INFO), { allowed: true });
	});

	it('calls the registered handler with the check info and honors boolean results', async () => {
		const calls = [];
		setMcpQuotaHandler((info) => {
			calls.push(info);
			return info.identity !== 'blocked';
		});
		assert.deepEqual(await checkDurableQuota(INFO), { allowed: true });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].tool, 'answer');
		assert.equal(calls[0].identity, '203.0.113.7');
		assert.equal(calls[0].profile, 'application');
		const denied = await checkDurableQuota({ ...INFO, identity: 'blocked' });
		assert.equal(denied.allowed, false);
	});

	it('honors structured denials', async () => {
		setMcpQuotaHandler(() => ({ allowed: false, message: 'daily quota reached', retryAfterSeconds: 3600 }));
		const decision = await checkDurableQuota(INFO);
		assert.deepEqual(decision, { allowed: false, message: 'daily quota reached', retryAfterSeconds: 3600 });
	});

	it('treats a non-denial object result as allowed and awaits async handlers', async () => {
		setMcpQuotaHandler(async () => ({ remaining: 12 }));
		assert.deepEqual(await checkDurableQuota(INFO), { allowed: true });
	});

	it('fails closed with a sanitized message when the handler throws', async () => {
		setMcpQuotaHandler(() => {
			throw new Error('table exploded: secret connection string');
		});
		const decision = await checkDurableQuota(INFO);
		assert.equal(decision.allowed, false);
		assert.equal(decision.message, 'quota check failed');
		assert.ok(!JSON.stringify(decision).includes('secret'), 'raw error does not leak');
	});

	it('lets the handler gate per profile via info.profile', async () => {
		setMcpQuotaHandler((info) => (info.profile === 'application' ? { allowed: false, message: 'app only' } : true));
		assert.equal((await checkDurableQuota(INFO)).allowed, false);
		assert.deepEqual(await checkDurableQuota({ ...INFO, profile: 'operations' }), { allowed: true });
	});

	it('latest registration wins (a reloaded component replaces the handler)', async () => {
		setMcpQuotaHandler(() => true);
		assert.deepEqual(await checkDurableQuota(INFO), { allowed: true });
		setMcpQuotaHandler(() => ({ allowed: false, message: 'reloaded policy' }));
		assert.deepEqual(await checkDurableQuota(INFO), { allowed: false, message: 'reloaded policy' });
	});
});
