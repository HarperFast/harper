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
	extractApplication,
	stagedApplicationPath,
	DEPLOY_STAGING_DIR,
	DEPLOY_ACTIVATION_DIR,
	DEPLOY_PREVIOUS_DIR,
	ASIDE_STAGING_DIR,
} = require('#src/components/Application');
const { getConfigPath, readConfigFile } = require('#src/config/configUtils');
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

		const asideDir = path.join(COMPONENTS_ROOT, ASIDE_STAGING_DIR, name);
		const parked = existsSync(asideDir) ? await fs.readdir(asideDir) : [];
		const unretired = parked.filter(
			(entry) =>
				entry.startsWith('.in-progress-') && !parked.includes(`.retired-${entry.slice('.in-progress-'.length)}`)
		);
		assert.deepEqual(unretired, [], 'an evicted previous is never left looking like a rollback record');
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
});
