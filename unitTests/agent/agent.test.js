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
const { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { resolveAgentIdentity, resolveScopes, buildStaticSystemPrompt } = require('#src/agent/agent');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { readFileTool, listDirTool } = require('#src/agent/tools/fsTools');

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

describe('agent/agent resolveScopes (harper#3041)', () => {
	let root;
	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-scopes-')));
		writeFileSync(join(root, 'harper-config.yaml'), 'http: {}\n');
		mkdirSync(join(root, 'components'));
		mkdirSync(join(root, 'etc'));
		writeFileSync(join(root, 'etc', 'extra.yaml'), '');
	});

	function scopesFor(agentConfig, rootPath = root) {
		const paths = {
			[CONFIG_PARAMS.ROOTPATH]: rootPath,
			[CONFIG_PARAMS.COMPONENTSROOT]: join(rootPath, 'components'),
			[CONFIG_PARAMS.LOGGING_ROOT]: join(rootPath, 'log'),
		};
		return resolveScopes(
			agentConfig,
			(param) => paths[param],
			() => join(rootPath, 'harper-config.yaml')
		);
	}

	it('defaults the config scope to the config file alone, not its directory', () => {
		const scopes = scopesFor({});
		assert.equal(scopes.configDir, root);
		assert.equal(scopes.configFile, 'harper-config.yaml');
	});

	it('takes agent.configScope as a directory, relative to rootPath or absolute', () => {
		for (const configScope of ['etc', join(root, 'etc')]) {
			const scopes = scopesFor({ configScope });
			assert.equal(scopes.configDir, join(root, 'etc'));
			assert.equal(scopes.configFile, undefined);
		}
	});

	it('takes agent.configScope naming a file as a single-file scope', () => {
		const scopes = scopesFor({ configScope: 'etc/extra.yaml' });
		assert.equal(scopes.configDir, join(root, 'etc'));
		assert.equal(scopes.configFile, 'extra.yaml');
	});

	it('leaves the config scope unavailable when agent.configScope names nothing', () => {
		const scopes = scopesFor({ configScope: 'missing' });
		assert.equal(scopes.configDir, undefined);
		assert.equal(scopes.configFile, undefined);
	});

	it('names the keys and ssh directories under rootPath as the key directories', () => {
		assert.deepEqual(scopesFor({}).keyDirs, [join(root, 'keys'), join(root, 'ssh')]);
	});

	it('admits a symlinked config file as its target, and the tools read it through those scopes', async () => {
		const realConfig = join(mkdtempSync(join(tmpdir(), 'agent-scopes-cfg-')), 'harper-config.yaml');
		writeFileSync(realConfig, 'http: {}\n');
		const linkedRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-scopes-linkcfg-')));
		try {
			symlinkSync(realConfig, join(linkedRoot, 'harper-config.yaml'), 'file');
		} catch (err) {
			if (err.code === 'EPERM' || err.code === 'ENOTSUP') return;
			throw err;
		}
		const scopes = scopesFor({}, linkedRoot);
		assert.equal(join(scopes.configDir, scopes.configFile), realpathSync.native(realConfig));
		const ctx = { sessionId: 's', scopes };
		const { content } = await readFileTool.handler({ root: 'config' }, ctx);
		assert.equal(content, 'http: {}\n');
		const { entries } = await listDirTool.handler({ root: 'config' }, ctx);
		assert.deepEqual(entries, [{ name: 'harper-config.yaml', kind: 'file' }]);
	});

	it('still resolves a relative componentsScope against rootPath', () => {
		assert.equal(scopesFor({ componentsScope: 'components/app' }).componentsRoot, join(root, 'components', 'app'));
	});
});

describe('agent/agent buildStaticSystemPrompt config scope line', () => {
	const base = { componentsRoot: '/h/components', logDir: '/h/log', keyDirs: ['/h/keys'] };

	it('names the single config file and the key-material refusal', () => {
		const prompt = buildStaticSystemPrompt({ ...base, configDir: '/h', configFile: 'harper-config.yaml' }, false);
		assert.match(prompt, /- config — read-only, a single file — address it as "harper-config.yaml"/);
		assert.match(prompt, /Key material is refused in every scope/);
	});

	it('names a directory override as a directory, and an unavailable scope as unavailable', () => {
		assert.match(buildStaticSystemPrompt({ ...base, configDir: '/h/etc' }, false), /- config — read-only: \/h\/etc\n/);
		assert.match(buildStaticSystemPrompt(base, false), /- config — unavailable/);
	});
});
