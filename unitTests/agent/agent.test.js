'use strict';

/**
 * Unit tests for `resolveAgentIdentity` (#626) — the enforcement-identity resolver
 * used for every registry-tool call. Registry tools run RBAC-enforced against the
 * identity this returns, so its fail-closed / bootstrap-fallback policy is
 * security-sensitive and gets direct coverage here (rather than only being stubbed
 * indirectly by registryTools.test.js / mcpTools.test.js).
 *
 * Policy under test:
 *   - resolvable permissioned user            -> returned as-is
 *   - default `hdb_agent` user, unresolvable   -> super_user bootstrap identity
 *   - non-default user, unresolvable           -> throws (never escalates)
 */

const assert = require('node:assert');
const { resolveAgentIdentity } = require('#src/agent/agent');

const DEFAULT_USER = 'hdb_agent';

// A permissioned user as Harper's getUser would return one.
const RESTRICTED_USER = { username: 'ro', role: { permission: { super_user: false, read: true } } };

// server stub whose getUser returns whatever the test wires up (or throws).
function serverWith(getUser) {
	return { registerOperation: () => {}, getUser };
}

describe('agent/agent resolveAgentIdentity', () => {
	it('returns a resolvable permissioned user as-is', async () => {
		let seenArgs;
		const server = serverWith((username, password, request) => {
			seenArgs = { username, password, request };
			return RESTRICTED_USER;
		});
		const identity = await resolveAgentIdentity(server, 'ro');
		assert.strictEqual(identity, RESTRICTED_USER);
		// Resolution is by username only; password/request are unused (passed as null).
		assert.deepStrictEqual(seenArgs, { username: 'ro', password: null, request: null });
	});

	it('awaits an async getUser', async () => {
		const server = serverWith(async () => RESTRICTED_USER);
		const identity = await resolveAgentIdentity(server, 'ro');
		assert.strictEqual(identity, RESTRICTED_USER);
	});

	it('falls back to a super_user bootstrap identity for the default user when unresolvable', async () => {
		// getUser returns nothing (default bootstrap user not provisioned yet — #626).
		const server = serverWith(() => undefined);
		const identity = await resolveAgentIdentity(server, DEFAULT_USER);
		assert.strictEqual(identity.username, DEFAULT_USER);
		assert.strictEqual(identity.role.permission.super_user, true);
	});

	it('falls back to bootstrap for the default user even with no getUser provided', async () => {
		const identity = await resolveAgentIdentity({ registerOperation: () => {} }, DEFAULT_USER);
		assert.strictEqual(identity.username, DEFAULT_USER);
		assert.strictEqual(identity.role.permission.super_user, true);
	});

	it('falls back to bootstrap for the default user when getUser throws', async () => {
		const server = serverWith(() => {
			throw new Error('user store unavailable');
		});
		const identity = await resolveAgentIdentity(server, DEFAULT_USER);
		assert.strictEqual(identity.role.permission.super_user, true);
	});

	it('fails closed (throws) for a non-default user that cannot be resolved', async () => {
		const server = serverWith(() => undefined);
		await assert.rejects(() => resolveAgentIdentity(server, 'restricted-svc'), /could not be resolved.*failing closed/);
	});

	it('fails closed for a non-default user when getUser throws', async () => {
		const server = serverWith(() => {
			throw new Error('user store unavailable');
		});
		await assert.rejects(() => resolveAgentIdentity(server, 'restricted-svc'), /failing closed/);
	});

	it('fails closed when a non-default user resolves without a role permission', async () => {
		// A user object with no role.permission is treated as unresolved — the guard that
		// prevents an under-permissioned/partial account from being used as-is.
		const server = serverWith(() => ({ username: 'ghost', role: {} }));
		await assert.rejects(() => resolveAgentIdentity(server, 'ghost'), /failing closed/);
	});

	it('does NOT escalate the default user when it resolves without a role permission', async () => {
		// Even for the default user, an object lacking role.permission is not "resolved";
		// it takes the documented bootstrap path rather than being returned as-is.
		const server = serverWith(() => ({ username: DEFAULT_USER, role: {} }));
		const identity = await resolveAgentIdentity(server, DEFAULT_USER);
		assert.strictEqual(identity.role.permission.super_user, true);
	});
});
