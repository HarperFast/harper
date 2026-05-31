const assert = require('node:assert/strict');
const {
	tryAdmit,
	clearSessionRateState,
	configFor,
	_setClockForTest,
	_resetForTest,
} = require('#src/components/mcp/rateLimit');
const env = require('#src/utility/environment/environmentManager');

describe('mcp/rateLimit', () => {
	let envOverrides;
	const originalEnvGet = env.get;
	let clock = 0;

	beforeEach(() => {
		_resetForTest();
		envOverrides = {};
		clock = 0;
		_setClockForTest(() => clock);
		env.get = (key) => (key in envOverrides ? envOverrides[key] : originalEnvGet.call(env, key));
	});

	afterEach(() => {
		_resetForTest();
		_setClockForTest(undefined);
		env.get = originalEnvGet;
	});

	describe('configFor', () => {
		it('returns the documented defaults for each profile when nothing is configured', () => {
			const ops = configFor('operations');
			assert.deepEqual(ops, { perToolPerSecond: 10, perToolBurst: 20, sessionConcurrency: 25, sessionPerSecond: 100 });
			const app = configFor('application');
			assert.deepEqual(app, { perToolPerSecond: 25, perToolBurst: 50, sessionConcurrency: 50, sessionPerSecond: 200 });
		});

		it('overrides defaults from configured values', () => {
			envOverrides.mcp_operations_rateLimit_perToolPerSecond = 5;
			envOverrides.mcp_operations_rateLimit_perToolBurst = 7;
			const cfg = configFor('operations');
			assert.equal(cfg.perToolPerSecond, 5);
			assert.equal(cfg.perToolBurst, 7);
		});
	});

	describe('tryAdmit', () => {
		it('admits up to perToolBurst calls before throttling', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 3;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.001; // effectively no refill
			const releases = [];
			for (let i = 0; i < 3; i++) {
				const d = tryAdmit('s1', 'tool_x', 'application');
				assert.equal(d.allowed, true, `call ${i + 1} should be admitted`);
				releases.push(d.release);
			}
			releases.forEach((r) => r());
			const denied = tryAdmit('s1', 'tool_x', 'application');
			assert.equal(denied.allowed, false);
			assert.equal(denied.reason, 'per_tool');
		});

		it('refills the per-tool bucket over time', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 1; // 1 token per second
			const r1 = tryAdmit('s1', 'tool_x', 'application');
			assert.equal(r1.allowed, true);
			r1.release();
			const r2 = tryAdmit('s1', 'tool_x', 'application');
			assert.equal(r2.allowed, false, 'bucket drained');
			clock += 1100; // 1.1 seconds
			const r3 = tryAdmit('s1', 'tool_x', 'application');
			assert.equal(r3.allowed, true, 'bucket refilled after 1+ second');
		});

		it('caps in-flight calls at sessionConcurrency', () => {
			envOverrides.mcp_application_rateLimit_sessionConcurrency = 2;
			envOverrides.mcp_application_rateLimit_perToolBurst = 100;
			envOverrides.mcp_application_rateLimit_sessionPerSecond = 100;
			const r1 = tryAdmit('s1', 't', 'application');
			const r2 = tryAdmit('s1', 't', 'application');
			const r3 = tryAdmit('s1', 't', 'application');
			assert.equal(r1.allowed, true);
			assert.equal(r2.allowed, true);
			assert.equal(r3.allowed, false);
			assert.equal(r3.reason, 'concurrency');
			r1.release();
			const r4 = tryAdmit('s1', 't', 'application');
			assert.equal(r4.allowed, true, 'release frees concurrency slot');
		});

		it('rejects on session_rate when sessionPerSecond is exhausted', () => {
			envOverrides.mcp_application_rateLimit_sessionPerSecond = 2;
			envOverrides.mcp_application_rateLimit_perToolBurst = 100;
			envOverrides.mcp_application_rateLimit_sessionConcurrency = 100;
			const r1 = tryAdmit('s1', 'a', 'application');
			const r2 = tryAdmit('s1', 'b', 'application');
			const r3 = tryAdmit('s1', 'c', 'application');
			r1.release();
			r2.release();
			assert.equal(r1.allowed, true);
			assert.equal(r2.allowed, true);
			assert.equal(r3.allowed, false);
			assert.equal(r3.reason, 'session_rate');
		});

		it('treats different sessions as independent', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.001;
			const r1 = tryAdmit('s1', 'x', 'application');
			r1.release();
			const r2 = tryAdmit('s2', 'x', 'application');
			r2.release();
			assert.equal(r1.allowed, true);
			assert.equal(r2.allowed, true);
		});

		it('per-tool denial does not drain the session-rate bucket', () => {
			// Per-tool bucket: 1 token, no refill. Session-rate bucket: 5 tokens.
			// Hammer the same tool repeatedly. The first succeeds, every subsequent
			// call should be denied with reason=per_tool. The session-rate bucket
			// must NOT be drained by the denials — only the first successful call.
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.0000001;
			envOverrides.mcp_application_rateLimit_sessionPerSecond = 5;
			envOverrides.mcp_application_rateLimit_sessionConcurrency = 100;
			const r1 = tryAdmit('s1', 't', 'application');
			r1.release();
			assert.equal(r1.allowed, true);
			// 10 consecutive per-tool denials.
			for (let i = 0; i < 10; i++) {
				const d = tryAdmit('s1', 't', 'application');
				assert.equal(d.allowed, false);
				assert.equal(d.reason, 'per_tool', `call ${i + 2}: expected per_tool denial`);
			}
			// Switch to a different tool with its own fresh bucket. Should still
			// have 4 session-rate tokens (5 - 1 used by r1). Verify by burning all 4.
			envOverrides.mcp_application_rateLimit_perToolBurst = 100; // not the limit here
			for (let i = 0; i < 4; i++) {
				const d = tryAdmit('s1', `t${i}`, 'application');
				assert.equal(d.allowed, true, `expected admit ${i + 1}/4 on a fresh tool`);
				d.release();
			}
			// 5th attempt on yet another tool should now hit session_rate.
			const last = tryAdmit('s1', 't_overflow', 'application');
			assert.equal(last.allowed, false);
			assert.equal(last.reason, 'session_rate');
		});

		it('treats different tools as independent', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.001;
			envOverrides.mcp_application_rateLimit_sessionPerSecond = 100;
			const a = tryAdmit('s1', 'tool_a', 'application');
			const b = tryAdmit('s1', 'tool_b', 'application');
			a.release();
			b.release();
			assert.equal(a.allowed, true);
			assert.equal(b.allowed, true, 'tool_b has its own bucket');
		});
	});

	describe('clearSessionRateState', () => {
		it('drops per-session state so re-creation starts fresh', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.001;
			const r1 = tryAdmit('s1', 't', 'application');
			r1.release();
			const r2 = tryAdmit('s1', 't', 'application');
			assert.equal(r2.allowed, false);
			clearSessionRateState('s1');
			const r3 = tryAdmit('s1', 't', 'application');
			assert.equal(r3.allowed, true, 'fresh bucket after clear');
		});
	});

	describe('idle-session prune (belt-and-braces against TTL eviction)', () => {
		it('drops sessions that have been idle past the prune window', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.001;
			// First admit creates the state for 's1'.
			const r1 = tryAdmit('s1', 't', 'application');
			r1.release();
			const r2 = tryAdmit('s1', 't', 'application');
			assert.equal(r2.allowed, false, 'bucket exhausted before prune window');
			// Advance the clock past the prune interval AND past the idle window.
			clock += 61 * 60 * 1000; // 61 minutes
			// A different session triggers the prune; after pruning, 's1' is gone,
			// so re-admitting yields a fresh full bucket.
			const tickle = tryAdmit('s2', 't', 'application');
			tickle.release();
			const r3 = tryAdmit('s1', 't', 'application');
			assert.equal(r3.allowed, true, 'fresh bucket after idle prune');
		});

		it('does not prune sessions that are still active', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.0000001; // effectively never refills
			const r1 = tryAdmit('s1', 't', 'application');
			r1.release();
			// 30 min elapsed — below the 60-min idle window. The next admit
			// for s1 itself refreshes lastSeen so the prune (when it eventually
			// fires) doesn't drop the session. s2 just triggers the prune call.
			clock += 30 * 60 * 1000;
			tryAdmit('s2', 't', 'application').release();
			// Touching s1 again keeps it fresh.
			const stillExhausted = tryAdmit('s1', 't', 'application');
			assert.equal(stillExhausted.allowed, false, 'active session keeps its state');
		});
	});
});
