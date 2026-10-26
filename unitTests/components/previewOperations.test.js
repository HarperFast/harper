'use strict';

// enable_previews / disable_previews / get_preview_policy (harper#3042) against real system tables: what enable
// writes, that it only ever creates, and that disable revokes before it removes and drops only the application's own
// previews. The end-to-end run through the CLI is integrationTests/deploy/preview-setup.test.ts.
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { enablePreviews, disablePreviews, getPreviewPolicy } = require('#src/components/previewOperations');
const { deployComponent, getComponents } = require('#js/components/operations');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const { addRole, getRoleByName } = require('#src/security/role');
const { addUser, getUserWithRole } = require('#src/security/user');
const { addOidcTrust, listOidcTrust } = require('#src/security/authn/oidc/trustPolicyOperations');
const { server } = require('#js/server/Server');
const { preserveRootConfig, removeDeployedComponents } = require('../rootConfigFixture.js');

const SU = { username: 'admin', role: { role: 'super_user', permission: { super_user: true } } };
const AUDIENCE = 'https://cluster.example.com:9925/';
const enableRequest = (app, overrides = {}) => ({
	operation: 'enable_previews',
	app,
	repository: 'acme/web',
	repository_id: '67890',
	branch: 'main',
	audience: AUDIENCE,
	hdb_user: SU,
	...overrides,
});
const policiesOf = async (app) =>
	(await listOidcTrust({ operation: 'list_oidc_trust', hdb_user: SU })).policies.filter((policy) =>
		policy.id.startsWith(`github-actions-${app}-preview`)
	);

