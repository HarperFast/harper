'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const zlib = require('node:zlib');
const tarfs = require('tar-fs');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	Application,
	stageApplication,
	activateStagedApplication,
	discardStagedApplication,
	discardProjectActivationArtifacts,
	reconcileStagedApplicationArtifacts,
	createApplicationActivationTransaction,
	revertApplication,
	getRevertTarget,
	discardDirAside,
	DISCARDED_ASIDE_PREFIX,
	getStagingRetentionMaxCount,
	DEFAULT_STAGING_RETENTION_MAX_COUNT,
	recoverInterruptedReverts,
	createApplicationConfigTransaction,
	extractApplication,
	stagedApplicationPath,
	DEPLOY_STAGING_DIR,
	DEPLOY_ACTIVATION_DIR,
	DEPLOY_PREVIOUS_DIR,
	ASIDE_STAGING_DIR,
} = require('#src/components/Application');
const { getConfigPath, readConfigFile } = require('#src/config/configUtils');
const { withComponentPreparationLock } = require('#src/components/componentPreparationLock');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const environment = require('#src/utility/environment/environmentManager');

const COMPONENTS_ROOT = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);

function packDirectory(dir) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		tarfs
			.pack(dir)
			.pipe(zlib.createGzip())
			.on('data', (chunk) => chunks.push(chunk))
			.on('end', () => resolve(Buffer.concat(chunks)))
			.on('error', reject);
	});
}

async function makeComponentPayload(marker, version = '1.0.0') {
	const source = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-stage-src-'));
	await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'stage-fixture', version }));
	await fs.writeFile(path.join(source, 'index.js'), `module.exports = ${JSON.stringify(marker)};\n`);
	await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
	const payload = await packDirectory(source);
	await fs.rm(source, { recursive: true, force: true });
	return payload;
}

async function readMarker(directory) {
	return fs.readFile(path.join(directory, 'index.js'), 'utf8');
}

