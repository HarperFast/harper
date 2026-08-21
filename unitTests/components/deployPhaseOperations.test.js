'use strict';

const assert = require('node:assert');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const tarfs = require('tar-fs');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const operations = require('#src/components/operations');
const { DEPLOY_STAGING_DIR, DEPLOY_ACTIVATION_DIR, discardStagedApplication } = require('#src/components/Application');
const { restartNeeded, resetRestartNeeded } = require('#src/components/requestRestart');
const { server } = require('#src/server/Server');
const { databases } = require('#src/resources/databases');
const { SYSTEM_TABLE_NAMES, CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { getConfigPath, readConfigFile } = require('#src/config/configUtils');
const environment = require('#src/utility/environment/environmentManager');
const { runWithOperationAuthorizationBypass } = require('#src/server/serverHelpers/operationAuthorizationState');
const manageThreads = require('#src/server/threads/manageThreads');

const COMPONENTS_ROOT = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
const DEPLOYMENT_TABLE = SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;

function packDirectory(directory) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		tarfs
			.pack(directory)
			.pipe(zlib.createGzip())
			.on('data', (chunk) => chunks.push(chunk))
			.on('end', () => resolve(Buffer.concat(chunks)))
			.on('error', reject);
	});
}

async function makePayload(marker, version = marker, withNodeModules = true) {
	const source = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-phase-op-'));
	await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'phase-op', version }));
	await fs.writeFile(path.join(source, 'index.js'), `module.exports = ${JSON.stringify(marker)};\n`);
	if (withNodeModules) await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
	const payload = await packDirectory(source);
	await fs.rm(source, { recursive: true, force: true });
	return payload;
}

