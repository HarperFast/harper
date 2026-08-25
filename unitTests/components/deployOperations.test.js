'use strict';

const assert = require('node:assert');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const tarfs = require('tar-fs');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { DEPLOY_STAGING_DIR, DEPLOY_ACTIVATION_DIR } = require('#src/components/Application');
const operations = require('#src/components/operations');
const { restartNeeded, resetRestartNeeded } = require('#src/components/requestRestart');
const { server } = require('#src/server/Server');
const { databases } = require('#src/resources/databases');
const { SYSTEM_TABLE_NAMES, CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { getConfigPath, readConfigFile } = require('#src/config/configUtils');
const environment = require('#src/utility/environment/environmentManager');
const { runWithOperationAuthorizationBypass } = require('#src/server/serverHelpers/operationAuthorizationState');

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

describe('deploy_component staged deploy', function () {
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
		//
		// One-shot on purpose: the separated phases now require deployment tracking, and the whole point
		// of this warmup is that it runs BEFORE the table seam exists. `after` removes the component
		// directory along with every other fixture name.
		await operations.deployComponent({
			project: name(),
			payload: await makePayload('warmup'),
			restart: false,
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

	it('replicates the payload itself when there is no deployment table to carry it', async () => {
		// The legacy single-phase path is the documented escape hatch, so it has to actually be safe. It
		// normally strips `req.payload` because peers read the bytes from the row's payload_blob — but with
		// no table there is no row, so stripping left peers holding a `_deploymentId`, no bytes and nothing
		// to resolve, after this node was already live. Asserting on the REPLICATED REQUEST, not just on
		// local activation: replication is stubbed here, so a local-only assertion proves nothing about peers.
		const project = name();
		const priorTable = databases.system[DEPLOYMENT_TABLE];
		const priorReplicate = server.replication.replicateOperation;
		const replicated = [];
		server.replication.replicateOperation = async (op) => {
			replicated.push(op);
			return { replicated: [] };
		};
		delete databases.system[DEPLOYMENT_TABLE];
		try {
			// A real Readable, not a reusable Buffer: ingest DRAINS the source, so a Buffer would hide the
			// actual failure (peers receiving an exhausted stream / EOF).
			const bytes = await makePayload('untracked-oneshot');
			await operations.deployComponent({
				project,
				payload: Readable.from([bytes]),
				restart: false,
			});
			assert.match(
				await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'),
				/untracked-oneshot/,
				'the component goes live locally'
			);
			assert.strictEqual(replicated.length, 1, 'the deploy is replicated to peers');
			// Assert the BYTES, not merely that the property exists — presence of a spent stream is exactly
			// the bug this covers.
			const sent = replicated[0].payload;
			assert.strictEqual(Buffer.isBuffer(sent), true, `peers must receive replayable bytes, got ${typeof sent}`);
			assert.strictEqual(Buffer.compare(sent, bytes), 0, 'and the bytes must be the payload that was uploaded');
		} finally {
			server.replication.replicateOperation = priorReplicate;
			databases.system[DEPLOYMENT_TABLE] = priorTable;
		}
	});

	it('normalizes a string install_allow_scripts rather than reading it as truthy', async () => {
		// Joi coerces it, but validateBySchema discards `result.value`, so the raw string reaches the
		// handler. `install_allow_scripts: 'false'` would then read as truthy and run package lifecycle
		// scripts for a caller that explicitly disabled them — over multipart/form, where every value
		// arrives as a string.
		const project = name();
		const result = await operations.deployComponent({
			project,
			payload: await makePayload('1.0.0'),
			install_allow_scripts: 'false',
			restart: false,
		});

		assert.ok(result, 'the deploy succeeds');
		assert.strictEqual(
			rows.get(result.deployment_id).activation_spec.install_allow_scripts,
			false,
			'and the activation spec records a real boolean, not the string'
		);
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
			restart: false,
		});

		// The install ran in the staging directory; the marker it wrote travels with the tree through the
		// swap, so it lands at the live path.
		assert.strictEqual(
			await fs.readFile(path.join(COMPONENTS_ROOT, project, 'credential-seen'), 'utf8'),
			'yes',
			'the install saw the credential, and its output was swapped in with the tree'
		);
		assert.strictEqual(rows.get(result.deployment_id).activation_spec.credentials, null);
		assert.doesNotMatch(JSON.stringify(rows.get(result.deployment_id)), new RegExp(token));
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

	// revert_component

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

	it('accepts the legacy deployment row marker only from a trusted replicated operation', async () => {
		const project = name();
		const payload = await makePayload('trusted-one-shot', '6.0.0');
		const result = await runWithOperationAuthorizationBypass(true, () =>
			operations.deployComponent({
				project,
				payload,
				_deploymentId: '41faded8-6cf5-4a2a-95f8-863e7ea498fa',
				replicated: false,
				hdb_user: { name: 'cluster-peer' },
			})
		);

		assert.match(result.message, /Successfully deployed/);
		assert.match(await fs.readFile(path.join(COMPONENTS_ROOT, project, 'index.js'), 'utf8'), /trusted-one-shot/);
	});

	it('never leaves a component discoverable with its routing config already gone', async () => {
		// Applications in the components root load by DIRECTORY SCAN; the root-config entry is what
		// constrains where one is served (host/urlPath). So the state to make unreachable is tree-present
		// with entry-gone — a crash there resurrects the component on every host, silently dropping the
		// isolation the operator configured. The tree is parked first and the entry removed only after,
		// which leaves the opposite (and merely re-runnable) partial state instead.
		const project = name();
		const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-drop-crash-'));
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
			await fs.mkdir(path.join(componentsRoot, project), { recursive: true });
			await fs.writeFile(path.join(componentsRoot, project, 'index.js'), "module.exports = 'live';\n");
			await fs.appendFile(configPath, `${project}:\n  package: some-package@1.0.0\n`);
			// Make every aside-based teardown step fail: `.deploy-aside` occupied by a file is rejected as
			// "not a directory", which is the closest deterministic stand-in for dying mid-teardown.
			await fs.writeFile(path.join(componentsRoot, '.deploy-aside'), 'not a directory\n');

			await assert.rejects(() => operations.dropComponent({ project }));

			const treePresent = existsSync(path.join(componentsRoot, project));
			const entryPresent = (await fs.readFile(configPath, 'utf8')).includes(project);
			assert.strictEqual(treePresent, true, 'teardown failed, so the live tree is still on disk');
			assert.strictEqual(
				entryPresent,
				true,
				'and its routing entry survived with it — a discoverable tree must never outlive its mount'
			);
		} finally {
			if (priorRootEnv === undefined) delete process.env.ROOTPATH;
			else process.env.ROOTPATH = priorRootEnv;
			environment.setProperty(CONFIG_PARAMS.ROOTPATH, priorRootConfig);
			environment.setProperty(CONFIG_PARAMS.COMPONENTSROOT, priorComponentsRoot);
			await fs.rm(configRoot, { recursive: true, force: true });
		}
	});

	it('drop_component removes leftover recovery artifacts and the root-config entry', async () => {
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
				restart: false,
			});
			const activationPath = path.join(componentsRoot, DEPLOY_ACTIVATION_DIR, project, 'interrupted');
			await fs.mkdir(activationPath, { recursive: true });
			await fs.writeFile(
				path.join(configRoot, 'harper-application-lock.json'),
				JSON.stringify({ applications: { [project]: { package: 'stale-package' } } })
			);
			// A root-config entry is what makes a dropped component come back: installApplications() reads
			// it on the next boot and reinstalls the package. Removing it and the application-lock entry as
			// two separate writes meant a crash or a failed second write left this behind.
			await fs.appendFile(configPath, `${project}:\n  package: stale-package\n`);

			await operations.dropComponent({ project });

			const deploymentStagePath = path.join(componentsRoot, DEPLOY_STAGING_DIR, staged.deployment_id);
			assert.strictEqual(
				existsSync(deploymentStagePath),
				false,
				`staged deployment directory still contains: ${await fs.readdir(deploymentStagePath).catch(() => [])}`
			);
			assert.strictEqual(existsSync(path.join(componentsRoot, DEPLOY_ACTIVATION_DIR, project)), false);
			const applicationLock = JSON.parse(await fs.readFile(path.join(configRoot, 'harper-application-lock.json')));
			assert.strictEqual(applicationLock.applications[project], undefined);
			assert.strictEqual(
				(await fs.readFile(configPath, 'utf8')).includes(project),
				false,
				'the root-config entry is removed in the same step, so the next boot cannot reinstall the drop'
			);
		} finally {
			if (priorRootEnv === undefined) delete process.env.ROOTPATH;
			else process.env.ROOTPATH = priorRootEnv;
			environment.setProperty(CONFIG_PARAMS.ROOTPATH, priorRootConfig);
			environment.setProperty(CONFIG_PARAMS.COMPONENTSROOT, priorComponentsRoot);
			await fs.rm(configRoot, { recursive: true, force: true });
		}
	});
});