describe('enable_previews / disable_previews / get_preview_policy (harper#3042)', function () {
	this.timeout(30_000);
	preserveRootConfig();
	removeDeployedComponents();
	let workDirectory;
	let payload;

	before(async () => {
		await testUtils.ensureSystemTables();
		workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-operations-'));
		const source = path.join(workDirectory, 'source');
		await fs.mkdir(source);
		await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'preview', version: '1.0.0' }));
		payload = (await packageDirectory(source, { skip_node_modules: true })).toString('base64');
	});

	after(async () => {
		resetRestartNeeded();
		if (workDirectory) await fs.rm(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it('is refused to a caller that is not a super user, even one whose operations allowlist names it', async () => {
		const delegated = {
			username: 'ops',
			role: {
				role: 'ops',
				permission: { super_user: false, operations: ['enable_previews', 'disable_previews', 'get_preview_policy'] },
			},
		};
		for (const operation of [enablePreviews, disablePreviews, getPreviewPolicy]) {
			await assert.rejects(operation(enableRequest('nosu', { hdb_user: delegated })), { statusCode: 403 });
		}
	});

	it('creates the role, user and both trust policies, and reads them back as enabled', async () => {
		const response = await enablePreviews(enableRequest('web', { maxPreviews: 3, maxTtlDays: 5 }));
		assert.match(response.message, /Enabled previews of web: created role web-ci-preview, user web-ci-preview/);
		assert.strictEqual(response.enabled, true, JSON.stringify(response.problems));

		const role = await getRoleByName('web-ci-preview');
		assert.deepStrictEqual(role.permission.component_deploy, {
			names: ['web-pr-*'],
			constraints: {
				isolated: true,
				hostSuffix: '.app.cluster.example.com',
				branchedDatabases: 'required',
				preview: 'required',
				maxPreviews: 3,
				maxTtlDays: 5,
			},
		});
		assert.deepStrictEqual([...role.permission.operations].sort(), [
			'deploy_component',
			'drop_component',
			'get_components',
			'get_deployment',
			'registration_info',
		]);
		assert.strictEqual(role.permission.super_user, false);
		const user = getUserWithRole('web-ci-preview');
		assert.strictEqual(user.active, true);
		assert.strictEqual(user.role.role, 'web-ci-preview');

		const [deploy, cleanup] = (await policiesOf('web')).sort((a, b) => a.id.localeCompare(b.id));
		const claims = {
			repository_id: '67890',
			workflow_ref: 'acme/web/.github/workflows/preview.yaml@refs/heads/main',
			event_name: 'pull_request_target',
		};
		assert.strictEqual(deploy.id, 'github-actions-web-preview');
		assert.deepStrictEqual(deploy.claims, { ...claims, environment: 'preview' });
		assert.strictEqual(deploy.audience, AUDIENCE);
		assert.strictEqual(deploy.user, 'web-ci-preview');
		assert.strictEqual(cleanup.id, 'github-actions-web-preview-cleanup');
		assert.deepStrictEqual(cleanup.claims, { ...claims, environment: 'preview-cleanup' });
		assert.deepStrictEqual(cleanup.operations, ['drop_component']);

		const policy = await getPreviewPolicy({ operation: 'get_preview_policy', app: 'web', hdb_user: SU });
		assert.strictEqual(policy.enabled, true);
		assert.strictEqual(policy.repository, 'acme/web');
		assert.strictEqual(policy.workflow, '.github/workflows/preview.yaml');
		assert.strictEqual(policy.branch, 'main');
		assert.strictEqual(policy.environment, 'preview');
		assert.strictEqual(policy.cleanupEnvironment, 'preview-cleanup');
	});

	it('changes nothing when run again, and stops before writing when a record differs', async () => {
		const rerun = await enablePreviews(enableRequest('web', { maxPreviews: 3, maxTtlDays: 5 }));
		assert.match(rerun.message, /already enabled; nothing changed/);
		await assert.rejects(enablePreviews(enableRequest('web', { maxPreviews: 4, maxTtlDays: 5 })), (error) => {
			assert.strictEqual(error.statusCode, 409);
			assert.match(error.message, /Nothing was changed/);
			assert.match(error.message, /its component_deploy grant is/);
			return true;
		});
		assert.strictEqual((await getRoleByName('web-ci-preview')).permission.component_deploy.constraints.maxPreviews, 3);
	});

	it('refuses what could never be told apart, before it writes anything', async () => {
		await assert.rejects(enablePreviews(enableRequest('envs', { environment: 'preview-cleanup' })), {
			statusCode: 400,
		});
		await assert.rejects(enablePreviews(enableRequest('ip', { audience: 'https://10.0.0.1:9925/' })), /hostSuffix/);

		await addRole({ role: 'rival', permission: { super_user: false, operations: ['drop_component'] } });
		await addUser({ username: 'rival', role: 'rival', active: true, password: 'Rival-Password-1' });
		await addOidcTrust({
			operation: 'add_oidc_trust',
			hdb_user: SU,
			id: 'rival',
			issuer: 'https://token.actions.githubusercontent.com',
			audience: AUDIENCE,
			user: 'rival',
			// An array the generated scalar is a member of still matches the same runs.
			claims: {
				repository_id: '67890',
				workflow_ref: 'acme/web/.github/workflows/rival.yaml@refs/heads/main',
				event_name: ['pull_request_target', 'push'],
			},
		});
		await assert.rejects(
			enablePreviews(enableRequest('overlap', { workflow: '.github/workflows/rival.yaml' })),
			/Trust policy "rival" would also match the runs/
		);
		assert.strictEqual(await getRoleByName('overlap-ci-preview'), null);
	});

	describe('disable_previews', () => {
		const deploy = (project, preview) =>
			deployComponent({ operation: 'deploy_component', payload, restart: false, project, preview, hdb_user: SU });
		const metadata = (app, pr) => ({ app, pr, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
		const componentNames = async () => (await getComponents()).entries.map((entry) => entry.name);

		it('drops only previews of the application, then removes the trust policies, user and role', async () => {
			await deploy('web-pr-1', metadata('web', 1));
			await deploy('web-pr-tools');
			await deploy('web-pr-pr-3', metadata('web-pr', 3));

			const response = await disablePreviews({ operation: 'disable_previews', app: 'web', hdb_user: SU });
			assert.deepStrictEqual(
				response.dropped.map((drop) => [drop.project, drop.componentRemoved]),
				[['web-pr-1', true]]
			);
			assert.deepStrictEqual(response.removed.sort(), [
				'role web-ci-preview',
				'trust policy github-actions-web-preview',
				'trust policy github-actions-web-preview-cleanup',
				'user web-ci-preview',
			]);
			const names = await componentNames();
			assert.ok(!names.includes('web-pr-1'));
			assert.ok(names.includes('web-pr-tools') && names.includes('web-pr-pr-3'), names.join(', '));
			assert.strictEqual(await getRoleByName('web-ci-preview'), null);
			assert.strictEqual(getUserWithRole('web-ci-preview'), undefined);
			assert.deepStrictEqual(await policiesOf('web'), []);

			const policy = await getPreviewPolicy({ operation: 'get_preview_policy', app: 'web', hdb_user: SU });
			assert.strictEqual(policy.enabled, false);
			assert.ok(policy.problems.includes('role "web-ci-preview" is missing'));
		});

		it("still names a preview this node no longer holds, from its deployment's record", async () => {
			await enablePreviews(enableRequest('web'));
			const response = await disablePreviews({ operation: 'disable_previews', app: 'web', hdb_user: SU });
			assert.deepStrictEqual(
				response.dropped.map((drop) => [drop.project, drop.componentRemoved]),
				[['web-pr-1', false]]
			);
		});

		it('stops with the identity revoked when a node fails to drop, and finishes when run again', async () => {
			await enablePreviews(enableRequest('shop'));
			await deploy('shop-pr-2', metadata('shop', 2));
			const replicateOperation = server.replication.replicateOperation;
			server.replication.replicateOperation = async () => ({
				replicated: [{ node: 'node-b', status: 'failed', reason: 'unreachable' }],
			});
			try {
				await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'shop', hdb_user: SU }), (error) => {
					assert.strictEqual(error.statusCode, 500);
					assert.match(error.message, /revoked but not removed: shop-pr-2 on node-b: unreachable/);
					return true;
				});
			} finally {
				server.replication.replicateOperation = replicateOperation;
			}
			assert.deepStrictEqual(await policiesOf('shop'), []);
			assert.strictEqual(getUserWithRole('shop-ci-preview').active, false);
			assert.ok(await getRoleByName('shop-ci-preview'), 'the role is kept until every drop succeeds');

			const finished = await disablePreviews({ operation: 'disable_previews', app: 'shop', hdb_user: SU });
			assert.deepStrictEqual(finished.removed.sort(), ['role shop-ci-preview', 'user shop-ci-preview']);
			assert.strictEqual(getUserWithRole('shop-ci-preview'), undefined);
		});

		it('refuses, changing nothing, when a record named like the identity is not one enable wrote', async () => {
			await addRole({ role: 'odd-ci-preview', permission: { super_user: false, operations: ['deploy_component'] } });
			await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'odd', hdb_user: SU }), (error) => {
				assert.strictEqual(error.statusCode, 409);
				assert.match(error.message, /Role "odd-ci-preview" is not a preview role for odd-pr-\* alone/);
				return true;
			});
			assert.ok(await getRoleByName('odd-ci-preview'));
		});
	});
});