describe('two-phase component directory transaction', function () {
	this.timeout(30_000);
	let sequence = 0;

	before(async () => fs.mkdir(COMPONENTS_ROOT, { recursive: true }));

	function fixtureName() {
		return `stage_test_${process.pid}_${sequence++}`;
	}

	async function cleanup(name) {
		await fs.rm(path.join(COMPONENTS_ROOT, name), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, DEPLOY_ACTIVATION_DIR), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, ASIDE_STAGING_DIR), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, `${DEPLOY_PREVIOUS_DIR}`), { recursive: true, force: true });
	}

	it('builds a staged tree without touching the live component', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('candidate') });

		const stagedPath = await stageApplication(application, deploymentId);

		assert.equal(stagedPath, stagedApplicationPath(application.dirPath, deploymentId));
		assert.match(await readMarker(stagedPath), /candidate/);
		assert.equal(existsSync(application.dirPath), false);
		await cleanup(name);
	});

	it('atomically activates a staged tree and consumes only that deployment', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const siblingId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('candidate') });
		await stageApplication(application, deploymentId);
		application.payload = await makeComponentPayload('sibling');
		await stageApplication(application, siblingId);

		await activateStagedApplication(application, deploymentId);

		assert.match(await readMarker(application.dirPath), /candidate/);
		assert.equal(existsSync(stagedApplicationPath(application.dirPath, deploymentId)), false);
		assert.equal(existsSync(stagedApplicationPath(application.dirPath, siblingId)), true);
		await cleanup(name);
	});

	it('rejects a candidate whose staging build did not complete', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('incomplete') });
		const stagedPath = await stageApplication(application, deploymentId);
		await fs.rm(path.join(path.dirname(stagedPath), '.complete'));

		await assert.rejects(activateStagedApplication(application, deploymentId), /staged build is incomplete/);

		assert.equal(existsSync(application.dirPath), false);
		assert.match(await readMarker(stagedPath), /incomplete/);
		await cleanup(name);
	});

	it('resumes a new-component activation after its durable marker was already created', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('resumed') });
		await stageApplication(application, deploymentId);
		const activationPath = path.join(COMPONENTS_ROOT, DEPLOY_ACTIVATION_DIR, name);
		await fs.mkdir(activationPath, { recursive: true });
		await fs.writeFile(path.join(activationPath, `.new-${deploymentId}`), '', { mode: 0o600 });

		await activateStagedApplication(application, deploymentId);

		assert.match(await readMarker(application.dirPath), /resumed/);
		assert.equal(existsSync(activationPath), false);
		await cleanup(name);
	});

	it('does not report activation failure when only committed-stage cleanup is denied', async function () {
		if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('cleanup-deferred') });
		await stageApplication(application, deploymentId);
		const stagingRoot = path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR);
		await fs.chmod(stagingRoot, 0o500);
		try {
			await activateStagedApplication(application, deploymentId);
		} finally {
			await fs.chmod(stagingRoot, 0o700);
		}

		assert.match(await readMarker(application.dirPath), /cleanup-deferred/);
		assert.equal(existsSync(path.join(stagingRoot, deploymentId)), true, 'cleanup remains retryable garbage');
		await cleanup(name);
	});

	it('restores live and preserves the staged tree when persistent activation work fails', async () => {
		const name = fixtureName();
		const livePath = path.join(COMPONENTS_ROOT, name);
		const deploymentId = randomUUID();
		await fs.mkdir(livePath, { recursive: true });
		await fs.writeFile(path.join(livePath, 'index.js'), 'module.exports = "live";\n');
		const application = new Application({ name, payload: await makeComponentPayload('candidate', '2.0.0') });
		await stageApplication(application, deploymentId);

		await assert.rejects(
			activateStagedApplication(application, deploymentId, {
				beforeCommit: async () => {
					throw new Error('config write failed');
				},
			}),
			/config write failed/
		);

		assert.match(await readMarker(livePath), /live/);
		assert.match(await readMarker(stagedApplicationPath(livePath, deploymentId)), /candidate/);
		await cleanup(name);
	});

	it('serializes duplicate activation without ever losing the live directory', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('candidate') });
		await stageApplication(application, deploymentId);

		const outcomes = await Promise.allSettled([
			activateStagedApplication(application, deploymentId),
			activateStagedApplication(application, deploymentId),
		]);

		assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
		assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
		assert.match(await readMarker(application.dirPath), /candidate/);
		await cleanup(name);
	});

	it('snapshots config at commit time so a queued rollback preserves the preceding winner', async () => {
		const name = fixtureName();
		const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-activation-config-'));
		const priorRootEnv = process.env.ROOTPATH;
		const priorRootConfig = getConfigPath(CONFIG_PARAMS.ROOTPATH);
		process.env.ROOTPATH = configRoot;
		environment.setProperty(CONFIG_PARAMS.ROOTPATH, configRoot);
		await fs.writeFile(path.join(configRoot, 'harper-config.yaml'), `rootPath: ${JSON.stringify(configRoot)}\n`);
		const spec = (version, urlPath) => ({
			project: name,
			package: `example@${version}`,
			install_command: null,
			install_timeout: null,
			install_allow_scripts: null,
			urlPath,
			host: null,
			credentials: null,
		});
		const first = await createApplicationActivationTransaction(name, spec('1.0.0', '/first'));
		const second = await createApplicationActivationTransaction(name, spec('2.0.0', '/second'));
		try {
			await first.commit();
			await second.commit();
			await second.rollback();

			assert.deepEqual(readConfigFile()[name], { package: 'example@1.0.0', urlPath: '/first' });
			const lock = JSON.parse(
				await fs.readFile(path.join(configRoot, 'harper-application-lock.json'), { encoding: 'utf8' })
			);
			assert.deepEqual(lock.applications[name], { package: 'example@1.0.0', urlPath: '/first' });
		} finally {
			await second.rollback();
			await first.rollback();
			if (priorRootEnv === undefined) delete process.env.ROOTPATH;
			else process.env.ROOTPATH = priorRootEnv;
			environment.setProperty(CONFIG_PARAMS.ROOTPATH, priorRootConfig);
			await fs.rm(configRoot, { recursive: true, force: true });
		}
	});

	it('discard removes only the selected staged tree and leaves live unchanged', async () => {
		const name = fixtureName();
		const livePath = path.join(COMPONENTS_ROOT, name);
		const deploymentId = randomUUID();
		await fs.mkdir(livePath, { recursive: true });
		await fs.writeFile(path.join(livePath, 'index.js'), 'module.exports = "live";\n');
		const application = new Application({ name, payload: await makeComponentPayload('candidate') });
		await stageApplication(application, deploymentId);

		await discardStagedApplication(livePath, deploymentId);

		assert.equal(existsSync(stagedApplicationPath(livePath, deploymentId)), false);
		assert.match(await readMarker(livePath), /live/);
		await cleanup(name);
	});

	it('drop cleanup removes only the selected component activation artifacts', async () => {
		const name = fixtureName();
		const sibling = fixtureName();
		const activationRoot = path.join(COMPONENTS_ROOT, DEPLOY_ACTIVATION_DIR);
		await fs.mkdir(path.join(activationRoot, name, 'old'), { recursive: true });
		await fs.mkdir(path.join(activationRoot, sibling, 'keep'), { recursive: true });

		await discardProjectActivationArtifacts(path.join(COMPONENTS_ROOT, name));

		assert.equal(existsSync(path.join(activationRoot, name)), false);
		assert.equal(existsSync(path.join(activationRoot, sibling, 'keep')), true);
		await cleanup(name);
	});

	it('startup reconciliation removes terminal stages and preserves valid staged rows', async () => {
		const name = fixtureName();
		const keptId = randomUUID();
		const removedId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('kept') });
		await stageApplication(application, keptId);
		application.payload = await makeComponentPayload('removed');
		await stageApplication(application, removedId);
		const rows = new Map([
			[keptId, { deployment_id: keptId, project: name, status: 'staged' }],
			[removedId, { deployment_id: removedId, project: name, status: 'failed' }],
		]);

		const result = await reconcileStagedApplicationArtifacts(
			COMPONENTS_ROOT,
			async (id) => rows.get(id),
			async () => {}
		);

		assert.equal(existsSync(stagedApplicationPath(application.dirPath, keptId)), true);
		assert.equal(existsSync(stagedApplicationPath(application.dirPath, removedId)), false);
		assert.deepEqual(result.removed, [removedId]);
		await cleanup(name);
	});

	it('startup reconciliation rolls an activating staged tree forward', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const livePath = path.join(COMPONENTS_ROOT, name);
		await fs.mkdir(livePath, { recursive: true });
		await fs.writeFile(path.join(livePath, 'index.js'), 'module.exports = "old";\n');
		const application = new Application({ name, payload: await makeComponentPayload('candidate') });
		await stageApplication(application, deploymentId);
		const activationPath = path.join(COMPONENTS_ROOT, DEPLOY_ACTIVATION_DIR, name);
		await fs.mkdir(activationPath, { recursive: true });
		await fs.rename(livePath, path.join(activationPath, `.previous-${deploymentId}-crash`));
		const row = {
			deployment_id: deploymentId,
			project: name,
			status: 'activating',
			activation_spec: { project: name },
		};
		const persisted = [];

		const result = await reconcileStagedApplicationArtifacts(
			COMPONENTS_ROOT,
			async (id) => (id === deploymentId ? row : undefined),
			async (value) => persisted.push(value.deployment_id)
		);

		assert.match(await readMarker(livePath), /candidate/);
		assert.deepEqual(persisted, [deploymentId]);
		assert.deepEqual(result.recovered, [deploymentId]);
		assert.equal(existsSync(activationPath), false);
		await cleanup(name);
	});

	it('startup reconciliation finishes an activation whose candidate is already live', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const livePath = path.join(COMPONENTS_ROOT, name);
		const activationPath = path.join(COMPONENTS_ROOT, DEPLOY_ACTIVATION_DIR, name);
		await fs.mkdir(livePath, { recursive: true });
		await fs.writeFile(path.join(livePath, 'index.js'), 'module.exports = "candidate";\n');
		await fs.mkdir(path.join(activationPath, `.previous-${deploymentId}-crash`), { recursive: true });
		const row = {
			deployment_id: deploymentId,
			project: name,
			status: 'activating',
			activation_spec: { project: name },
		};
		let persisted = 0;

		const result = await reconcileStagedApplicationArtifacts(
			COMPONENTS_ROOT,
			async (id) => (id === deploymentId ? row : undefined),
			async () => persisted++
		);

		assert.equal(persisted, 1);
		assert.deepEqual(result.recovered, [deploymentId]);
		assert.match(await readMarker(livePath), /candidate/);
		assert.equal(existsSync(activationPath), false);
		await cleanup(name);
	});

	it('rejects a non-UUID before it can become a filesystem path segment', () => {
		assert.throws(() => stagedApplicationPath(path.join(COMPONENTS_ROOT, fixtureName()), '../../escape'), /Invalid/);
	});

	it('rejects a symlinked staging root without touching its target', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-stage-outside-'));
		await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
		await fs.rm(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR), { recursive: true, force: true });
		await fs.symlink(outside, path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR), 'dir');
		const application = new Application({ name, payload: await makeComponentPayload('candidate') });

		await assert.rejects(stageApplication(application, deploymentId), /staging path is not a directory/);
		assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');

		await cleanup(name);
		await fs.rm(outside, { recursive: true, force: true });
	});

	it('activates a completed local-directory package symlink with secure staging containers', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const packageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-stage-package-'));
		await fs.writeFile(path.join(packageDirectory, 'marker.txt'), 'directory-package');
		const application = new Application({ name, packageIdentifier: packageDirectory });

		const stagedPath = await stageApplication(application, deploymentId);
		assert.equal((await fs.lstat(stagedPath)).isSymbolicLink(), true);
		await activateStagedApplication(application, deploymentId);

		assert.equal((await fs.lstat(application.dirPath)).isSymbolicLink(), true);
		assert.equal(await fs.readFile(path.join(application.dirPath, 'marker.txt'), 'utf8'), 'directory-package');

		await cleanup(name);
		await fs.rm(packageDirectory, { recursive: true, force: true });
	});
	// ————————————————————————————————————————————————————————————————————————————
	// Retained previous + addressed revert (harper#1849 review, @kriszyp)
	// ————————————————————————————————————————————————————————————————————————————

	it('retains the tree an activation displaced, addressed by the deployment that produced it', async () => {
		const name = fixtureName();
		const firstId = randomUUID();
		const secondId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('v1') });
		await stageApplication(application, firstId);
		await activateStagedApplication(application, firstId, { activationSpec: { package: null } });
		application.payload = await makeComponentPayload('v2');
		await stageApplication(application, secondId);
		await activateStagedApplication(application, secondId, { activationSpec: { package: null } });

		assert.match(await readMarker(application.dirPath), /v2/);
		const retained = path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, name);
		assert.match(await readMarker(retained), /v1/);

		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.live.deployment_id, secondId);
		assert.equal(target.previous.deployment_id, firstId);
		await cleanup(name);
	});

	it('a first-ever deploy retains nothing, so there is no version to revert to', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('only') });
		await stageApplication(application, deploymentId);
		await activateStagedApplication(application, deploymentId, { activationSpec: { package: null } });

		assert.equal(await getRevertTarget(application.dirPath), undefined);
		await assert.rejects(
			() => revertApplication(application, randomUUID()),
			/no previous version is retained/,
			'a component deployed once cannot be reverted'
		);
		await cleanup(name);
	});

	it('reverts to the named previous deployment and exchanges the retained roles', async () => {
		const name = fixtureName();
		const firstId = randomUUID();
		const secondId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('v1') });
		await stageApplication(application, firstId);
		await activateStagedApplication(application, firstId, { activationSpec: { package: null } });
		application.payload = await makeComponentPayload('v2');
		await stageApplication(application, secondId);
		await activateStagedApplication(application, secondId, { activationSpec: { package: null } });

		const result = await revertApplication(application, firstId);

		assert.equal(result.swapped, true);
		assert.equal(result.fromDeploymentId, secondId);
		assert.match(await readMarker(application.dirPath), /v1/, 'live is the reverted-to version');
		assert.match(
			await readMarker(path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, name)),
			/v2/,
			'the displaced version becomes the new retained previous'
		);

		// Explicitly targeting the other direction rolls forward again.
		const forward = await revertApplication(application, secondId);
		assert.equal(forward.swapped, true);
		assert.match(await readMarker(application.dirPath), /v2/);
		await cleanup(name);
	});

	it('is a no-op when the named deployment is already live, so a retry cannot toggle it back', async () => {
		const name = fixtureName();
		const firstId = randomUUID();
		const secondId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('v1') });
		await stageApplication(application, firstId);
		await activateStagedApplication(application, firstId, { activationSpec: { package: null } });
		application.payload = await makeComponentPayload('v2');
		await stageApplication(application, secondId);
		await activateStagedApplication(application, secondId, { activationSpec: { package: null } });
		await revertApplication(application, firstId);

		// The delivery of the first response is lost and the caller retries the identical request. A
		// bidirectional toggle would put the rejected v2 back live; an addressed revert must not.
		const retry = await revertApplication(application, firstId);

		assert.equal(retry.swapped, false, 'a repeated revert to the live version does nothing');
		assert.match(await readMarker(application.dirPath), /v1/, 'still on the reverted-to version');
		await cleanup(name);
	});

	it('refuses a deployment that is neither live nor the retained previous', async () => {
		const name = fixtureName();
		const firstId = randomUUID();
		const secondId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('v1') });
		await stageApplication(application, firstId);
		await activateStagedApplication(application, firstId, { activationSpec: { package: null } });
		application.payload = await makeComponentPayload('v2');
		await stageApplication(application, secondId);
		await activateStagedApplication(application, secondId, { activationSpec: { package: null } });

		await assert.rejects(
			() => revertApplication(application, randomUUID()),
			/neither the live version .* nor the retained previous version/s,
			'only one previous version is retained, so anything else is a redeploy'
		);
		assert.match(await readMarker(application.dirPath), /v2/, 'a refused revert changes nothing');
		await cleanup(name);
	});

	it('retains exactly one previous version across three activations', async () => {
		const name = fixtureName();
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		const application = new Application({ name, payload: await makeComponentPayload('v1') });
		for (const [index, id] of ids.entries()) {
			if (index > 0) application.payload = await makeComponentPayload(`v${index + 1}`);
			await stageApplication(application, id);
			await activateStagedApplication(application, id, { activationSpec: { package: null } });
		}

		assert.match(await readMarker(application.dirPath), /v3/);
		assert.match(await readMarker(path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, name)), /v2/);
		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.previous.deployment_id, ids[1], 'v1 is evicted; only v2 stays revertable');
		await cleanup(name);
	});

	it('parks the evicted retained-previous where startup recovery will never restore it', async () => {
		// The single `.deploy-aside` contract: an `.in-progress-` directory with no `.retired-` marker is
		// a rollback record that recoverInterruptedComponentExtractions restores OVER the live component.
		// An evicted two-deploys-ago tree is known garbage when parked, so it must not carry that prefix,
		// or a crash before the sweep would resurrect an ancient version over the current one.
		const name = fixtureName();
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		const application = new Application({ name, payload: await makeComponentPayload('v1') });
		for (const [index, id] of ids.entries()) {
			if (index > 0) application.payload = await makeComponentPayload(`v${index + 1}`);
			await stageApplication(application, id);
			await activateStagedApplication(application, id, { activationSpec: { package: null } });
		}

		assert.match(await readMarker(application.dirPath), /v3/, 'the newest activation is live');
		assert.match(await readMarker(path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, name)), /v2/);
		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.previous.deployment_id, ids[1], 'only the immediately-previous version is retained');
		await cleanup(name);
	});

	it('reports the config each retained version was activated with, so a revert can restore it', async () => {
		// This is what makes a revert durable across a cold restart: reverting away from a `package`
		// deploy has to take the package reference out of root config too, or installApplications()
		// reinstalls the reverted-away version over the restored directory on the next boot.
		const name = fixtureName();
		const packagedId = randomUUID();
		const payloadId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('packaged') });
		await stageApplication(application, packagedId);
		await activateStagedApplication(application, packagedId, {
			activationSpec: {
				package: 'stage-fixture@1.0.0',
				install_command: null,
				install_timeout: null,
				install_allow_scripts: null,
				urlPath: null,
				host: null,
			},
		});
		application.payload = await makeComponentPayload('plain');
		await stageApplication(application, payloadId);
		await activateStagedApplication(application, payloadId, { activationSpec: { package: null } });

		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.previous.application_config.package, 'stage-fixture@1.0.0');
		const back = await revertApplication(application, packagedId);
		assert.equal(back.activatedConfig.package, 'stage-fixture@1.0.0');
		await cleanup(name);
	});

	it('moves a dangling symlink at the live path aside instead of failing EEXIST', async () => {
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('candidate') });
		const missingTarget = path.join(os.tmpdir(), `harper-missing-${randomUUID()}`);
		await fs.mkdir(COMPONENTS_ROOT, { recursive: true });
		await fs.symlink(missingTarget, application.dirPath, 'dir');

		await stageApplication(application, deploymentId);
		await activateStagedApplication(application, deploymentId, { activationSpec: { package: null } });

		assert.equal((await fs.lstat(application.dirPath)).isSymbolicLink(), false);
		assert.match(await readMarker(application.dirPath), /candidate/);
		await cleanup(name);
	});
	it('extracts in place over a DANGLING symlink at the component path instead of failing EEXIST', async () => {
		// access(F_OK) follows symlinks, so a dead link at the target reports ENOENT and would be treated
		// as "nothing here" — then mkdir fails EEXIST because the link still occupies the path. lstat sees
		// the link itself. Left by a prior `file:`-directory deploy whose target was removed.
		const name = fixtureName();
		const application = new Application({ name, payload: await makeComponentPayload('over-dead-link') });
		await fs.mkdir(COMPONENTS_ROOT, { recursive: true });
		await fs.symlink(path.join(os.tmpdir(), `harper-missing-${randomUUID()}`), application.dirPath, 'dir');

		await extractApplication(application);

		assert.equal((await fs.lstat(application.dirPath)).isSymbolicLink(), false);
		assert.match(await readMarker(application.dirPath), /over-dead-link/);
		await cleanup(name);
	});
	// ————————————————————————————————————————————————————————————————————————————
	// Restart gate: package metadata compared across the swap
	// (harper#674 / harper#1849 @heskew finding 2)
	// ————————————————————————————————————————————————————————————————————————————
	//
	// main's in-place prepareApplication compares installed package metadata before extraction against
	// after install; the two-phase path never touches the live directory until the swap, so the
	// equivalent comparison is outgoing-live vs staged, taken inside activateStagedApplication. These
	// assert the flag it sets, which operations.js feeds into markRestartRequiredForDeploy.

	async function activateFrom(name, marker, version, { withNodeModules = true, dependencies } = {}) {
		const source = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-gate-src-'));
		const manifest = { name: 'stage-fixture', version };
		if (dependencies) manifest.dependencies = dependencies;
		await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(manifest));
		await fs.writeFile(path.join(source, 'index.js'), `module.exports = ${JSON.stringify(marker)};\n`);
		if (withNodeModules) await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
		const payload = await packDirectory(source);
		await fs.rm(source, { recursive: true, force: true });

		const application = new Application({ name, payload });
		const deploymentId = randomUUID();
		await stageApplication(application, deploymentId);
		await activateStagedApplication(application, deploymentId, { activationSpec: { package: null } });
		return application;
	}

	it('does not flag a metadata change when a redeploy is identical and comparable', async () => {
		// The harper#1806 guarantee: a redeploy of an already-loaded component stays quiet, because that
		// component's own file watcher requests a restart if the changed files actually need one. It holds
		// only for a COMPARABLE install — no bundled node_modules to make the result opaque.
		const name = fixtureName();
		await activateFrom(name, 'quiet', '1.0.0', { withNodeModules: false });
		const second = await activateFrom(name, 'quiet', '1.0.0', { withNodeModules: false });

		assert.equal(second.isNewComponent, false, 'the second activation is a redeploy');
		assert.equal(second.packageMetadataChanged, false, 'identical metadata across the swap must stay quiet');
		await cleanup(name);
	});

	it('flags a metadata change the watchers cannot see', async () => {
		const name = fixtureName();
		await activateFrom(name, 'changed', '1.0.0', { withNodeModules: false });
		const second = await activateFrom(name, 'changed', '2.0.0', { withNodeModules: false });

		assert.equal(second.packageMetadataChanged, true, 'a changed package.json version invalidates loaded code');
		await cleanup(name);
	});

	it('treats a bundled node_modules redeploy as opaque, since its install cannot be compared', async () => {
		const name = fixtureName();
		await activateFrom(name, 'opaque', '1.0.0');
		const second = await activateFrom(name, 'opaque', '1.0.0');

		assert.equal(second.packageMetadataChanged, true, 'a skipped install leaves nothing to compare');
		await cleanup(name);
	});

	it('treats installable dependencies with no lockfile as opaque', async () => {
		const name = fixtureName();
		await activateFrom(name, 'nolock', '1.0.0');
		const second = await activateFrom(name, 'nolock', '1.0.0', { dependencies: { 'some-dep': '1.0.0' } });

		assert.equal(second.packageMetadataChanged, true, 'dependencies with no lockfile are not reproducible');
		await cleanup(name);
	});

	it('does not flag a metadata change on a first-ever deploy', async () => {
		const name = fixtureName();
		const first = await activateFrom(name, 'brand-new', '1.0.0', { withNodeModules: false });

		assert.equal(first.isNewComponent, true);
		assert.equal(first.packageMetadataChanged, false, 'nothing to compare against; isNewComponent carries it');
		await cleanup(name);
	});
	// ————————————————————————————————————————————————————————————————————————————
	// Interrupted revert: compensation and startup recovery
	// ————————————————————————————————————————————————————————————————————————————

	async function twoActivations(name) {
		const first = randomUUID();
		const second = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('v1') });
		await stageApplication(application, first);
		await activateStagedApplication(application, first, { activationSpec: { package: null } });
		application.payload = await makeComponentPayload('v2');
		await stageApplication(application, second);
		await activateStagedApplication(application, second, { activationSpec: { package: null } });
		return { application, first, second };
	}

	// NOT covered here: an in-process failure of the middle rename. Once `rename(live, holding)` has run,
	// the live path is gone, so `rename(previous, live)` has no existing target to conflict with and
	// succeeds for every filesystem state reachable from a test (a file, a dangling symlink, a directory
	// all rename cleanly onto a free path). Inducing it would need a fault-injection seam in production
	// code. The compensation is still there — it is what turns an exceptional I/O error into "the
	// component keeps serving what it was serving" — but the durable half below is what actually covers
	// the reviewer's scenario: a process that dies mid-swap, which compensation inherently cannot handle.

	it('startup recovery restores the live tree from a revert that died before the swap', async () => {
		const name = fixtureName();
		const { application } = await twoActivations(name);
		// Simulate a crash right after `rename(live, holding)`: live is gone, holding holds its tree.
		const holding = path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, `.reverting-${name}-${randomUUID()}`);
		await fs.rename(application.dirPath, holding);

		const failures = await recoverInterruptedReverts(COMPONENTS_ROOT);

		assert.equal(failures.size, 0);
		assert.match(await readMarker(application.dirPath), /v2/, 'the interrupted revert is undone');
		assert.equal(existsSync(holding), false);
		await cleanup(name);
	});

	it('startup recovery re-retains the displaced tree when only the retain step was lost', async () => {
		const name = fixtureName();
		const { application, first, second } = await twoActivations(name);
		// Simulate a crash after `rename(previous, live)` but before `rename(holding, previous)`: the
		// reverted-to version is live, and the displaced tree is still parked.
		const previousPath = path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, name);
		const holding = path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, `.reverting-${name}-${randomUUID()}`);
		await fs.rm(application.dirPath, { recursive: true, force: true });
		await fs.rename(previousPath, application.dirPath);
		await fs.mkdir(holding, { recursive: true });
		await fs.writeFile(path.join(holding, 'index.js'), "module.exports = 'displaced';\n");

		const failures = await recoverInterruptedReverts(COMPONENTS_ROOT);

		assert.equal(failures.size, 0);
		assert.match(await readMarker(application.dirPath), /v1/, 'the reverted-to version stays live');
		assert.match(await readMarker(previousPath), /displaced/, 'the displaced tree is retained again');
		assert.equal(existsSync(holding), false);

		// The directories are only half the state. The manifest was written before the swap, so completing
		// the recovery has to exchange its roles too — otherwise it names the retained tree as live and the
		// live tree as retained, and the retry below matches its target against the reversed `previous`
		// entry and swaps the successful revert straight back out.
		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.live.deployment_id, first, 'the manifest names the reverted-to version as live');
		assert.equal(target.previous.deployment_id, second, 'and the displaced version as the retained one');

		// Idempotency has to survive the recovery: re-issuing the same addressed revert changes nothing.
		const retry = await revertApplication(application, first);
		assert.equal(retry.swapped, false, 'a retry after recovery is a no-op, not a swap back');
		assert.match(await readMarker(application.dirPath), /v1/, 'still on the reverted-to version');
		await cleanup(name);
	});

	it('startup recovery discards a holding tree left by a revert that had already completed', async () => {
		const name = fixtureName();
		const { application } = await twoActivations(name);
		const holding = path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, `.reverting-${name}-${randomUUID()}`);
		await fs.mkdir(holding, { recursive: true });
		await fs.writeFile(path.join(holding, 'index.js'), "module.exports = 'residue';\n");

		await recoverInterruptedReverts(COMPONENTS_ROOT);

		assert.equal(existsSync(holding), false, 'both slots were occupied, so the holding tree is residue');
		assert.match(await readMarker(application.dirPath), /v2/, 'live is untouched');
		await cleanup(name);
	});
	it('redeploys a local-directory package in place without destroying the live tree', async () => {
		// This path returns early, BEFORE the extraction transaction, so clearing the build target with an
		// in-place recursive rm would delete the LIVE tree outright: no aside, no rollback record, nothing
		// for startup recovery, and it races a worker still writing into the directory being removed. It
		// must be parked with an atomic rename instead.
		const name = fixtureName();
		const packageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-dirpkg-'));
		await fs.writeFile(path.join(packageDirectory, 'marker.txt'), 'v2');
		const application = new Application({ name, packageIdentifier: `file:${packageDirectory}` });

		// A live tree is already there (the component was deployed before, by any means).
		await fs.mkdir(application.dirPath, { recursive: true });
		await fs.writeFile(path.join(application.dirPath, 'marker.txt'), 'v1');

		await extractApplication(application);

		assert.equal((await fs.lstat(application.dirPath)).isSymbolicLink(), true, 'the new version is linked');
		assert.equal(await fs.readFile(path.join(application.dirPath, 'marker.txt'), 'utf8'), 'v2');
		await cleanup(name);
		await fs.rm(packageDirectory, { recursive: true, force: true });
	});
	it('rolls both persistent writes back, so a failed commit cannot leave config half-applied', async () => {
		// commit() makes TWO persistent writes — root config, then the boot-time application lock — and
		// arms rollback (`commitStarted`) BEFORE either. That is what lets a caller whose commit threw
		// partway undo the write that did land: without it, compensating by swapping the directories back
		// still left root config naming the version just rolled away from, for a cold start to act on.
		//
		// A genuinely partial commit is not injectable from a test: the lock is READ (getApplicationLockEntry)
		// before the config write, so any corruption that would break the lock write breaks that read first
		// and fails before mutating anything. What is verifiable is the property the compensation depends
		// on — that rollback restores the exact pre-commit state of both writes.
		const name = fixtureName();
		const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-cfg-rollback-'));
		const priorRootEnv = process.env.ROOTPATH;
		const priorRootConfig = getConfigPath(CONFIG_PARAMS.ROOTPATH);
		process.env.ROOTPATH = configRoot;
		environment.setProperty(CONFIG_PARAMS.ROOTPATH, configRoot);
		await fs.writeFile(path.join(configRoot, 'harper-config.yaml'), `rootPath: ${JSON.stringify(configRoot)}\n`);
		const lockPath = path.join(configRoot, 'harper-application-lock.json');
		const readLock = async () => JSON.parse(await fs.readFile(lockPath, { encoding: 'utf8' })).applications[name];
		try {
			// The version that is live now, and that a revert would be rolling back to.
			const original = await createApplicationConfigTransaction(name, { package: 'example@1.0.0' });
			await original.commit();
			assert.deepEqual(readConfigFile()[name], { package: 'example@1.0.0' });
			assert.deepEqual(await readLock(), { package: 'example@1.0.0' });

			const reverting = await createApplicationConfigTransaction(name, { package: 'example@2.0.0' });
			await reverting.commit();
			assert.deepEqual(readConfigFile()[name], { package: 'example@2.0.0' }, 'both writes moved forward');
			assert.deepEqual(await readLock(), { package: 'example@2.0.0' });

			await reverting.rollback();

			assert.deepEqual(
				readConfigFile()[name],
				{ package: 'example@1.0.0' },
				'rollback restores the root config the commit replaced'
			);
			assert.deepEqual(await readLock(), { package: 'example@1.0.0' }, 'and the application-lock entry');

			// A transaction that never committed must not touch anything on rollback, so compensation on an
			// early failure cannot clobber a live config.
			const untouched = await createApplicationConfigTransaction(name, { package: 'example@3.0.0' });
			await untouched.rollback();
			assert.deepEqual(readConfigFile()[name], { package: 'example@1.0.0' }, 'no-op rollback changes nothing');
		} finally {
			if (priorRootEnv === undefined) delete process.env.ROOTPATH;
			else process.env.ROOTPATH = priorRootEnv;
			environment.setProperty(CONFIG_PARAMS.ROOTPATH, priorRootConfig);
			await fs.rm(configRoot, { recursive: true, force: true });
		}
	});

	it('reports the component whose activation persistence failed, so it can be kept from loading', async () => {
		// Startup reconciliation used to only LOG a failure to finish an `activating` deployment, then carry
		// on into normal component loading — serving a swapped-in tree whose durable configuration still
		// described the previous release. The caller can only fail that component closed if it is told which
		// component failed, which a deployment id alone does not give it.
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('candidate') });
		await stageApplication(application, deploymentId);
		await fs.mkdir(application.dirPath, { recursive: true });

		const row = {
			deployment_id: deploymentId,
			project: name,
			status: 'activating',
			activation_spec: { package: null },
		};
		const reconciliation = await reconcileStagedApplicationArtifacts(
			COMPONENTS_ROOT,
			async () => row,
			async () => {
				throw new Error('simulated activation-persistence failure');
			}
		);

		assert.equal(reconciliation.errors.has(deploymentId), true, 'the failure is reported by deployment');
		assert.equal(
			reconciliation.failedProjects.get(name)?.message,
			'simulated activation-persistence failure',
			'and attributed to the component, so the loader can fail it closed'
		);
		assert.equal(reconciliation.recovered.includes(deploymentId), false, 'a failed reconciliation is not "recovered"');
		await cleanup(name);
	});
	it('re-points a dependency link whose absolute target the activation swap invalidated', async () => {
		// npm installs against the STAGING directory, and activation renames that directory to the live
		// path — so any dependency npm materialized with an ABSOLUTE target inside staging dangles the
		// instant the rename lands. That is the normal shape of a `file:` dependency on Windows, where npm
		// creates a junction and junctions are always absolute; on Linux it writes a relative symlink that
		// survives the move. The Windows symptom is a bare `Cannot find module '<dep>'` at component load,
		// well after a deploy that reported success.
		//
		// Absolute links exist on every platform, so the behavior is reproducible here regardless of OS.
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('with-dep') });
		const stagedPath = await stageApplication(application, deploymentId);

		// Stand in for what `npm install --force` leaves behind for `file:vendor/probe`: a real vendored
		// directory, plus an ABSOLUTE link to it from node_modules.
		await fs.mkdir(path.join(stagedPath, 'vendor', 'probe'), { recursive: true });
		await fs.writeFile(path.join(stagedPath, 'vendor', 'probe', 'index.js'), "module.exports = 'probe';\n");
		await fs.mkdir(path.join(stagedPath, 'node_modules'), { recursive: true });
		await fs.symlink(path.join(stagedPath, 'vendor', 'probe'), path.join(stagedPath, 'node_modules', 'probe'), 'dir');
		// A scoped package, and a link deliberately pointing OUTSIDE staging, which must be left alone.
		const external = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-external-dep-'));
		await fs.writeFile(path.join(external, 'index.js'), "module.exports = 'external';\n");
		await fs.mkdir(path.join(stagedPath, 'node_modules', '@scope'), { recursive: true });
		await fs.symlink(
			path.join(stagedPath, 'vendor', 'probe'),
			path.join(stagedPath, 'node_modules', '@scope', 'scoped'),
			'dir'
		);
		await fs.symlink(external, path.join(stagedPath, 'node_modules', 'external'), 'dir');

		await activateStagedApplication(application, deploymentId, { activationSpec: { package: null } });

		// The dependency has to be resolvable from the LIVE tree, which is the whole point.
		assert.equal(
			await fs.readFile(path.join(application.dirPath, 'node_modules', 'probe', 'index.js'), 'utf8'),
			"module.exports = 'probe';\n",
			'the staged-path link was re-pointed at the live path'
		);
		assert.equal(
			await fs.readFile(path.join(application.dirPath, 'node_modules', '@scope', 'scoped', 'index.js'), 'utf8'),
			"module.exports = 'probe';\n",
			'scoped packages are re-pointed too'
		);
		// Untouched: an absolute link to somewhere outside the staging tree is a deliberate choice.
		assert.equal(
			await fs.readlink(path.join(application.dirPath, 'node_modules', 'external')),
			external,
			'a link outside staging is left exactly as it was'
		);

		await cleanup(name);
		await fs.rm(external, { recursive: true, force: true });
	});
	it('leaves external contents untouched when node_modules/@scope is a symlink', async () => {
		// `readdir` follows symlinks, so a staged payload shipping `node_modules/@scope` as a link to
		// somewhere else on the machine would otherwise have that directory's children enumerated as
		// candidates — and a link in there whose target happened to point into staging would be removed and
		// recreated, writing outside the component tree.
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('scoped') });
		const stagedPath = await stageApplication(application, deploymentId);

		// An external directory holding a link that DOES point into staging — the dangerous shape.
		const external = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-external-scope-'));
		await fs.mkdir(path.join(stagedPath, 'vendor', 'probe'), { recursive: true });
		await fs.writeFile(path.join(stagedPath, 'vendor', 'probe', 'index.js'), "module.exports = 'probe';\n");
		await fs.symlink(path.join(stagedPath, 'vendor', 'probe'), path.join(external, 'bait'), 'dir');
		const externalBaitTarget = await fs.readlink(path.join(external, 'bait'));

		// node_modules/@scope is a LINK to that external directory.
		await fs.mkdir(path.join(stagedPath, 'node_modules'), { recursive: true });
		await fs.symlink(external, path.join(stagedPath, 'node_modules', '@scope'), 'dir');

		await activateStagedApplication(application, deploymentId, { activationSpec: { package: null } });

		assert.equal(
			await fs.readlink(path.join(external, 'bait')),
			externalBaitTarget,
			'a link inside a symlinked scope directory is never rewritten'
		);
		assert.equal(
			(await fs.lstat(path.join(application.dirPath, 'node_modules', '@scope'))).isSymbolicLink(),
			true,
			'the scope link itself is left as a link'
		);
		await cleanup(name);
		await fs.rm(external, { recursive: true, force: true });
	});

	it('keeps the previous release live when a dependency link cannot be repaired', async () => {
		// The repair is not best-effort: the link is only being touched because activation is about to
		// invalidate its target, so a failure means the component would go live unable to resolve a
		// dependency — which pre-swap load validation cannot catch, since the link was valid in staging.
		const name = fixtureName();
		const first = randomUUID();
		const second = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('live-v1') });
		await stageApplication(application, first);
		await activateStagedApplication(application, first, { activationSpec: { package: null } });

		application.payload = await makeComponentPayload('candidate-v2');
		const stagedPath = await stageApplication(application, second);
		await fs.mkdir(path.join(stagedPath, 'vendor', 'probe'), { recursive: true });
		await fs.mkdir(path.join(stagedPath, 'node_modules'), { recursive: true });
		await fs.symlink(path.join(stagedPath, 'vendor', 'probe'), path.join(stagedPath, 'node_modules', 'probe'), 'dir');
		// Make recreating the link impossible: replace its parent with a read-only directory so the unlink
		// and re-symlink cannot succeed.
		await fs.chmod(path.join(stagedPath, 'node_modules'), 0o500);

		try {
			await assert.rejects(
				() => activateStagedApplication(application, second, { activationSpec: { package: null } }),
				'an unrepairable dependency link must fail the activation'
			);
			assert.match(
				await readMarker(application.dirPath),
				/live-v1/,
				'the previous release is still live — the swap was compensated'
			);
		} finally {
			await fs.chmod(path.join(stagedPath, 'node_modules'), 0o700).catch(() => {});
		}
		await cleanup(name);
	});

	it('resumes revert recovery when a first pass fails before the tree is moved back', async () => {
		// The holding directory is the only durable evidence that recovery is unfinished, so it must not be
		// consumed until the manifest and config writes are durable. A recovery marker carries the intended
		// end state across restarts, and on re-entry it — not the manifest — is the source of truth, because
		// an earlier attempt may already have exchanged the manifest and exchanging it twice flips it back.
		const name = fixtureName();
		const { application, first, second } = await twoActivations(name);
		const previousPath = path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, name);
		const manifestPath = `${previousPath}.json`;
		const holding = path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, `.reverting-${name}-${randomUUID()}`);
		// The marker is named after the holding directory it describes, so an orphan from one attempt can
		// never be trusted by a later, unrelated revert of the same component.
		const markerPath = `${holding}.recovering.json`;

		// Crash state: the reverted-to version is live, the displaced tree is still parked.
		const staleManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
		await fs.rm(application.dirPath, { recursive: true, force: true });
		await fs.rename(previousPath, application.dirPath);
		await fs.mkdir(holding, { recursive: true });
		await fs.writeFile(path.join(holding, 'index.js'), "module.exports = 'displaced';\n");
		// Stand in for a first pass that recorded its intent and then died: the marker is present.
		await fs.writeFile(
			markerPath,
			JSON.stringify({ previous: staleManifest.live, live: staleManifest.previous }, null, 2)
		);
		// Make the manifest WRITE fail (its read still succeeds, and the marker is what recovery reads
		// anyway) by putting a directory where the manifest file belongs.
		await fs.rm(manifestPath, { recursive: true, force: true });
		await fs.mkdir(manifestPath, { recursive: true });

		const firstPass = await recoverInterruptedReverts(COMPONENTS_ROOT);

		assert.equal(firstPass.has(name), true, 'the failed pass is reported, so the component is failed closed');
		assert.equal(existsSync(holding), true, 'the holding tree survives, so a later pass can still finish');
		assert.equal(existsSync(markerPath), true, 'and the recovery marker survives with it');

		// Clear the injected fault and run recovery again, as the next process start would.
		await fs.rm(manifestPath, { recursive: true, force: true });
		const secondPass = await recoverInterruptedReverts(COMPONENTS_ROOT);

		assert.equal(secondPass.size, 0, 'the second pass completes');
		assert.match(await readMarker(application.dirPath), /v1/, 'the reverted-to version is live');
		assert.match(await readMarker(previousPath), /displaced/, 'the displaced tree is retained again');
		assert.equal(existsSync(holding), false, 'the holding tree is consumed only once everything is durable');
		assert.equal(existsSync(markerPath), false, 'and the marker is cleared');
		// The marker, not the twice-read manifest, decided the end state — so roles are exchanged once.
		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.live.deployment_id, first);
		assert.equal(target.previous.deployment_id, second);
		await cleanup(name);
	});
	it('commits config inside the swap, so a revert cannot land config after a later activation', async () => {
		const name = fixtureName();
		const { application, first, second } = await twoActivations(name);
		const order = [];

		const result = await revertApplication(application, first, {
			commitPersistentState: async () => {
				// Observed from inside the lock: the reverted-to tree is already live and the displaced tree is
				// still parked, which is what makes this the only safe point to persist config.
				order.push('commit');
				assert.match(await readMarker(application.dirPath), /v1/, 'reverted-to version is live at commit time');
				assert.equal(
					existsSync(path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, name)),
					false,
					'the displaced tree is still in the holding path, not yet retained'
				);
			},
		});

		assert.deepEqual(order, ['commit'], 'the hook ran exactly once');
		assert.equal(result.swapped, true);
		assert.equal(result.fromDeploymentId, second);
		assert.match(await readMarker(application.dirPath), /v1/);
		assert.match(await readMarker(path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, name)), /v2/);
		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.live.deployment_id, first);
		await cleanup(name);
	});

	it('undoes the swap and leaves nothing revertable-looking when persisting config fails', async () => {
		const name = fixtureName();
		const { application, first, second } = await twoActivations(name);

		await assert.rejects(
			() =>
				revertApplication(application, first, {
					commitPersistentState: async () => {
						throw new Error('simulated config failure');
					},
				}),
			/simulated config failure/
		);

		assert.match(await readMarker(application.dirPath), /v2/, 'the pre-revert version is live again');
		assert.match(await readMarker(path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, name)), /v1/);
		const stranded = (await fs.readdir(path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR))).filter((entry) =>
			entry.startsWith('.reverting-')
		);
		assert.deepEqual(stranded, [], 'no holding tree or marker is left behind');
		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.live.deployment_id, second, 'the manifest still describes the un-reverted state');
		await cleanup(name);
	});

	it('sweeps a revert marker whose holding directory is gone', async () => {
		// A crash between the final rename and the marker removal orphans the marker. Nothing revisits it —
		// recovery is keyed on finding a holding directory — so it must be swept, or a later unrelated
		// revert of the same component could be resumed against it.
		const name = fixtureName();
		const { application, first } = await twoActivations(name);
		const orphan = path.join(
			COMPONENTS_ROOT,
			DEPLOY_PREVIOUS_DIR,
			`.reverting-${name}-${randomUUID()}.recovering.json`
		);
		await fs.writeFile(orphan, JSON.stringify({ previous: { deployment_id: 'x' }, live: { deployment_id: 'y' } }));

		const failures = await recoverInterruptedReverts(COMPONENTS_ROOT);

		assert.equal(failures.size, 0);
		assert.equal(existsSync(orphan), false, 'the orphaned marker is swept');
		// The sweep must not have disturbed the component's actual revert state.
		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.previous.deployment_id, first, 'the real retained-previous entry is untouched');
		await cleanup(name);
	});

	it('re-points a nested node_modules dependency link, not just top-level ones', async () => {
		// npm nests a link under `node_modules/<a>/node_modules/<b>` whenever hoisting is blocked by a
		// version conflict, and under workspaces routinely. A nested link dangles after the swap exactly
		// like a top-level one, and the hard-fail above cannot help if it is never enumerated.
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('nested') });
		const stagedPath = await stageApplication(application, deploymentId);

		await fs.mkdir(path.join(stagedPath, 'vendor', 'deep'), { recursive: true });
		await fs.writeFile(path.join(stagedPath, 'vendor', 'deep', 'index.js'), "module.exports = 'deep';\n");
		const outerPackage = path.join(stagedPath, 'node_modules', 'outer', 'node_modules');
		await fs.mkdir(outerPackage, { recursive: true });
		await fs.symlink(path.join(stagedPath, 'vendor', 'deep'), path.join(outerPackage, 'deep'), 'dir');
		// A scoped package nested one level further down, to prove the recursion handles both shapes.
		await fs.mkdir(path.join(outerPackage, '@inner'), { recursive: true });
		await fs.symlink(path.join(stagedPath, 'vendor', 'deep'), path.join(outerPackage, '@inner', 'scoped'), 'dir');

		await activateStagedApplication(application, deploymentId, { activationSpec: { package: null } });

		assert.equal(
			await fs.readFile(
				path.join(application.dirPath, 'node_modules', 'outer', 'node_modules', 'deep', 'index.js'),
				'utf8'
			),
			"module.exports = 'deep';\n",
			'the nested link resolves from the live tree'
		);
		assert.equal(
			await fs.readFile(
				path.join(application.dirPath, 'node_modules', 'outer', 'node_modules', '@inner', 'scoped', 'index.js'),
				'utf8'
			),
			"module.exports = 'deep';\n",
			'a nested scoped link resolves too'
		);
		await cleanup(name);
	});

	it('parks a disposable tree under the discarded prefix, never as a recovery candidate', async () => {
		// Asserted directly rather than after an activation: discardDirAside sweeps fire-and-forget, so an
		// after-the-fact directory listing passes vacuously whenever the sweep wins the race and cannot
		// distinguish correct `.discarded-` parking from a regression that parked as `.in-progress-`.
		const name = fixtureName();
		const target = path.join(COMPONENTS_ROOT, `${name}-disposable`);
		await fs.mkdir(target, { recursive: true });
		await fs.writeFile(path.join(target, 'index.js'), "module.exports = 'disposable';\n");
		const asideDir = path.join(COMPONENTS_ROOT, ASIDE_STAGING_DIR, `${name}-disposable`);

		const parkedSomething = await discardDirAside(target, name);

		assert.equal(parkedSomething, true);
		assert.equal(existsSync(target), false, 'the tree is moved out of the way');
		// Read before the detached sweep can remove it; if it already has, there is nothing to misclassify.
		const entries = await fs.readdir(asideDir).catch(() => []);
		for (const entry of entries) {
			assert.equal(
				entry.startsWith(DISCARDED_ASIDE_PREFIX),
				true,
				`parked entry ${entry} must carry the discarded prefix, not a recovery-candidate prefix`
			);
		}
		assert.equal(await discardDirAside(target, name), false, 'nothing to park the second time');
		await fs.rm(path.join(COMPONENTS_ROOT, ASIDE_STAGING_DIR), { recursive: true, force: true });
	});

	it('evicts staged builds beyond the retention count and always keeps the newest', async () => {
		const name = fixtureName();
		const priorMax = environment.get(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT);
		environment.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 2);
		const ids = [];
		try {
			const application = new Application({ name, payload: await makeComponentPayload('retained') });
			for (let index = 0; index < 4; index++) {
				const deploymentId = randomUUID();
				application.payload = await makeComponentPayload(`retained-${index}`);
				await stageApplication(application, deploymentId);
				ids.push(deploymentId);
			}
			const surviving = ids.filter((id) => existsSync(stagedApplicationPath(application.dirPath, id)));
			assert.equal(surviving.length, 2, `expected exactly 2 staged builds to survive, got ${surviving.length}`);
			assert.equal(surviving.includes(ids.at(-1)), true, 'the just-staged build is never evicted');
		} finally {
			environment.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, priorMax);
		}
		await cleanup(name);
	});

	it('falls back to the default staging retention count for unusable configured values', () => {
		const prior = environment.get(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT);
		try {
			for (const value of [undefined, '', '   ', true, [], {}, 'abc', 0, -1]) {
				environment.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, value);
				assert.equal(
					getStagingRetentionMaxCount(),
					DEFAULT_STAGING_RETENTION_MAX_COUNT,
					`${JSON.stringify(value)} must fall back to the default rather than coerce`
				);
			}
			for (const [value, expected] of [
				['3', 3],
				[3, 3],
				[2.7, 2],
			]) {
				environment.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, value);
				assert.equal(getStagingRetentionMaxCount(), expected);
			}
		} finally {
			environment.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, prior);
		}
	});
	it('leaves a rolled-back candidate re-activatable, with its links aimed at staging again', async () => {
		// Re-pointing before the swap mutates the staged candidate, so a rollback has to undo it. Left
		// aimed at the live path the links would resolve against whatever release is live, and a retry of
		// the same deployment id would validate the staged tree against the wrong bytes.
		const name = fixtureName();
		const first = randomUUID();
		const second = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('live-v1') });
		await stageApplication(application, first);
		await activateStagedApplication(application, first, { activationSpec: { package: null } });

		application.payload = await makeComponentPayload('candidate-v2');
		const stagedPath = await stageApplication(application, second);
		await fs.mkdir(path.join(stagedPath, 'vendor', 'probe'), { recursive: true });
		await fs.writeFile(path.join(stagedPath, 'vendor', 'probe', 'index.js'), "module.exports = 'probe';\n");
		await fs.mkdir(path.join(stagedPath, 'node_modules'), { recursive: true });
		await fs.symlink(path.join(stagedPath, 'vendor', 'probe'), path.join(stagedPath, 'node_modules', 'probe'), 'dir');

		// Fail after the links were rewritten and the swap landed, so the rollback path runs in full.
		await assert.rejects(() =>
			activateStagedApplication(application, second, {
				activationSpec: { package: null },
				beforeCommit: async () => {
					throw new Error('simulated persistent-work failure');
				},
			})
		);

		assert.match(await readMarker(application.dirPath), /live-v1/, 'the previous release is live again');
		// The candidate is back in staging and its dependency resolves from there, not from the live path.
		assert.equal(
			await fs.readFile(path.join(stagedPath, 'node_modules', 'probe', 'index.js'), 'utf8'),
			"module.exports = 'probe';\n",
			'the rolled-back candidate resolves its dependency from staging'
		);

		// And it can still be activated on a retry.
		await activateStagedApplication(application, second, { activationSpec: { package: null } });
		assert.match(await readMarker(application.dirPath), /candidate-v2/);
		assert.equal(
			await fs.readFile(path.join(application.dirPath, 'node_modules', 'probe', 'index.js'), 'utf8'),
			"module.exports = 'probe';\n",
			'the retry re-points the links at the live path'
		);
		await cleanup(name);
	});
	it('discards a broken staged candidate without failing the healthy live component closed', async () => {
		// Only a not-yet-activated candidate is broken here; the live tree and its persisted config are
		// consistent, so the fail-closed rationale that applies to an interrupted activation does not.
		// Failing this component would also be permanent: nothing else sweeps a staging directory whose
		// component subtree is missing.
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('live') });
		await stageApplication(application, deploymentId);
		await fs.mkdir(application.dirPath, { recursive: true });
		await fs.writeFile(path.join(application.dirPath, 'index.js'), "module.exports = 'live';\n");
		// Break the candidate: remove its component subtree but leave the deployment directory behind.
		await fs.rm(stagedApplicationPath(application.dirPath, deploymentId), { recursive: true, force: true });

		const settled = [];
		const reconciliation = await reconcileStagedApplicationArtifacts(
			COMPONENTS_ROOT,
			async () => ({
				deployment_id: deploymentId,
				project: name,
				status: 'staged',
				activation_spec: { package: null },
			}),
			async () => {
				throw new Error('activation persistence must not be reached for a staged row');
			},
			async (id) => settled.push(id)
		);

		assert.equal(reconciliation.failedProjects.has(name), false, 'the live component is not failed closed');
		assert.deepEqual(settled, [deploymentId], 'the unusable candidate row is settled so its payload can be reclaimed');
		assert.equal(reconciliation.removed.includes(deploymentId), true, 'and its residue is removed');
		assert.match(await readMarker(application.dirPath), /live/, 'the live component is untouched');
		await cleanup(name);
	});

	it('does not fail a component closed when settling a broken staged candidate itself fails', async () => {
		// The staged branch can still throw — an I/O error on the completeness probe, or on settling or
		// removing the residue. None of those say the live tree disagrees with its config, so none should
		// keep the component from loading; only an interrupted activation does.
		const name = fixtureName();
		const deploymentId = randomUUID();
		const application = new Application({ name, payload: await makeComponentPayload('live') });
		await stageApplication(application, deploymentId);
		await fs.mkdir(application.dirPath, { recursive: true });
		await fs.writeFile(path.join(application.dirPath, 'index.js'), "module.exports = 'live';\n");
		await fs.rm(stagedApplicationPath(application.dirPath, deploymentId), { recursive: true, force: true });

		const reconciliation = await reconcileStagedApplicationArtifacts(
			COMPONENTS_ROOT,
			async () => ({
				deployment_id: deploymentId,
				project: name,
				status: 'staged',
				activation_spec: { package: null },
			}),
			async () => {},
			async () => {
				throw new Error('simulated settle failure');
			}
		);

		assert.equal(reconciliation.errors.has(deploymentId), true, 'the failure is still reported');
		assert.equal(
			reconciliation.failedProjects.has(name),
			false,
			'but it is not attributed to the component, so the healthy live tree still loads'
		);
		await cleanup(name);
	});
	it('rolls config back when a failure lands after the config commit, not just during it', async () => {
		// The commit is followed by the manifest write and the retain rename. A failure in either used to
		// undo only the directories, leaving root config and the application lock naming the reverted-to
		// release while the original bytes were live again — which a cold start would then reinstall over.
		const name = fixtureName();
		const { application, first, second } = await twoActivations(name);
		let committed = 0;
		let rolledBack = 0;

		// Fail the retain rename by making the retained-previous slot unwritable at that moment: the
		// manifest write has already succeeded, so this is strictly post-commit.
		const previousRoot = path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR);
		await assert.rejects(() =>
			revertApplication(application, first, {
				commitPersistentState: async () => {
					committed++;
					await fs.chmod(previousRoot, 0o500);
				},
				rollbackPersistentState: async () => {
					rolledBack++;
					await fs.chmod(previousRoot, 0o700);
				},
			})
		);
		await fs.chmod(previousRoot, 0o700).catch(() => {});

		assert.equal(committed, 1, 'the commit ran');
		assert.equal(rolledBack, 1, 'and a post-commit failure rolled it back');
		assert.match(await readMarker(application.dirPath), /v2/, 'the pre-revert version is live again');
		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.live.deployment_id, second, 'the manifest was put back too, so live/manifest agree');
		assert.equal(target.previous.deployment_id, first);
		await cleanup(name);
	});

	it('rolls forward an interrupted revert whose compensation had already moved live away', async () => {
		// Crash shape: config and the manifest committed, then compensation renamed live away before it
		// could put the holding tree back. Undoing the directories here would contradict the persisted
		// state, so recovery has to finish the revert instead — decided by comparing marker to manifest.
		const name = fixtureName();
		const { application, first, second } = await twoActivations(name);
		const previousPath = path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, name);
		const holding = path.join(COMPONENTS_ROOT, DEPLOY_PREVIOUS_DIR, `.reverting-${name}-${randomUUID()}`);

		// Build that exact state by hand: live absent, previous = reverted-to tree, holding = old live,
		// manifest already exchanged, and a marker recording the same intent.
		const staleManifest = JSON.parse(await fs.readFile(`${previousPath}.json`, 'utf8'));
		const intended = { previous: staleManifest.live, live: staleManifest.previous };
		await fs.rename(application.dirPath, holding);
		await fs.writeFile(`${holding}.recovering.json`, JSON.stringify(intended, null, 2));
		await fs.writeFile(`${previousPath}.json`, JSON.stringify(intended, null, 2));

		const failures = await recoverInterruptedReverts(COMPONENTS_ROOT);

		assert.equal(failures.size, 0);
		assert.match(await readMarker(application.dirPath), /v1/, 'the reverted-to version is live, matching config');
		assert.match(await readMarker(previousPath), /v2/, 'the displaced tree is retained');
		assert.equal(existsSync(holding), false);
		assert.equal(existsSync(`${holding}.recovering.json`), false);
		const target = await getRevertTarget(application.dirPath);
		assert.equal(target.live.deployment_id, first);
		assert.equal(target.previous.deployment_id, second);
		await cleanup(name);
	});
	it('serializes root-config and application-lock writes on a lock outside this isolate', async () => {
		// The in-isolate write queue only orders writers within one isolate, but peer phases run in worker
		// threads and different projects take different component locks — so an unsynchronized
		// read-modify-write of the shared lock file drops a sibling project's entry. The transaction now
		// takes a filesystem lock keyed on the lock file itself, which is what makes it cross-isolate.
		//
		// Holding that same lock from outside proves the critical section exists: a commit cannot proceed
		// while it is held. A same-isolate concurrency test could NOT demonstrate this — the in-isolate
		// queue masks the interleaving, which is exactly why the file lock was needed.
		const name = fixtureName();
		const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-persist-lock-'));
		const priorRootEnv = process.env.ROOTPATH;
		const priorRootConfig = getConfigPath(CONFIG_PARAMS.ROOTPATH);
		process.env.ROOTPATH = configRoot;
		environment.setProperty(CONFIG_PARAMS.ROOTPATH, configRoot);
		await fs.writeFile(path.join(configRoot, 'harper-config.yaml'), `rootPath: ${JSON.stringify(configRoot)}\n`);
		const lockPath = path.join(configRoot, 'harper-application-lock.json');
		try {
			const transaction = await createApplicationConfigTransaction(name, { package: 'example@1.0.0' });
			let committed = false;
			let releaseHold;
			const holdReleased = new Promise((resolve) => (releaseHold = resolve));

			// The holder waits on an external signal, and the commit is started OUTSIDE it. Awaiting the
			// commit from inside would deadlock: the lock is not reentrant, so the holder could not release
			// until the commit finished and the commit could not start until the holder released.
			const holder = withComponentPreparationLock(lockPath, () => holdReleased);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const commitPromise = transaction.commit().then(() => (committed = true));
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(committed, false, 'the commit must wait while the persistent-state lock is held');

			releaseHold();
			await holder;
			await commitPromise;
			assert.equal(committed, true, 'and proceed once it is released');
			assert.deepEqual(readConfigFile()[name], { package: 'example@1.0.0' });
			const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
			assert.deepEqual(lock.applications[name], { package: 'example@1.0.0' });
		} finally {
			if (priorRootEnv === undefined) delete process.env.ROOTPATH;
			else process.env.ROOTPATH = priorRootEnv;
			environment.setProperty(CONFIG_PARAMS.ROOTPATH, priorRootConfig);
			await fs.rm(configRoot, { recursive: true, force: true });
		}
	});

	it("keeps a sibling project's application-lock entry across a second project's transaction", async () => {
		const first = fixtureName();
		const second = fixtureName();
		const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-persist-sibling-'));
		const priorRootEnv = process.env.ROOTPATH;
		const priorRootConfig = getConfigPath(CONFIG_PARAMS.ROOTPATH);
		process.env.ROOTPATH = configRoot;
		environment.setProperty(CONFIG_PARAMS.ROOTPATH, configRoot);
		await fs.writeFile(path.join(configRoot, 'harper-config.yaml'), `rootPath: ${JSON.stringify(configRoot)}\n`);
		try {
			const a = await createApplicationConfigTransaction(first, { package: 'a@1.0.0' });
			const b = await createApplicationConfigTransaction(second, { package: 'b@1.0.0' });
			await Promise.all([a.commit(), b.commit()]);

			const lock = JSON.parse(await fs.readFile(path.join(configRoot, 'harper-application-lock.json'), 'utf8'));
			assert.deepEqual(lock.applications[first], { package: 'a@1.0.0' }, 'the first entry survives');
			assert.deepEqual(lock.applications[second], { package: 'b@1.0.0' }, 'and so does the second');
		} finally {
			if (priorRootEnv === undefined) delete process.env.ROOTPATH;
			else process.env.ROOTPATH = priorRootEnv;
			environment.setProperty(CONFIG_PARAMS.ROOTPATH, priorRootConfig);
			await fs.rm(configRoot, { recursive: true, force: true });
		}
	});

	// Same contract the extraction scan owes its caller: componentLoader fails startup closed on a
	// rejection, so an absent retention root (nothing ever retained) must stay distinguishable from one
	// we could not read, where a component may be mid-revert with no live directory at all.
	it('resolves empty when the retention root is absent but rejects when it is unreadable', async () => {
		const scanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'revert-scan-'));
		try {
			assert.equal((await recoverInterruptedReverts(scanRoot)).size, 0);

			await fs.writeFile(path.join(scanRoot, DEPLOY_PREVIOUS_DIR), 'not a directory\n');
			await assert.rejects(() => recoverInterruptedReverts(scanRoot), { code: 'ENOTDIR' });
		} finally {
			await fs.rm(scanRoot, { recursive: true, force: true });
		}
	});
});
