'use strict';

const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	enablePreviews,
	disablePreviews,
	fencePreviewReleases,
	getPreviewPolicy,
} = require('#src/components/previewOperations');
const { deployComponent, getComponents } = require('#js/components/operations');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const { addRole, alterRole, getRoleByName } = require('#src/security/role');
const { addUser, getUserWithRole } = require('#src/security/user');
const { addOidcTrust, dropOidcTrust, listOidcTrust } = require('#src/security/authn/oidc/trustPolicyOperations');
const { databases } = require('#src/resources/databases');
const { server } = require('#js/server/Server');
const { preserveRootConfig, removeDeployedComponents } = require('../rootConfigFixture.js');

const SU = { username: 'admin', role: { role: 'super_user', permission: { super_user: true } } };
const AUDIENCE = 'https://cluster.example.com:9925/';
const enableRequest = (app, overrides = {}) => ({
	operation: 'enable_previews',
	app,
	repository: `acme/${app}`,
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
			await assert.rejects(operation(enableRequest('opsnosu', { hdb_user: delegated })), { statusCode: 403 });
		}
	});

	it('creates the role, user and both trust policies, and reads them back as enabled', async () => {
		const response = await enablePreviews(enableRequest('opsweb', { maxPreviews: 3, maxTtlDays: 5 }));
		assert.match(
			response.message,
			/Enabled previews of opsweb: created role opsweb-ci-preview, user opsweb-ci-preview/
		);
		assert.strictEqual(response.enabled, true, JSON.stringify(response.problems));

		const role = await getRoleByName('opsweb-ci-preview');
		assert.deepStrictEqual(role.permission.component_deploy, {
			names: ['opsweb-pr-*'],
			constraints: {
				isolated: true,
				hostSuffix: '.app.cluster.example.com',
				branchedDatabases: 'required',
				preview: 'required',
				maxPreviews: 3,
				maxTtlDays: 5,
				generation: role.permission.component_deploy.constraints.generation,
			},
		});
		assert.match(role.permission.component_deploy.constraints.generation, /^[\w-]{8,64}$/);
		assert.deepStrictEqual([...role.permission.operations].sort(), [
			'deploy_component',
			'drop_component',
			'get_components',
			'get_deployment',
			'registration_info',
		]);
		assert.strictEqual(role.permission.super_user, false);
		const user = getUserWithRole('opsweb-ci-preview');
		assert.strictEqual(user.active, true);
		assert.strictEqual(user.role.role, 'opsweb-ci-preview');

		const [deploy, cleanup] = (await policiesOf('opsweb')).sort((a, b) => a.id.localeCompare(b.id));
		const claims = {
			repository_id: '67890',
			workflow_ref: 'acme/opsweb/.github/workflows/preview.yaml@refs/heads/main',
			event_name: 'pull_request_target',
		};
		assert.strictEqual(deploy.id, 'github-actions-opsweb-preview');
		assert.deepStrictEqual(deploy.claims, { ...claims, environment: 'preview' });
		assert.strictEqual(deploy.audience, AUDIENCE);
		assert.strictEqual(deploy.user, 'opsweb-ci-preview');
		assert.strictEqual(cleanup.id, 'github-actions-opsweb-preview-cleanup');
		assert.deepStrictEqual(cleanup.claims, { ...claims, environment: 'preview-cleanup' });
		assert.deepStrictEqual(cleanup.operations, ['drop_component']);

		const policy = await getPreviewPolicy({ operation: 'get_preview_policy', app: 'opsweb', hdb_user: SU });
		assert.strictEqual(policy.enabled, true);
		assert.strictEqual(policy.repository, 'acme/opsweb');
		assert.strictEqual(policy.workflow, '.github/workflows/preview.yaml');
		assert.strictEqual(policy.branch, 'main');
		assert.strictEqual(policy.environment, 'preview');
		assert.strictEqual(policy.cleanupEnvironment, 'preview-cleanup');
	});

	it('changes nothing when run again, and stops before writing when a record differs', async () => {
		const rerun = await enablePreviews(enableRequest('opsweb', { maxPreviews: 3, maxTtlDays: 5 }));
		assert.match(rerun.message, /already enabled; nothing changed/);
		await assert.rejects(enablePreviews(enableRequest('opsweb', { maxPreviews: 4, maxTtlDays: 5 })), (error) => {
			assert.strictEqual(error.statusCode, 409);
			assert.match(error.message, /Nothing was changed/);
			assert.match(error.message, /its component_deploy grant is/);
			return true;
		});
		assert.strictEqual(
			(await getRoleByName('opsweb-ci-preview')).permission.component_deploy.constraints.maxPreviews,
			3
		);
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
				workflow_ref: 'acme/opsoverlap/.github/workflows/rival.yaml@refs/heads/main',
				event_name: ['pull_request_target', 'push'],
			},
		});
		await assert.rejects(
			enablePreviews(enableRequest('opsoverlap', { workflow: '.github/workflows/rival.yaml' })),
			/Trust policy "rival" would also match the runs/
		);
		assert.strictEqual(await getRoleByName('opsoverlap-ci-preview'), null);
	});

	it('caps the time to live at 7 days unless told otherwise, and takes the branch as a ref or a name', async () => {
		await enablePreviews(enableRequest('opsttl', { branch: 'refs/heads/trunk' }));
		assert.strictEqual(
			(await getRoleByName('opsttl-ci-preview')).permission.component_deploy.constraints.maxTtlDays,
			7
		);
		const policy = await getPreviewPolicy({ operation: 'get_preview_policy', app: 'opsttl', hdb_user: SU });
		assert.strictEqual(policy.branch, 'trunk');
		await assert.rejects(enablePreviews(enableRequest('opsbranch', { branch: 'refs/heads/' })), { statusCode: 400 });
	});

	it('reports a role whose operations no longer let CI deploy', async () => {
		await enablePreviews(enableRequest('opsnarrow'));
		const role = await getRoleByName('opsnarrow-ci-preview');
		await alterRole({
			id: role.id,
			role: role.role,
			permission: { ...role.permission, operations: ['drop_component'] },
		});
		const policy = await getPreviewPolicy({ operation: 'get_preview_policy', app: 'opsnarrow', hdb_user: SU });
		assert.strictEqual(policy.enabled, false);
		assert.match(
			policy.problems.join(),
			/role "opsnarrow-ci-preview" allows \["drop_component"\], not deploy_component/
		);
		const { isolated: _isolated, ...unisolated } = role.permission.component_deploy.constraints;
		await alterRole({
			id: role.id,
			role: role.role,
			permission: { ...role.permission, component_deploy: { names: ['opsnarrow-pr-*'], constraints: unisolated } },
		});
		const stripped = await getPreviewPolicy({ operation: 'get_preview_policy', app: 'opsnarrow', hdb_user: SU });
		assert.ok(
			stripped.problems.includes('role "opsnarrow-ci-preview" no longer requires isolated previews under a host suffix')
		);
	});

	it('gives each enablement its own identity generation, and keeps it while it stays enabled', async () => {
		const generationOf = async () =>
			(await getRoleByName('opsgen-ci-preview')).permission.component_deploy.constraints.generation;
		await enablePreviews(enableRequest('opsgen'));
		const first = await generationOf();
		assert.match(first, /^[\w-]{8,}$/);
		await enablePreviews(enableRequest('opsgen'));
		assert.strictEqual(await generationOf(), first, 'a rerun matches what is there');
		await disablePreviews({ operation: 'disable_previews', app: 'opsgen', hdb_user: SU });
		await enablePreviews(enableRequest('opsgen'));
		assert.notStrictEqual(await generationOf(), first);
	});

	it('says how to fence previews of a role enabled before generations, which a rerun keeps as it is', async () => {
		await enablePreviews(enableRequest('opslegacy'));
		const role = await getRoleByName('opslegacy-ci-preview');
		const { generation: _generation, ...constraints } = role.permission.component_deploy.constraints;
		await alterRole({
			id: role.id,
			role: role.role,
			permission: { ...role.permission, component_deploy: { ...role.permission.component_deploy, constraints } },
		});
		const legacy =
			/role "opslegacy-ci-preview" predates revocation generations, .* disable previews, and again once that lists none inProgress, .* then enable them again/;
		const policy = await getPreviewPolicy({ operation: 'get_preview_policy', app: 'opslegacy', hdb_user: SU });
		assert.strictEqual(policy.enabled, false);
		assert.match(policy.problems.join(), legacy);

		const rerun = await enablePreviews(enableRequest('opslegacy'));
		assert.match(rerun.message, /already enabled; nothing changed, but role "opslegacy-ci-preview" predates/);
		assert.deepStrictEqual(rerun.created, []);
		assert.match(rerun.problems.join(), legacy);
		assert.strictEqual(
			(await getRoleByName('opslegacy-ci-preview')).permission.component_deploy.constraints.generation,
			undefined,
			'the rerun wrote nothing'
		);

		// A deploy the old role started, which goes live unfenced if it gets past its admission.
		const { databases } = require('#src/resources/databases');
		await databases.system.hdb_deployment.put({
			deployment_id: 'opslegacy-in-flight',
			project: 'opslegacy-pr-1',
			status: 'pending',
			preview: { app: 'opslegacy', pr: 1 },
		});
		try {
			const disabled = await disablePreviews({ operation: 'disable_previews', app: 'opslegacy', hdb_user: SU });
			assert.deepStrictEqual(disabled.inProgress, ['opslegacy-pr-1']);
			assert.match(disabled.message, /predated revocation generations, .* disable previews again once none is/);
		} finally {
			await databases.system.hdb_deployment.delete('opslegacy-in-flight');
		}
		const again = await disablePreviews({ operation: 'disable_previews', app: 'opslegacy', hdb_user: SU });
		assert.strictEqual(again.inProgress, undefined);
		assert.doesNotMatch(again.message, /predated/, 'with the role gone, the rerun has nothing more to say');
		const reenabled = await enablePreviews(enableRequest('opslegacy'));
		assert.strictEqual(reenabled.enabled, true, JSON.stringify(reenabled.problems));
		assert.match(reenabled.grant.constraints.generation, /^[\w-]{8,}$/);
	});

	it('takes the enablement lock from a worker of this process that died holding it', async () => {
		const { getConfigPath } = require('#src/config/configUtils');
		const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
		const {
			COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
			componentPreparationLockPaths,
		} = require('#src/components/componentPreparationLock');
		const { lockRoot, lockName } = componentPreparationLockPaths(
			path.join(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), '.preview-enablement')
		);
		await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
		const orphan = path.join(lockRoot, `${lockName}.ticket.1.crashed-worker.json`);
		await fs.writeFile(
			orphan,
			JSON.stringify({
				pid: process.pid,
				threadId: 987654,
				processInstanceId: COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
				token: 'crashed-worker',
				ticket: 1,
			})
		);
		let timer;
		try {
			await Promise.race([
				enablePreviews(enableRequest('opsorphan')),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("enable waited behind the dead worker's ticket")), 10_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		await assert.rejects(fs.stat(orphan), { code: 'ENOENT' });
	});

	it('reports a trust policy that no longer allows what enable gave it', async () => {
		await enablePreviews(enableRequest('opsscope'));
		const rewrite = async (id, operations) => {
			const { id: _id, enabled: _enabled, ...kept } = (await policiesOf('opsscope')).find((p) => p.id === id);
			await dropOidcTrust({ operation: 'drop_oidc_trust', id, hdb_user: SU });
			const { issuer, audience, user, claims, description } = kept;
			await addOidcTrust({
				operation: 'add_oidc_trust',
				hdb_user: SU,
				id,
				issuer,
				audience,
				user,
				claims,
				description,
				operations,
			});
		};
		await rewrite('github-actions-opsscope-preview', ['drop_component']);
		await rewrite('github-actions-opsscope-preview-cleanup', ['deploy_component', 'drop_component']);
		const policy = await getPreviewPolicy({ operation: 'get_preview_policy', app: 'opsscope', hdb_user: SU });
		assert.strictEqual(policy.enabled, false);
		assert.deepStrictEqual(policy.problems, [
			'trust policy "github-actions-opsscope-preview" allows ["drop_component"], not deploy_component, drop_component, get_components, get_deployment, registration_info',
			'trust policy "github-actions-opsscope-preview-cleanup" allows ["deploy_component","drop_component"], not drop_component',
		]);
	});

	it('lets another policy that gives a run the same authority stand, since the exchange accepts it', async () => {
		await enablePreviews(enableRequest('opsagree'));
		const { id: _id, ...preview } = (await policiesOf('opsagree')).find(
			(policy) => policy.id === 'github-actions-opsagree-preview'
		);
		const { issuer, audience, user, claims, operations, description } = preview;
		await addOidcTrust({
			operation: 'add_oidc_trust',
			hdb_user: SU,
			id: 'by-hand-opsagree',
			issuer,
			audience,
			user,
			claims,
			operations,
			description,
		});
		const again = await enablePreviews(enableRequest('opsagree'));
		assert.match(again.message, /already enabled; nothing changed/);
	});

	it('does not count as a rival a row the exchange would not honor', async () => {
		const { databases } = require('#src/resources/databases');
		const { SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
		const table = databases.system[SYSTEM_TABLE_NAMES.OIDC_TRUST_TABLE_NAME];
		await enablePreviews(enableRequest('opsbroad'));
		const { issuer, audience } = (await policiesOf('opsbroad'))[0];
		await disablePreviews({ operation: 'disable_previews', app: 'opsbroad', hdb_user: SU });
		await table.put('broad-row', {
			id: 'broad-row',
			issuer,
			audience,
			user: 'admin',
			claims: { repository_id: '67890' },
		});
		try {
			const response = await enablePreviews(enableRequest('opsbroad'));
			assert.strictEqual(response.enabled, true, JSON.stringify(response.problems));
		} finally {
			await table.delete('broad-row');
		}
	});

	it('lets only one of two applications enabled at once claim the same workflow runs', async () => {
		const workflow = '.github/workflows/shared.yaml';
		const outcomes = await Promise.allSettled([
			enablePreviews(enableRequest('opsonea', { workflow, repository: 'acme/shared' })),
			enablePreviews(enableRequest('opsoneb', { workflow, repository: 'acme/shared' })),
		]);
		assert.deepStrictEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
		assert.match(outcomes.find((outcome) => outcome.status === 'rejected').reason.message, /would also match the runs/);
	});

	describe('disable_previews', () => {
		const deploy = (project, preview) =>
			deployComponent({ operation: 'deploy_component', payload, restart: false, project, preview, hdb_user: SU });
		const metadata = (app, pr) => ({ app, pr, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
		const componentNames = async () => (await getComponents()).entries.map((entry) => entry.name);

		it('drops only previews of the application, then removes the trust policies, user and role', async () => {
			await deploy('opsweb-pr-1', metadata('opsweb', 1));
			await deploy('opsweb-pr-tools');
			await deploy('opsweb-pr-pr-3', metadata('opsweb-pr', 3));

			const response = await disablePreviews({ operation: 'disable_previews', app: 'opsweb', hdb_user: SU });
			assert.deepStrictEqual(
				response.dropped.map((drop) => [drop.project, drop.componentRemoved]),
				[['opsweb-pr-1', true]]
			);
			assert.deepStrictEqual(response.removed.sort(), [
				'role opsweb-ci-preview',
				'trust policy github-actions-opsweb-preview',
				'trust policy github-actions-opsweb-preview-cleanup',
				'user opsweb-ci-preview',
			]);
			const names = await componentNames();
			assert.ok(!names.includes('opsweb-pr-1'));
			assert.ok(names.includes('opsweb-pr-tools') && names.includes('opsweb-pr-pr-3'), names.join(', '));
			assert.strictEqual(await getRoleByName('opsweb-ci-preview'), null);
			assert.strictEqual(getUserWithRole('opsweb-ci-preview'), undefined);
			assert.deepStrictEqual(await policiesOf('opsweb'), []);

			const policy = await getPreviewPolicy({ operation: 'get_preview_policy', app: 'opsweb', hdb_user: SU });
			assert.strictEqual(policy.enabled, false);
			assert.ok(policy.problems.includes('role "opsweb-ci-preview" is missing'));
		});

		it('keeps a component redeployed under the name as something else', async () => {
			await enablePreviews(enableRequest('opsweb'));
			await deploy('opsweb-pr-5', metadata('opsweb', 5));
			await deploy('opsweb-pr-5');
			const response = await disablePreviews({ operation: 'disable_previews', app: 'opsweb', hdb_user: SU });
			assert.deepStrictEqual(response.dropped, []);
			assert.ok((await componentNames()).includes('opsweb-pr-5'));
		});

		/** Stands in for harper-pro: a peer node-b that reports `peerReleases` and answers drops with `answerDrop`. */
		function withPeer(peerReleases, answerDrop, { fenced = true } = {}) {
			const replication = server.replication;
			const saved = {
				replicateOperation: replication.replicateOperation,
				sendOperationToNode: replication.sendOperationToNode,
			};
			const savedNodes = server.nodes;
			const sent = [];
			replication.replicateOperation = async () => ({
				replicated: [{ node: 'node-b', components: peerReleases, ...(fenced && { fenced: true }) }],
			});
			replication.sendOperationToNode = async (node, operation) => {
				sent.push({ node: node.name, ...operation });
				return answerDrop(operation);
			};
			server.nodes = [{ name: 'node-b' }];
			return {
				sent,
				restore() {
					Object.assign(replication, saved);
					server.nodes = savedNodes;
				},
			};
		}

		it('drops the preview release a peer still holds, whatever its expiry, on that peer and at that release', async () => {
			await enablePreviews(enableRequest('opsexp'));
			const expired = { app: 'opsexp', pr: 1, expiresAt: '2000-01-01T00:00:00.000Z' };
			const { deployment_id } = await deploy('opsexp-pr-1', expired);
			await deploy('opsexp-pr-1');
			const peer = withPeer([{ project: 'opsexp-pr-1', deployment_id }], () => ({ value: { componentRemoved: true } }));
			let response;
			try {
				response = await disablePreviews({ operation: 'disable_previews', app: 'opsexp', hdb_user: SU });
			} finally {
				peer.restore();
			}
			assert.deepStrictEqual(
				response.dropped.map(({ node, project, componentRemoved }) => [node, project, componentRemoved]),
				[['node-b', 'opsexp-pr-1', true]]
			);
			assert.deepStrictEqual(peer.sent, [
				{
					node: 'node-b',
					operation: 'drop_component',
					project: 'opsexp-pr-1',
					ifDeploymentId: deployment_id,
					restart: false,
					replicated: false,
				},
			]);
			assert.ok((await componentNames()).includes('opsexp-pr-1'), "this node's later release is kept");
		});

		it('stops with the identity revoked when a node fails to drop, and finishes when run again', async () => {
			await enablePreviews(enableRequest('opsshop'));
			const { deployment_id } = await deploy('opsshop-pr-2', metadata('opsshop', 2));
			const peer = withPeer([{ project: 'opsshop-pr-2', deployment_id }], () => {
				throw new Error('unreachable');
			});
			try {
				await assert.rejects(
					disablePreviews({ operation: 'disable_previews', app: 'opsshop', hdb_user: SU }),
					(error) => {
						assert.strictEqual(error.statusCode, 500);
						assert.match(error.message, /revoked but not removed: opsshop-pr-2 on node-b: unreachable/);
						return true;
					}
				);
			} finally {
				peer.restore();
			}
			assert.ok(!(await componentNames()).includes('opsshop-pr-2'), 'this node dropped its own');
			assert.deepStrictEqual(await policiesOf('opsshop'), []);
			assert.strictEqual(getUserWithRole('opsshop-ci-preview').active, false);
			assert.ok(await getRoleByName('opsshop-ci-preview'), 'the role is kept until every drop succeeds');

			const finished = await disablePreviews({ operation: 'disable_previews', app: 'opsshop', hdb_user: SU });
			assert.deepStrictEqual(finished.removed.sort(), ['role opsshop-ci-preview', 'user opsshop-ci-preview']);
			assert.strictEqual(getUserWithRole('opsshop-ci-preview'), undefined);
		});

		it("fences on a peer as harper-pro runs an authorized node's operation, and refuses anyone else not a super user", async () => {
			const { operation } = require('#src/server/serverHelpers/serverUtilities');
			const generation = 'opspeer-generation';
			const request = () => ({ operation: 'fence_preview_releases', app: 'opspeer', generation, replicated: false });
			// What harper-pro's replication connection passes: the origin node's identity, with no role, and authorization
			// checked only when the connection is not an authorized node's.
			const originNode = { name: 'node-a', replicates: true };
			await assert.rejects(
				async () => operation(request(), { user: originNode }, true),
				/This operation is not authorized/
			);
			await assert.rejects(
				fencePreviewReleases({
					...request(),
					hdb_user: { username: 'ci', role: { permission: { super_user: false } } },
				}),
				{ statusCode: 403 }
			);
			const answer = await operation(request(), { user: originNode }, false);
			assert.strictEqual(answer.fenced, true);
			await assert.rejects(deploy('opspeer-pr-1', { ...metadata('opspeer', 1), generation }), {
				statusCode: 403,
				message: /previews of opspeer .* were disabled/,
			});
		});

		it('stops when a peer answers the census without acknowledging the fence', async () => {
			await enablePreviews(enableRequest('opsack'));
			const peer = withPeer([], () => ({}), { fenced: false });
			try {
				await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'opsack', hdb_user: SU }), {
					statusCode: 500,
					message: /revoked but not removed: node-b: it did not acknowledge the fence/,
				});
			} finally {
				peer.restore();
			}
			assert.ok(await getRoleByName('opsack-ci-preview'), 'the role is kept until every node acknowledges');
		});

		it('reports a node that cannot fence as revoked but not removed', async () => {
			const { getConfigPath } = require('#src/config/configUtils');
			const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
			await enablePreviews(enableRequest('opsbroken'));
			const directory = path.join(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), '.preview-revoked');
			await fs.mkdir(directory, { recursive: true });
			const file = path.join(directory, 'opsbroken.json');
			await fs.writeFile(file, 'not json');
			try {
				await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'opsbroken', hdb_user: SU }), {
					statusCode: 500,
					message: /revoked but not removed/,
				});
			} finally {
				await fs.rm(file);
			}
			await disablePreviews({ operation: 'disable_previews', app: 'opsbroken', hdb_user: SU });
		});

		it('fences this node, so a build of the revoked identity cannot go live here afterwards', async () => {
			await enablePreviews(enableRequest('opsfence'));
			const generation = (await getRoleByName('opsfence-ci-preview')).permission.component_deploy.constraints
				.generation;
			await disablePreviews({ operation: 'disable_previews', app: 'opsfence', hdb_user: SU });
			await assert.rejects(deploy('opsfence-pr-1', { ...metadata('opsfence', 1), generation }), {
				statusCode: 403,
				message: /previews of opsfence .* were disabled/,
			});
			assert.ok(!(await componentNames()).includes('opsfence-pr-1'));
		});

		it('waits out a preview swap under way when it disables, then drops what that swap made live', async () => {
			const previews = require('#src/components/previews');
			await enablePreviews(enableRequest('opsrace'));
			const generation = (await getRoleByName('opsrace-ci-preview')).permission.component_deploy.constraints.generation;
			const real = previews.admitPreviewActivation;
			let entered;
			let release;
			const inSwap = new Promise((resolve) => (entered = resolve));
			const gate = new Promise((resolve) => (release = resolve));
			previews.admitPreviewActivation = (component, dir, activate, ...rest) =>
				real(
					component,
					dir,
					async () => {
						entered();
						await gate;
						return activate();
					},
					...rest
				);
			let deploying;
			let disabling;
			try {
				deploying = deploy('opsrace-pr-1', { ...metadata('opsrace', 1), generation });
				await inSwap;
				let settled = false;
				disabling = disablePreviews({ operation: 'disable_previews', app: 'opsrace', hdb_user: SU }).finally(
					() => (settled = true)
				);
				await new Promise((resolve) => setTimeout(resolve, 300));
				assert.strictEqual(settled, false, 'disable waits for the swap under way');
			} finally {
				release();
				previews.admitPreviewActivation = real;
			}
			await deploying;
			const response = await disabling;
			assert.deepStrictEqual(
				response.dropped.map((drop) => [drop.project, drop.componentRemoved]),
				[['opsrace-pr-1', true]]
			);
			assert.ok(!(await componentNames()).includes('opsrace-pr-1'));
		});

		async function disableAgainstNewerRelease(app, newer) {
			await enablePreviews(enableRequest(app));
			const { deployment_id } = await deploy(`${app}-pr-3`, metadata(app, 3));
			await databases.system.hdb_deployment.put(newer.deployment_id, { project: `${app}-pr-3`, ...newer });
			const releases = [{ project: `${app}-pr-3`, deployment_id }];
			const peer = withPeer(releases, () => {
				releases[0] = { project: `${app}-pr-3`, deployment_id: newer.deployment_id };
				return { value: { componentRemoved: false, message: `Did not drop ${app}-pr-3` } };
			});
			try {
				return await disablePreviews({ operation: 'disable_previews', app, hdb_user: SU });
			} finally {
				peer.restore();
				await databases.system.hdb_deployment.delete(newer.deployment_id);
			}
		}

		it('stops with the identity revoked when a drop finds a newer preview release live in its place', async () => {
			const newer = { deployment_id: 'opsnewer-y', status: 'success', preview: metadata('opsnewer', 3) };
			await assert.rejects(disableAgainstNewerRelease('opsnewer', newer), {
				statusCode: 500,
				message: /revoked but not removed: opsnewer-pr-3 on node-b: release opsnewer-y is still live/,
			});
			assert.ok(await getRoleByName('opsnewer-ci-preview'), 'the role is kept until the release is dropped');
			const finished = await disablePreviews({ operation: 'disable_previews', app: 'opsnewer', hdb_user: SU });
			assert.deepStrictEqual(finished.removed.sort(), ['role opsnewer-ci-preview', 'user opsnewer-ci-preview']);
		});

		it('names a release once when its drop failed and another drop removed nothing', async () => {
			await enablePreviews(enableRequest('opsboth'));
			const kept = await deploy('opsboth-pr-3', metadata('opsboth', 3));
			const failing = await deploy('opsboth-pr-4', metadata('opsboth', 4));
			const peer = withPeer(
				[
					{ project: 'opsboth-pr-3', deployment_id: kept.deployment_id },
					{ project: 'opsboth-pr-4', deployment_id: failing.deployment_id },
				],
				(operation) => {
					if (operation.project === 'opsboth-pr-4') throw new Error('unreachable');
					return { value: { componentRemoved: false } };
				}
			);
			try {
				await assert.rejects(
					disablePreviews({ operation: 'disable_previews', app: 'opsboth', hdb_user: SU }),
					(error) => {
						assert.strictEqual(error.message.match(/opsboth-pr-4 on node-b/g).length, 1);
						assert.match(error.message, /opsboth-pr-3 on node-b: release \S+ is still live/);
						return true;
					}
				);
			} finally {
				peer.restore();
			}
			await disablePreviews({ operation: 'disable_previews', app: 'opsboth', hdb_user: SU });
		});

		it('keeps what it knows when the census after the drops fails', async () => {
			await enablePreviews(enableRequest('opslost'));
			const { deployment_id } = await deploy('opslost-pr-3', metadata('opslost', 3));
			const peer = withPeer([{ project: 'opslost-pr-3', deployment_id }], () => {
				server.replication.replicateOperation = async () => {
					throw new Error('census down');
				};
				return { value: { componentRemoved: false } };
			});
			try {
				await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'opslost', hdb_user: SU }), {
					statusCode: 500,
					message: /revoked but not removed: the census after the drops: census down/,
				});
			} finally {
				peer.restore();
			}
			assert.ok(await getRoleByName('opslost-ci-preview'), 'the role is kept for the rerun');
			await disablePreviews({ operation: 'disable_previews', app: 'opslost', hdb_user: SU });
		});

		it('stops when a node cannot read what it holds in the census after the drops', async () => {
			await enablePreviews(enableRequest('opsunread'));
			const { deployment_id } = await deploy('opsunread-pr-3', metadata('opsunread', 3));
			const peer = withPeer([{ project: 'opsunread-pr-3', deployment_id }], () => {
				// A peer's plain list_releases leaves out a component whose live release it cannot read.
				server.replication.replicateOperation = async (request) => ({
					replicated: [
						request.operation === 'fence_preview_releases'
							? { node: 'node-b', error: 'cannot read opsunread-pr-3' }
							: { node: 'node-b', components: [] },
					],
				});
				return { value: { componentRemoved: false } };
			});
			try {
				await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'opsunread', hdb_user: SU }), {
					statusCode: 500,
					message: /revoked but not removed: node-b: cannot read opsunread-pr-3/,
				});
			} finally {
				peer.restore();
			}
			assert.ok(await getRoleByName('opsunread-ci-preview'), 'the role is kept for the rerun');
			await disablePreviews({ operation: 'disable_previews', app: 'opsunread', hdb_user: SU });
		});

		it('finishes when what a drop finds live in its place is not a preview', async () => {
			const newer = { deployment_id: 'opsother-y', status: 'success', preview: null };
			const response = await disableAgainstNewerRelease('opsother', newer);
			assert.deepStrictEqual(
				response.dropped.map(({ node, componentRemoved }) => [node, componentRemoved]),
				[
					['127.0.0.1', true],
					['node-b', false],
				]
			);
			assert.ok(response.removed.includes('role opsother-ci-preview'));
		});

		it('lists as in progress a deploy, or an activation of a staged build, that has not finished', async () => {
			await enablePreviews(enableRequest('opspending'));
			const rows = [
				{
					deployment_id: 'opspending-a',
					project: 'opspending-pr-1',
					status: 'pending',
					preview: metadata('opspending', 1),
				},
				{
					deployment_id: 'opspending-b',
					project: 'opspending-pr-2',
					status: 'staged',
					preview: metadata('opspending', 2),
				},
				{
					deployment_id: 'opspending-c',
					project: 'opspending-pr-2',
					status: 'pending',
					activated_from: 'opspending-b',
				},
				{ deployment_id: 'opspending-d', project: 'opspending-pr-3', status: 'pending', preview: null },
			];
			const table = databases.system.hdb_deployment;
			for (const row of rows) await table.put(row.deployment_id, row);
			try {
				const response = await disablePreviews({ operation: 'disable_previews', app: 'opspending', hdb_user: SU });
				assert.deepStrictEqual(response.inProgress, ['opspending-pr-1', 'opspending-pr-2']);
			} finally {
				for (const row of rows) await table.delete(row.deployment_id);
			}
		});

		it('stops when a peer holds a release this node has no record of', async () => {
			await enablePreviews(enableRequest('opsnew'));
			const peer = withPeer([{ project: 'opsnew-pr-1', deployment_id: 'not-replicated-yet' }], () => ({}));
			try {
				await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'opsnew', hdb_user: SU }), {
					statusCode: 500,
					message: /node-b: opsnew-pr-1 is at release not-replicated-yet, which this node has no record of yet/,
				});
			} finally {
				peer.restore();
			}
			assert.deepStrictEqual(peer.sent, [], 'nothing is dropped on a guess');
		});

		it('stops when a peer does not answer at all', async () => {
			await enablePreviews(enableRequest('opsmute'));
			const peer = withPeer([], () => ({}));
			server.nodes = [{ name: 'node-b' }, { name: 'node-z' }];
			try {
				await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'opsmute', hdb_user: SU }), {
					statusCode: 500,
					message: /revoked but not removed: node-z: it did not answer/,
				});
			} finally {
				peer.restore();
			}
		});

		it('stops when a node cannot say what it holds', async () => {
			await enablePreviews(enableRequest('opsquiet'));
			const replicateOperation = server.replication.replicateOperation;
			server.replication.replicateOperation = async () => ({
				replicated: [{ node: 'node-c', status: 'failed', reason: 'timed out' }],
			});
			try {
				await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'opsquiet', hdb_user: SU }), {
					statusCode: 500,
					message: /revoked but not removed: node-c: timed out/,
				});
			} finally {
				server.replication.replicateOperation = replicateOperation;
			}
			assert.ok(await getRoleByName('opsquiet-ci-preview'));
		});

		it('refuses, changing nothing, a user named like the identity in another role, the role absent', async () => {
			await addRole({ role: 'opsother', permission: { super_user: false, operations: ['get_components'] } });
			await addUser({ username: 'opsalien-ci-preview', role: 'opsother', active: true, password: 'Alien-Password-1' });
			await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'opsalien', hdb_user: SU }), {
				statusCode: 409,
				message: /User "opsalien-ci-preview" is in role "opsother"/,
			});
			assert.strictEqual(getUserWithRole('opsalien-ci-preview').active, true);
		});

		it('refuses, changing nothing, when a record named like the identity is not one enable wrote', async () => {
			await addRole({ role: 'opsodd-ci-preview', permission: { super_user: false, operations: ['deploy_component'] } });
			await assert.rejects(disablePreviews({ operation: 'disable_previews', app: 'opsodd', hdb_user: SU }), (error) => {
				assert.strictEqual(error.statusCode, 409);
				assert.match(error.message, /role "opsodd-ci-preview" is not a preview role for opsodd-pr-\* alone/);
				return true;
			});
			assert.ok(await getRoleByName('opsodd-ci-preview'));
			const policy = await getPreviewPolicy({ operation: 'get_preview_policy', app: 'opsodd', hdb_user: SU });
			assert.ok(policy.problems.includes('role "opsodd-ci-preview" is not a preview role for opsodd-pr-* alone'));
		});
	});
});