describe('deploy_component two-phase orchestration', function () {
	this.timeout(30_000);
	const rows = new Map();
	let priorTable;
	let priorReplicate;
	let priorSafeMode;
	let sequence = 0;
	const names = [];

	before(async () => {
		priorSafeMode = process.env.HARPER_SAFE_MODE;
		process.env.HARPER_SAFE_MODE = 'true';
		// The first component operation completes lazy server initialization, which replaces
		// databases.system. Run it before installing the table seam used by these tests.
		const warmupProject = name();
		const warmup = await operations.deployComponent({
			project: warmupProject,
			payload: await makePayload('warmup'),
			activate: false,
		});
		await fs.rm(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR, warmup.deployment_id), {
			recursive: true,
			force: true,
		});
		if (!databases.system) databases.system = {};
		priorTable = databases.system[DEPLOYMENT_TABLE];
	});

	beforeEach(() => {
		resetRestartNeeded();
		rows.clear();
		databases.system[DEPLOYMENT_TABLE] = {
			async get(id) {
				return rows.get(id);
			},
			async put(row) {
				rows.set(row.deployment_id, { ...row });
			},
			async patch(id, partial) {
				const row = rows.get(id);
				if (row) rows.set(id, { ...row, ...partial });
			},
			async *search(conditions = []) {
				for (const row of rows.values()) {
					if (conditions.every((condition) => row[condition.attribute] === condition.value)) yield row;
				}
			},
		};
		priorReplicate = server.replication.replicateOperation;
		server.replication.replicateOperation = async () => ({ replicated: [] });
	});

	afterEach(() => {
		server.replication.replicateOperation = priorReplicate;
		resetRestartNeeded();
	});

	after(async () => {
		if (priorSafeMode === undefined) delete process.env.HARPER_SAFE_MODE;
		else process.env.HARPER_SAFE_MODE = priorSafeMode;
		if (priorTable === undefined) delete databases.system[DEPLOYMENT_TABLE];
		else databases.system[DEPLOYMENT_TABLE] = priorTable;
		for (const name of names) await fs.rm(path.join(COMPONENTS_ROOT, name), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, DEPLOY_ACTIVATION_DIR), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, '.deploy-aside'), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, '.deploy-previous'), { recursive: true, force: true });
	});

	function name() {
		const value = `phase_op_${process.pid}_${sequence++}`;
		names.push(value);
		return value;
	}

	it('normalizes string request booleans, including install_allow_scripts', async () => {
		// Joi coerces these, but validateBySchema discards `result.value`, so the raw string reaches the
		// handler. `install_allow_scripts: 'false'` would then read as truthy and run package lifecycle
		// scripts for a caller that explicitly disabled them — over multipart/form, where every value
		// arrives as a string.
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('1.0.0'),
			activate: 'false',
			install_allow_scripts: 'false',
		});

		assert.strictEqual(staged.staged, true, "activate:'false' is honored as stage-only, not as a full deploy");
		assert.strictEqual(existsSync(path.join(COMPONENTS_ROOT, project)), false, 'so nothing goes live');
		assert.strictEqual(
			rows.get(staged.deployment_id).activation_spec.install_allow_scripts,
			false,
			'and the activation spec records a real boolean, not the string'
		);
	});

	it('stages without touching live and records an immutable activation specification', async () => {
		const project = name();
		const result = await operations.deployComponent({
			project,
			payload: await makePayload('1.0.0'),
			activate: false,
		});

		assert.strictEqual(result.staged, true);
		assert.match(result.deployment_id, /^[0-9a-f-]{36}$/i);
		assert.strictEqual(existsSync(path.join(COMPONENTS_ROOT, project)), false);
		assert.strictEqual(existsSync(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR, result.deployment_id, project)), true);
		const row = rows.get(result.deployment_id);
		assert.ok(row, `deployment row missing; present ids: ${Array.from(rows.keys()).join(', ')}`);
		assert.strictEqual(row.status, 'staged');
		assert.deepStrictEqual(row.activation_spec, {
			project,
			package: null,
			install_command: null,
			install_timeout: null,
			install_allow_scripts: null,
			urlPath: null,
			host: null,
			credentials: null,
			force: false,
		});
	});

	it('uses a no-custody literal registry token for the origin install without recording it', async () => {
		const project = name();
		const token = 'transient-origin-token';
		const installCommand =
			`node -e "const fs=require('fs');` +
			`const value=fs.readFileSync(process.env.npm_config_userconfig||process.env.NPM_CONFIG_USERCONFIG,'utf8');` +
			`if(!value.includes('//registry.example.com/:_authToken='))process.exit(7);` +
			`fs.writeFileSync('credential-seen','yes')"`;
		const result = await operations.deployComponent({
			project,
			payload: await makePayload('credential-origin', '6.0.0', false),
			install_command: installCommand,
			credentials: [{ registry: 'https://registry.example.com', token }],
			activate: false,
		});

		const stagedPath = path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR, result.deployment_id, project);
		assert.strictEqual(await fs.readFile(path.join(stagedPath, 'credential-seen'), 'utf8'), 'yes');
		assert.strictEqual(rows.get(result.deployment_id).activation_spec.credentials, null);
		assert.doesNotMatch(JSON.stringify(rows.get(result.deployment_id)), new RegExp(token));
	});

	it('activates only a staged row owned by the requested project', async () => {
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('2.0.0'),
			activate: false,
		});

		await assert.rejects(
			operations.deployComponent({ project: `${project}_other`, deployment_id: staged.deployment_id }),
			/not a staged deployment/
		);
		const activated = await operations.deployComponent({ project, deployment_id: staged.deployment_id });

		assert.strictEqual(activated.activated, true);
		assert.strictEqual(rows.get(staged.deployment_id).status, 'success');
		assert.match(await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'), /2.0.0/);
	});

	it('does not let a duplicate activation undo the winning activation state', async () => {
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('duplicate-winner', '6.0.0'),
			activate: false,
		});

		const outcomes = await Promise.allSettled([
			operations.deployComponent({ project, deployment_id: staged.deployment_id }),
			operations.deployComponent({ project, deployment_id: staged.deployment_id }),
		]);

		assert.strictEqual(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
		assert.strictEqual(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
		assert.strictEqual(rows.get(staged.deployment_id).status, 'success');
		assert.match(await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'), /duplicate-winner/);
	});

	it('rejects fresh build or routing input on activate-by-id', async () => {
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('3.0.0'),
			activate: false,
		});

		await assert.rejects(
			operations.deployComponent({
				project,
				deployment_id: staged.deployment_id,
				install_command: 'npm install --evil',
			}),
			/immutable staged configuration.*install_command/
		);
	});

	it('stages and activates a full deploy before reporting success', async () => {
		const project = name();
		const result = await operations.deployComponent({
			project,
			payload: await makePayload('full-deploy', '6.0.0'),
		});

		assert.match(result.message, /Successfully deployed/);
		assert.strictEqual(rows.get(result.deployment_id).status, 'success');
		assert.match(await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'), /full-deploy/);
		assert.strictEqual(existsSync(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR, result.deployment_id)), false);
		assert.strictEqual(restartNeeded(), true, 'a new component activated without restart requires one');
	});

	// ————————————————————————————————————————————————————————————————————————————
	// revert_component (harper#1849 review, @kriszyp)
	// ————————————————————————————————————————————————————————————————————————————

	it('reverts the cluster to a named previous deployment and fans the target out to peers', async () => {
		const project = name();
		const first = await operations.deployComponent({ project, payload: await makePayload('rev-v1', '1.0.0') });
		const second = await operations.deployComponent({ project, payload: await makePayload('rev-v2', '2.0.0') });
		const fanout = [];
		server.replication.replicateOperation = async (op) => {
			fanout.push(op);
			return { replicated: [] };
		};

		const result = await operations.revertComponent({ project, to_deployment_id: first.deployment_id });

		assert.strictEqual(result.reverted, true);
		assert.strictEqual(result.to_deployment_id, first.deployment_id);
		assert.strictEqual(result.from_deployment_id, second.deployment_id);
		assert.match(await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'), /rev-v1/);
		assert.strictEqual(rows.get(result.deployment_id).status, 'rolled_back');
		assert.strictEqual(
			rows.get(result.deployment_id).rollback_of,
			second.deployment_id,
			'the audit row records which deployment the rollback took out of service'
		);
		assert.strictEqual(fanout.length, 1, 'peers get the revert');
		assert.strictEqual(fanout[0].operation, 'revert_component');
		assert.strictEqual(
			fanout[0].to_deployment_id,
			first.deployment_id,
			'peers are told WHICH version to end on, so the fan-out is idempotent per node'
		);
	});

	it('is a no-op when the requested deployment is already live, so a retry is safe', async () => {
		const project = name();
		const first = await operations.deployComponent({ project, payload: await makePayload('retry-v1', '1.0.0') });
		await operations.deployComponent({ project, payload: await makePayload('retry-v2', '2.0.0') });
		await operations.revertComponent({ project, to_deployment_id: first.deployment_id });

		// The caller lost the first response and retried the identical request.
		const retry = await operations.revertComponent({ project, to_deployment_id: first.deployment_id });

		assert.strictEqual(retry.reverted, false);
		assert.match(retry.message, /already running/);
		assert.match(
			await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'),
			/retry-v1/,
			'a retried revert must not toggle the rejected version back in'
		);
	});

	it('rejects a revert with no target, and one whose target is not retained', async () => {
		const project = name();
		await operations.deployComponent({ project, payload: await makePayload('target-v1', '1.0.0') });
		await operations.deployComponent({ project, payload: await makePayload('target-v2', '2.0.0') });

		await assert.rejects(
			() => operations.revertComponent({ project }),
			/to_deployment_id/,
			'the target is mandatory — that is what makes a retry safe'
		);
		await assert.rejects(
			() => operations.revertComponent({ project, to_deployment_id: '00000000-0000-4000-8000-000000000000' }),
			/neither the live version/,
			'only the immediately-previous version is retained'
		);
		assert.match(
			await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'),
			/target-v2/,
			'a refused revert changes nothing'
		);
	});

	it('takes the package reference out of root config when reverting away from a package deploy', async () => {
		// Without this, installApplications() would reinstall the reverted-away package over the restored
		// directory on the next cold start and silently undo the rollback.
		const project = name();
		const packaged = await operations.deployComponent({
			project,
			payload: await makePayload('cfg-packaged', '1.0.0'),
		});
		// Stamp root config as a package deploy would have, then activate a payload version over it.
		const { addConfig } = require('#src/config/configUtils');
		await addConfig(project, { package: 'some-pkg@1.0.0' });
		const plain = await operations.deployComponent({ project, payload: await makePayload('cfg-plain', '2.0.0') });
		assert.ok(plain.deployment_id);

		await operations.revertComponent({ project, to_deployment_id: packaged.deployment_id });

		const entry = readConfigFile()?.[project];
		assert.strictEqual(
			entry?.package,
			undefined,
			'the reverted-to version had no package reference, so the stale one must be gone'
		);
	});

	it('reclaims an oversized payload only after a full two-phase activation succeeds', async () => {
		const project = name();
		const priorMaxSize = environment.get(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_MAXSIZE);
		environment.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_MAXSIZE, 1);
		try {
			const result = await operations.deployComponent({
				project,
				payload: await makePayload('reclaimed-full-deploy', '6.0.0'),
			});

			const row = rows.get(result.deployment_id);
			assert.strictEqual(row.status, 'success');
			assert.strictEqual(row.payload_blob, null);
			assert.ok(row.event_log.some((event) => event.event === 'payload_dropped'));
		} finally {
			environment.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_MAXSIZE, priorMaxSize);
		}
	});

	it('reclaims an oversized retained payload after activate-by-id succeeds', async () => {
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('reclaimed-staged-deploy', '6.0.0'),
			activate: false,
		});
		assert.ok(rows.get(staged.deployment_id).payload_blob, 'staged deployment keeps its recovery payload');

		const priorMaxSize = environment.get(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_MAXSIZE);
		environment.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_MAXSIZE, 1);
		try {
			await operations.deployComponent({ project, deployment_id: staged.deployment_id });

			const row = rows.get(staged.deployment_id);
			assert.strictEqual(row.status, 'success');
			assert.strictEqual(row.payload_blob, null);
			assert.ok(row.event_log.some((event) => event.event === 'payload_dropped'));
		} finally {
			environment.setProperty(CONFIG_PARAMS.DEPLOYMENT_PAYLOADRETENTION_MAXSIZE, priorMaxSize);
		}
	});

	it('preserves the legacy one-shot path when explicitly requested', async () => {
		const project = name();
		const result = await operations.deployComponent({
			project,
			payload: await makePayload('one-shot', '6.0.0'),
			two_phase: false,
		});

		assert.match(result.message, /Successfully deployed/);
		assert.match(await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'), /one-shot/);
	});

	it('accepts the legacy deployment row marker only from a trusted replicated operation', async () => {
		const project = name();
		const payload = await makePayload('trusted-one-shot', '6.0.0');
		const result = await runWithOperationAuthorizationBypass(true, () =>
			operations.deployComponent({
				project,
				payload,
				two_phase: false,
				_deploymentId: '41faded8-6cf5-4a2a-95f8-863e7ea498fa',
				replicated: false,
				hdb_user: { name: 'cluster-peer' },
			})
		);

		assert.match(result.message, /Successfully deployed/);
		assert.match(await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'), /trusted-one-shot/);
	});

	it('fails closed on the preview phase marker even from a trusted peer', async () => {
		await assert.rejects(
			runWithOperationAuthorizationBypass(true, () =>
				operations.deployComponent({
					project: name(),
					_phase: 'stage',
					replicated: false,
					hdb_user: { name: 'cluster-peer' },
				})
			),
			/Unsupported legacy component deployment phase/
		);
	});

	it('fails closed on an activate peer failure before scheduling a restart', async () => {
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('4.0.0'),
			activate: false,
		});
		const phases = [];
		server.replication.replicateOperation = async (operation) => {
			phases.push(operation.phase);
			if (operation.phase === 'activate') {
				return { replicated: [{ node: 'peer-a', status: 'failed', reason: 'config write failed' }] };
			}
			return { replicated: [] };
		};

		await assert.rejects(
			operations.deployComponent({ project, deployment_id: staged.deployment_id, restart: true }),
			/Split nodes: peer-a.*[Rr]oll forward/s
		);
		assert.deepStrictEqual(phases, ['activate'], 'restart phase was never sent after the activation gate failed');
		assert.strictEqual(rows.get(staged.deployment_id).status, 'activating');
		assert.strictEqual(rows.get(staged.deployment_id).completed_at, null);
		assert.ok(rows.get(staged.deployment_id).payload_blob, 'payload remains available to repair a split cluster');
		assert.strictEqual(rows.get(staged.deployment_id).peer_results[0].node, 'peer-a');
	});

	it('records success when restart fails after the activation barrier', async () => {
		const project = name();
		const phases = [];
		server.replication.replicateOperation = async (operation) => {
			phases.push(operation.phase);
			return operation.phase === 'restart'
				? { replicated: [{ node: 'peer-a', status: 'failed', reason: 'restart unavailable' }] }
				: { replicated: [] };
		};
		const priorRestartWorkers = manageThreads.restartWorkers;
		manageThreads.restartWorkers = () => {};
		let deploymentId;
		try {
			await assert.rejects(
				operations
					.deployComponent({
						project,
						payload: await makePayload('activated-before-restart-failure', '6.0.0'),
						restart: true,
					})
					.catch((error) => {
						deploymentId = error.http_resp_msg?.deployment_id;
						throw error;
					}),
				/restart failed/
			);
		} finally {
			manageThreads.restartWorkers = priorRestartWorkers;
		}

		assert.deepStrictEqual(phases, ['stage', 'activate', 'restart']);
		assert.strictEqual(rows.get(deploymentId).status, 'success');
		assert.match(await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'), /activated-before/);
	});

	it('records peer failures but honors ignore_replication_errors', async () => {
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('ignored-peer', '6.0.0'),
			activate: false,
		});
		server.replication.replicateOperation = async () => ({
			replicated: [{ node: 'peer-a', status: 'failed', reason: 'offline' }],
		});

		const result = await operations.deployComponent({
			project,
			deployment_id: staged.deployment_id,
			ignore_replication_errors: true,
		});

		assert.strictEqual(result.activated, true);
		assert.strictEqual(rows.get(staged.deployment_id).status, 'success');
		assert.strictEqual(rows.get(staged.deployment_id).peer_results[0].status, 'failed');
	});

	it('records and surfaces ignored restart failures after the activation gate', async () => {
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('restart-failure', '6.0.0'),
			activate: false,
		});
		const phases = [];
		server.replication.replicateOperation = async (operation) => {
			phases.push(operation.phase);
			return operation.phase === 'restart'
				? { replicated: [{ node: 'peer-a', status: 'failed', reason: 'restart unavailable' }] }
				: { replicated: [] };
		};
		const priorRestartWorkers = manageThreads.restartWorkers;
		let localRestarts = 0;
		manageThreads.restartWorkers = () => localRestarts++;
		let result;
		try {
			result = await operations.deployComponent({
				project,
				deployment_id: staged.deployment_id,
				restart: true,
				ignore_replication_errors: true,
			});
		} finally {
			manageThreads.restartWorkers = priorRestartWorkers;
		}

		assert.deepStrictEqual(phases, ['activate', 'restart']);
		assert.strictEqual(localRestarts, 1);
		assert.strictEqual(result.activated, true);
		assert.strictEqual(result.failed_peers[0].node, 'peer-a');
		assert.strictEqual(rows.get(staged.deployment_id).peer_results[0].status, 'failed');
	});

	it('uses the row-backed immutable specification for trusted peer phases', async () => {
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('peer-phase', '6.0.0'),
			activate: false,
		});
		const row = rows.get(staged.deployment_id);
		const componentPath = path.join(COMPONENTS_ROOT, project);
		await discardStagedApplication(componentPath, staged.deployment_id);
		const executePeerPhase = (phase, activationSpec) =>
			runWithOperationAuthorizationBypass(true, () =>
				operations.componentDeployPhase({
					operation: 'component_deploy_phase',
					phase,
					project,
					deployment_id: staged.deployment_id,
					activation_spec: activationSpec,
					replicated: false,
					hdb_user: { name: 'cluster-peer' },
				})
			);

		await assert.rejects(
			executePeerPhase('stage', { ...row.activation_spec, host: 'tampered.example' }),
			/immutable activation specification/
		);
		await executePeerPhase('stage', row.activation_spec);
		assert.strictEqual(existsSync(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR, staged.deployment_id, project)), true);
		await executePeerPhase('activate', row.activation_spec);
		assert.match(await fs.readFile(path.join(componentPath, 'index.js'), 'utf8'), /peer-phase/);
		assert.strictEqual(rows.get(staged.deployment_id).status, 'activating');
		assert.strictEqual(restartNeeded(), true);
	});

	it('rebuilds a missing peer stage from the durable deployment payload before activation', async () => {
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('rebuilt-peer', '6.0.0'),
			activate: false,
		});
		const row = rows.get(staged.deployment_id);
		const componentPath = path.join(COMPONENTS_ROOT, project);
		await discardStagedApplication(componentPath, staged.deployment_id);

		await runWithOperationAuthorizationBypass(true, () =>
			operations.componentDeployPhase({
				operation: 'component_deploy_phase',
				phase: 'activate',
				project,
				deployment_id: staged.deployment_id,
				activation_spec: row.activation_spec,
				replicated: false,
				hdb_user: { name: 'cluster-peer' },
			})
		);

		assert.match(await fs.readFile(path.join(componentPath, 'index.js'), 'utf8'), /rebuilt-peer/);
		assert.strictEqual(rows.get(staged.deployment_id).status, 'activating');
	});

	it('waits for the staged row checkpoint when peer activation arrives first', async () => {
		const project = name();
		const staged = await operations.deployComponent({
			project,
			payload: await makePayload('lagged-row', '6.0.0'),
			activate: false,
		});
		const row = rows.get(staged.deployment_id);
		rows.set(staged.deployment_id, { ...row, status: 'staging' });
		setImmediate(() => rows.set(staged.deployment_id, { ...rows.get(staged.deployment_id), status: 'staged' }));

		await runWithOperationAuthorizationBypass(true, () =>
			operations.componentDeployPhase({
				operation: 'component_deploy_phase',
				phase: 'activate',
				project,
				deployment_id: staged.deployment_id,
				activation_spec: row.activation_spec,
				deployment_timeout: 200,
				replicated: false,
				hdb_user: { name: 'cluster-peer' },
			})
		);

		assert.match(await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'), /lagged-row/);
		assert.strictEqual(rows.get(staged.deployment_id).status, 'activating');
	});

	it('recovers a staged package specification for config and peer activation', async () => {
		const project = name();
		const tarDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-phase-package-'));
		const tarPath = path.join(tarDirectory, 'component.tgz');
		await fs.writeFile(tarPath, await makePayload('package-stage', '6.0.0'));
		const packageIdentifier = `file:${tarPath}`;
		const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-phase-config-'));
		const configPath = path.join(configRoot, 'harper-config.yaml');
		await fs.writeFile(configPath, `rootPath: ${JSON.stringify(configRoot)}\n`);
		const priorRootEnv = process.env.ROOTPATH;
		const priorRootConfig = getConfigPath(CONFIG_PARAMS.ROOTPATH);
		process.env.ROOTPATH = configRoot;
		environment.setProperty(CONFIG_PARAMS.ROOTPATH, configRoot);
		try {
			const staged = await operations.deployComponent({
				project,
				package: packageIdentifier,
				activate: false,
			});
			let activationOperation;
			server.replication.replicateOperation = async (operation) => {
				activationOperation = operation;
				return { replicated: [] };
			};

			await operations.deployComponent({ project, deployment_id: staged.deployment_id });

			assert.strictEqual(readConfigFile()[project].package, packageIdentifier);
			assert.strictEqual(activationOperation.operation, 'component_deploy_phase');
			assert.strictEqual(activationOperation.activation_spec.package, packageIdentifier);
		} finally {
			if (priorRootEnv === undefined) delete process.env.ROOTPATH;
			else process.env.ROOTPATH = priorRootEnv;
			environment.setProperty(CONFIG_PARAMS.ROOTPATH, priorRootConfig);
			await fs.rm(configRoot, { recursive: true, force: true });
			await fs.rm(tarDirectory, { recursive: true, force: true });
		}
	});

	it('drop_component invalidates staged rows and removes recovery artifacts', async () => {
		const project = name();
		const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-phase-drop-'));
		const componentsRoot = path.join(configRoot, 'components');
		const configPath = path.join(configRoot, 'harper-config.yaml');
		const priorRootEnv = process.env.ROOTPATH;
		const priorRootConfig = getConfigPath(CONFIG_PARAMS.ROOTPATH);
		const priorComponentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
		process.env.ROOTPATH = configRoot;
		environment.setProperty(CONFIG_PARAMS.ROOTPATH, configRoot);
		environment.setProperty(CONFIG_PARAMS.COMPONENTSROOT, componentsRoot);
		await fs.writeFile(configPath, `rootPath: ${JSON.stringify(configRoot)}\n`);
		try {
			const staged = await operations.deployComponent({
				project,
				payload: await makePayload('drop-stage', '6.0.0'),
				activate: false,
			});
			const activationPath = path.join(componentsRoot, DEPLOY_ACTIVATION_DIR, project, 'interrupted');
			await fs.mkdir(activationPath, { recursive: true });
			await fs.writeFile(
				path.join(configRoot, 'harper-application-lock.json'),
				JSON.stringify({ applications: { [project]: { package: 'stale-package' } } })
			);

			await operations.dropComponent({ project });

			assert.strictEqual(rows.get(staged.deployment_id).status, 'failed');
			const deploymentStagePath = path.join(componentsRoot, DEPLOY_STAGING_DIR, staged.deployment_id);
			assert.strictEqual(
				existsSync(deploymentStagePath),
				false,
				`staged deployment directory still contains: ${await fs.readdir(deploymentStagePath).catch(() => [])}`
			);
			assert.strictEqual(existsSync(path.join(componentsRoot, DEPLOY_ACTIVATION_DIR, project)), false);
			const applicationLock = JSON.parse(await fs.readFile(path.join(configRoot, 'harper-application-lock.json')));
			assert.strictEqual(applicationLock.applications[project], undefined);
		} finally {
			if (priorRootEnv === undefined) delete process.env.ROOTPATH;
			else process.env.ROOTPATH = priorRootEnv;
			environment.setProperty(CONFIG_PARAMS.ROOTPATH, priorRootConfig);
			environment.setProperty(CONFIG_PARAMS.COMPONENTSROOT, priorComponentsRoot);
			await fs.rm(configRoot, { recursive: true, force: true });
		}
	});

	it('rejects separated-phase controls on the one-shot fallback', async () => {
		await assert.rejects(
			operations.deployComponent({
				project: name(),
				payload: await makePayload('5.0.0'),
				activate: false,
				two_phase: false,
			}),
			/require two-phase deploy/
		);
	});

	it('rejects an explicit two-phase request when the system database is not replicated', async () => {
		const priorReplications = environment.get(CONFIG_PARAMS.REPLICATION_DATABASES);
		environment.setProperty(CONFIG_PARAMS.REPLICATION_DATABASES, ['data']);
		try {
			await assert.rejects(
				operations.deployComponent({
					project: name(),
					payload: await makePayload('requires-system-replication'),
					two_phase: true,
				}),
				/requires system database replication/
			);
		} finally {
			environment.setProperty(CONFIG_PARAMS.REPLICATION_DATABASES, priorReplications);
		}
	});

	it('does not trust caller-supplied internal phase markers', async () => {
		await assert.rejects(
			operations.deployComponent({
				project: name(),
				payload: await makePayload('untrusted-replication'),
				replicated: false,
				two_phase: true,
			}),
			/requires operation replication/
		);
		await assert.rejects(
			operations.deployComponent({
				project: name(),
				_deploymentId: '../../escape',
				_phase: 'stage',
			}),
			/is not allowed/
		);
		await assert.rejects(
			operations.componentDeployPhase({
				operation: 'component_deploy_phase',
				phase: 'discard',
				project: name(),
				deployment_id: '41faded8-6cf5-4a2a-95f8-863e7ea498fa',
				activation_spec: { project: 'anything' },
			}),
			/restricted to authenticated cluster peers/
		);
		await assert.rejects(
			runWithOperationAuthorizationBypass(true, () =>
				operations.componentDeployPhase({
					operation: 'component_deploy_phase',
					phase: 'discard',
					project: '../escape',
					deployment_id: '41faded8-6cf5-4a2a-95f8-863e7ea498fa',
					activation_spec: { project: '../escape' },
					replicated: false,
					hdb_user: { name: 'cluster-peer' },
				})
			),
			/project name/i
		);
	});
});
