'use strict';

// #2315 step 6: `deploy_component` can build and certify a component without activating it, and a later
// request can swap that artifact in by deployment id. These cover the filesystem protocol that makes the
// delay safe — the artifact descriptor, the exclusive claim on a public id, the verification an activation
// runs before it touches anything, and the return to a dormant, retryable state when one fails.

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	buildCandidateApplication,
	prepareApplication,
	pruneDormantBuilds,
	candidateApplicationPath,
	DEPLOY_STAGING_DIR,
	Application,
} = require('#src/components/Application');
const { packageDirectory } = require('#src/components/packageComponent');

async function newRoot(label) {
	return fs.mkdtemp(path.join(os.tmpdir(), `stage-activate-${label}-`));
}

async function makeTarball(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-src-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content);
	}
	return packageDirectory(dir, { skip_node_modules: true });
}

async function writeLive(componentsRoot, name, marker) {
	const dirPath = path.join(componentsRoot, name);
	await fs.mkdir(dirPath, { recursive: true });
	await fs.writeFile(path.join(dirPath, 'package.json'), `{"name":"${name}","version":"1.0.0"}\n`);
	await fs.writeFile(path.join(dirPath, 'index.js'), marker);
	return dirPath;
}

function applicationAt(componentsRoot, name, payload) {
	const app = new Application({ name, payload });
	app.dirPath = path.join(componentsRoot, name);
	return app;
}

/** Stage `marker` as component `name` under `id`, through the real preparation path. */
async function stage(componentsRoot, name, id, marker, options = {}) {
	const app = applicationAt(
		componentsRoot,
		name,
		await makeTarball({ 'package.json': `{"name":"${name}","version":"2.0.0"}\n`, 'index.js': marker })
	);
	await prepareApplication(app, { mode: 'stage', artifactId: id, ...options });
	return app;
}

function deploymentDir(componentsRoot, id) {
	return path.join(componentsRoot, DEPLOY_STAGING_DIR, id);
}

async function readLive(componentsRoot, name) {
	return fs.readFile(path.join(componentsRoot, name, 'index.js'), 'utf8');
}

async function readDescriptor(componentsRoot, id) {
	return JSON.parse(await fs.readFile(path.join(deploymentDir(componentsRoot, id), '.artifact.json'), 'utf8'));
}

describe('staging a build without activating it', () => {
	it('leaves the live tree untouched and the artifact dormant, complete and described', async function () {
		this.timeout(20000);
		const root = await newRoot('dormant');
		await writeLive(root, 'web', 'LIVE v1\n');

		await stage(root, 'web', 'a1', 'STAGED v2\n');

		assert.strictEqual(await readLive(root, 'web'), 'LIVE v1\n', 'staging does not change what is serving');
		const dir = deploymentDir(root, 'a1');
		assert.ok(existsSync(path.join(dir, '.complete')), 'the artifact is certified');
		assert.strictEqual(existsSync(path.join(dir, '.activation.json')), false, 'and dormant — no activation');
		assert.strictEqual(await fs.readFile(path.join(dir, '.component'), 'utf8'), 'web');
		assert.strictEqual(
			await fs.readFile(path.join(dir, 'web', 'index.js'), 'utf8'),
			'STAGED v2\n',
			'the built tree is waiting under the deployment id'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('records a payload build as owning no root config, so activation publishes none', async function () {
		this.timeout(20000);
		const root = await newRoot('descriptor-payload');
		await writeLive(root, 'web', 'LIVE v1\n');

		await stage(root, 'web', 'a1', 'STAGED v2\n');

		const descriptor = await readDescriptor(root, 'a1');
		assert.strictEqual(descriptor.v, 1);
		assert.strictEqual(descriptor.component, 'web');
		assert.strictEqual(descriptor.rootConfig, null, 'a payload deploy owns no root-config entry');
		assert.strictEqual(descriptor.installationIsOpaque, false);
		assert.strictEqual(descriptor.isolated, false);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('records the root-config entry a package build would have published, and its opacity', async function () {
		this.timeout(20000);
		const root = await newRoot('descriptor-package');
		await writeLive(root, 'web', 'LIVE v1\n');
		await stage(root, 'web', 'a1', 'STAGED v2\n', {
			describeArtifact: () => ({ rootConfig: { package: 'npm:web', isolated: true }, isolated: true }),
		});

		const descriptor = await readDescriptor(root, 'a1');
		assert.deepStrictEqual(descriptor.rootConfig, { package: 'npm:web', isolated: true });
		assert.strictEqual(descriptor.isolated, true, 'admission and publication agree');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('refuses to stage a tree that links outside itself, which nothing can certify', async function () {
		this.timeout(20000);
		if (process.platform === 'win32') return this.skip(); // symlink creation needs privileges on Windows
		const root = await newRoot('foreign-link');
		await writeLive(root, 'web', 'LIVE v1\n');
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-outside-'));
		await fs.writeFile(path.join(outside, 'dep.js'), 'EXTERNAL v1\n');
		// An install step that links a dependency out of the build, the way a local `file:` dependency or a
		// custom installer does.
		const app = applicationAt(
			root,
			'web',
			await makeTarball({ 'package.json': '{"name":"web","version":"2.0.0"}\n', 'index.js': 'STAGED\n' })
		);

		await assert.rejects(
			() =>
				prepareApplication(app, {
					mode: 'stage',
					artifactId: 'a1',
					validateCandidate: async (candidateDirPath) => {
						await fs.mkdir(path.join(candidateDirPath, 'node_modules'), { recursive: true });
						await fs.symlink(outside, path.join(candidateDirPath, 'node_modules', 'dep'), 'dir');
					},
				}),
			/links outside the build/
		);
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});

	it('exempts only the loader-owned link at the top level, not a copy nested in a dependency', async function () {
		this.timeout(20000);
		if (process.platform === 'win32') return this.skip();
		const root = await newRoot('nested-loader-link');
		await writeLive(root, 'web', 'LIVE v1\n');
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-nested-'));
		const app = applicationAt(
			root,
			'web',
			await makeTarball({ 'package.json': '{"name":"web","version":"2.0.0"}\n', 'index.js': 'STAGED\n' })
		);

		await assert.rejects(
			() =>
				prepareApplication(app, {
					mode: 'stage',
					artifactId: 'a1',
					validateCandidate: async (candidateDirPath) => {
						// The loader repairs the component's own node_modules/harper. It never touches one nested
						// inside a dependency, so that name there is an ordinary external link.
						const nested = path.join(candidateDirPath, 'node_modules', 'dep', 'node_modules');
						await fs.mkdir(nested, { recursive: true });
						await fs.symlink(outside, path.join(nested, 'harper'), 'dir');
					},
				}),
			/links outside the build/
		);
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});
});

describe('claiming a deployment id', () => {
	it('refuses to rebuild over a completed artifact, so an id names one set of bytes', async function () {
		this.timeout(20000);
		const root = await newRoot('claim-complete');
		await writeLive(root, 'web', 'LIVE v1\n');
		await stage(root, 'web', 'a1', 'STAGED v2\n');

		await assert.rejects(() => stage(root, 'web', 'a1', 'DIFFERENT v3\n'), /already holds a completed build/);
		assert.strictEqual(
			await fs.readFile(path.join(deploymentDir(root, 'a1'), 'web', 'index.js'), 'utf8'),
			'STAGED v2\n',
			'the certified bytes are the ones that survive'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('refuses an id another component already holds, rather than crossing its lock', async function () {
		this.timeout(20000);
		const root = await newRoot('claim-foreign');
		await writeLive(root, 'web', 'LIVE\n');
		await writeLive(root, 'api', 'LIVE\n');
		await stage(root, 'api', 'a1', 'API STAGED\n');

		await assert.rejects(() => stage(root, 'web', 'a1', 'WEB STAGED\n'), /already holds a build of 'api'/);
		assert.strictEqual(await fs.readFile(path.join(deploymentDir(root, 'a1'), '.component'), 'utf8'), 'api');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('rebuilds over an abandoned partial build, which nothing certified', async function () {
		this.timeout(20000);
		const root = await newRoot('claim-partial');
		await writeLive(root, 'web', 'LIVE v1\n');
		const dir = deploymentDir(root, 'a1');
		await fs.mkdir(path.join(dir, 'web'), { recursive: true });
		await fs.writeFile(path.join(dir, '.component'), 'web');
		await fs.writeFile(path.join(dir, 'web', 'index.js'), 'HALF-BUILT\n');

		await stage(root, 'web', 'a1', 'STAGED v2\n');

		assert.strictEqual(await fs.readFile(path.join(dir, 'web', 'index.js'), 'utf8'), 'STAGED v2\n');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('refuses an id held by a build that has not named its component yet', async function () {
		this.timeout(20000);
		const root = await newRoot('claim-unattributable');
		await writeLive(root, 'web', 'LIVE v1\n');
		// A build in flight under this id, caught before it is attributable: no sidecar yet, and no single
		// component directory for ownership to be inferred from either — an extraction that has written its
		// tarball but not yet its tree. It may belong to ANOTHER component, and only that component's own
		// lock serializes its claim, so removing it here would delete a live build.
		const dir = deploymentDir(root, 'a1');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, 'payload.tgz'), 'BEING BUILT\n');

		await assert.rejects(() => stage(root, 'web', 'a1', 'WEB STAGED\n'), /has not named its component yet/);
		assert.strictEqual(
			await fs.readFile(path.join(dir, 'payload.tgz'), 'utf8'),
			'BEING BUILT\n',
			'the in-flight build is left alone'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('rejects an id that is not a single path segment before it reaches the filesystem', async () => {
		const root = await newRoot('claim-traversal');
		const live = path.join(root, 'web');
		for (const id of ['../escape', 'a/b', '..', '.', '']) {
			assert.throws(() => candidateApplicationPath(live, id), /not a single path segment/, `id ${JSON.stringify(id)}`);
		}
		await fs.rm(root, { recursive: true, force: true });
	});
});

describe('activating a staged artifact', () => {
	it('swaps in the staged bytes without rebuilding, and consumes the artifact', async function () {
		this.timeout(20000);
		const root = await newRoot('activate');
		await writeLive(root, 'web', 'LIVE v1\n');
		await stage(root, 'web', 'a1', 'STAGED v2\n');

		// No payload: an activation resolves and installs nothing.
		await prepareApplication(applicationAt(root, 'web'), { mode: 'activate', artifactId: 'a1' });

		assert.strictEqual(await readLive(root, 'web'), 'STAGED v2\n');
		assert.strictEqual(
			existsSync(deploymentDir(root, 'a1')),
			false,
			'the rename consumes the artifact, so the id is not activatable twice'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('publishes the root-config entry the build recorded, immediately before the swap', async function () {
		this.timeout(20000);
		const root = await newRoot('activate-config');
		await writeLive(root, 'web', 'LIVE v1\n');
		await stage(root, 'web', 'a1', 'STAGED v2\n', {
			describeArtifact: () => ({ rootConfig: { package: 'npm:web', isolated: false }, isolated: false }),
		});

		const published = [];
		await prepareApplication(applicationAt(root, 'web'), {
			mode: 'activate',
			artifactId: 'a1',
			publishRootConfig: async (entry) => {
				published.push({ entry, liveAtPublication: await readLive(root, 'web') });
			},
		});

		assert.deepStrictEqual(published[0].entry, { package: 'npm:web', isolated: false });
		assert.strictEqual(published[0].liveAtPublication, 'LIVE v1\n', 'config is published before the swap, not after');
		assert.strictEqual(await readLive(root, 'web'), 'STAGED v2\n');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('admits the isolation the build declared, under the preparation lock', async function () {
		this.timeout(20000);
		const root = await newRoot('activate-isolation');
		await writeLive(root, 'web', 'LIVE v1\n');
		await stage(root, 'web', 'a1', 'STAGED v2\n', {
			describeArtifact: () => ({ rootConfig: { package: 'npm:web', isolated: true }, isolated: true }),
		});

		const admitted = [];
		await prepareApplication(applicationAt(root, 'web'), {
			mode: 'activate',
			artifactId: 'a1',
			admitIsolation: async (descriptor) => admitted.push(descriptor.isolated),
			publishRootConfig: async () => {},
		});

		assert.deepStrictEqual(admitted, [true]);
		await fs.rm(root, { recursive: true, force: true });
	});

	describe('refuses, and preserves what it refused', () => {
		const activate = (root, component, id, options = {}) =>
			prepareApplication(applicationAt(root, component), { mode: 'activate', artifactId: id, ...options });

		it('when no artifact with that id is on this node', async function () {
			this.timeout(20000);
			const root = await newRoot('reject-missing');
			await writeLive(root, 'web', 'LIVE v1\n');

			await assert.rejects(() => activate(root, 'web', 'nope'), /no staged build with that id/);
			assert.strictEqual(await readLive(root, 'web'), 'LIVE v1\n');
			await fs.rm(root, { recursive: true, force: true });
		});

		it('when the artifact belongs to another component, without deleting it', async function () {
			this.timeout(20000);
			const root = await newRoot('reject-foreign');
			await writeLive(root, 'web', 'LIVE web\n');
			await writeLive(root, 'api', 'LIVE api\n');
			await stage(root, 'api', 'a1', 'API STAGED\n');

			await assert.rejects(() => activate(root, 'web', 'a1'), /belongs to 'api'/);
			assert.ok(existsSync(deploymentDir(root, 'a1')), "another component's artifact is not this request's to remove");
			assert.strictEqual(await readLive(root, 'web'), 'LIVE web\n');
			await fs.rm(root, { recursive: true, force: true });
		});

		it('when the build never completed', async function () {
			this.timeout(20000);
			const root = await newRoot('reject-incomplete');
			await writeLive(root, 'web', 'LIVE v1\n');
			await stage(root, 'web', 'a1', 'STAGED v2\n');
			await fs.rm(path.join(deploymentDir(root, 'a1'), '.complete'));

			await assert.rejects(() => activate(root, 'web', 'a1'), /its build never completed/);
			assert.ok(existsSync(deploymentDir(root, 'a1')));
			await fs.rm(root, { recursive: true, force: true });
		});

		it('when recovery marked it unsettled', async function () {
			this.timeout(20000);
			const root = await newRoot('reject-unsettled');
			await writeLive(root, 'web', 'LIVE v1\n');
			await stage(root, 'web', 'a1', 'STAGED v2\n');
			await fs.writeFile(path.join(deploymentDir(root, 'a1'), '.unsettled'), '');

			await assert.rejects(() => activate(root, 'web', 'a1'), /could not settle it/);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('when it does not record what its build decided', async function () {
			this.timeout(20000);
			const root = await newRoot('reject-nodescriptor');
			await writeLive(root, 'web', 'LIVE v1\n');
			await stage(root, 'web', 'a1', 'STAGED v2\n');
			await fs.rm(path.join(deploymentDir(root, 'a1'), '.artifact.json'));

			await assert.rejects(() => activate(root, 'web', 'a1'), /does not record what its build decided/);
			assert.strictEqual(await readLive(root, 'web'), 'LIVE v1\n');
			await fs.rm(root, { recursive: true, force: true });
		});

		it('when the descriptor is unreadable, a version it cannot activate, or names another component', async function () {
			this.timeout(20000);
			const cases = [
				['{"v":1,"component":"web"', /not readable JSON/],
				[
					JSON.stringify({ v: 99, component: 'web', rootConfig: null, installationIsOpaque: false, isolated: false }),
					/this build cannot activate/,
				],
				[
					JSON.stringify({ v: 1, component: 'api', rootConfig: null, installationIsOpaque: false, isolated: false }),
					/names component 'api'/,
				],
				[JSON.stringify({ v: 1, component: 'web', rootConfig: null, isolated: false }), /runtime decisions/],
				[
					JSON.stringify({ v: 1, component: 'web', rootConfig: [], installationIsOpaque: false, isolated: false }),
					/root-config entry or its absence/,
				],
				[
					JSON.stringify({
						v: 1,
						component: 'web',
						rootConfig: { isolated: true },
						installationIsOpaque: false,
						isolated: false,
					}),
					/admits isolated=false but publishes isolated=true/,
				],
			];
			for (const [contents, expected] of cases) {
				const root = await newRoot('reject-descriptor');
				await writeLive(root, 'web', 'LIVE v1\n');
				await stage(root, 'web', 'a1', 'STAGED v2\n');
				await fs.writeFile(path.join(deploymentDir(root, 'a1'), '.artifact.json'), contents);

				await assert.rejects(() => activate(root, 'web', 'a1'), expected, contents);
				assert.strictEqual(await readLive(root, 'web'), 'LIVE v1\n', 'nothing is swapped on a rejected descriptor');
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	});
});

describe('retention and a staged artifact', () => {
	it('never evicts the artifact a request named, even when the bound is zero', async () => {
		const root = await newRoot('pin');
		const builds = [];
		for (const [id, completedAt] of [
			['older', 1000],
			['pinned', 2000],
			['newer', 3000],
		]) {
			const dir = deploymentDir(root, id);
			await fs.mkdir(path.join(dir, 'web'), { recursive: true });
			await fs.writeFile(path.join(dir, '.component'), 'web');
			await fs.writeFile(path.join(dir, '.complete'), '');
			await fs.utimes(path.join(dir, '.complete'), completedAt, completedAt);
			builds.push({ deploymentDirPath: dir, deploymentId: id, completedAt });
		}

		await pruneDormantBuilds('web', builds, 0, 'pinned');

		assert.strictEqual(existsSync(deploymentDir(root, 'pinned')), true, 'the named artifact survives its own preamble');
		assert.strictEqual(existsSync(deploymentDir(root, 'older')), false);
		assert.strictEqual(existsSync(deploymentDir(root, 'newer')), false);
		await fs.rm(root, { recursive: true, force: true });
	});
});

describe('an activation that fails before it commits', () => {
	// The live tree is restored by compensation, but the artifact also has to come back to DORMANT — no
	// journal — or the next preparation reads live-plus-candidate as an abandoned activation and deletes the
	// very artifact the operator staged.
	// The failure has to land AFTER the journal is written, or none of the above is exercised. Putting a
	// regular file where the aside staging directory belongs does exactly that: verification passes, the
	// journal is published, and `ensureExtractionStagingDirectory` then refuses a path that is not a
	// directory — the first step inside the boundary. Permission games cannot reach the same window, because
	// the directory that has to be unwritable for the swap to fail is the one the journal lives in.
	const blockAsideStaging = async (root, component) => {
		const asideDir = path.join(root, '.deploy-aside', component);
		await fs.mkdir(path.dirname(asideDir), { recursive: true, mode: 0o700 });
		await fs.rm(asideDir, { recursive: true, force: true });
		await fs.writeFile(asideDir, '');
		return () => fs.rm(asideDir, { force: true });
	};

	const failActivation = async (root, component, id, options = {}) => {
		const unblock = await blockAsideStaging(root, component);
		try {
			await assert.rejects(
				() => prepareApplication(applicationAt(root, component), { mode: 'activate', artifactId: id, ...options }),
				/EEXIST|not a directory/
			);
		} finally {
			await unblock();
		}
	};

	it('leaves an existing component live and its artifact dormant and retryable', async function () {
		this.timeout(30000);
		const root = await newRoot('compensate-existing');
		await writeLive(root, 'web', 'LIVE v1\n');
		await stage(root, 'web', 'a1', 'STAGED v2\n');

		await failActivation(root, 'web', 'a1');

		assert.strictEqual(await readLive(root, 'web'), 'LIVE v1\n', 'the previous version is back');
		assert.strictEqual(
			existsSync(path.join(deploymentDir(root, 'a1'), '.activation.json')),
			false,
			'and the artifact carries no journal, so nothing settles it away'
		);
		assert.ok(existsSync(path.join(deploymentDir(root, 'a1'), '.complete')), 'it is dormant again, not residue');

		// The proof it is retryable: a second activation of the same id lands.
		await prepareApplication(applicationAt(root, 'web'), { mode: 'activate', artifactId: 'a1' });
		assert.strictEqual(await readLive(root, 'web'), 'STAGED v2\n');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('leaves a first-ever component absent and its artifact dormant, not rolled forward', async function () {
		this.timeout(30000);
		const root = await newRoot('compensate-first');
		await fs.mkdir(root, { recursive: true });
		await stage(root, 'web', 'a1', 'STAGED v1\n');

		await failActivation(root, 'web', 'a1');

		assert.strictEqual(existsSync(path.join(root, 'web')), false, 'a first deploy that failed is still not live');
		assert.strictEqual(
			existsSync(path.join(deploymentDir(root, 'a1'), '.activation.json')),
			false,
			'and recovery has nothing telling it to activate a component nobody activated'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('takes back the root-config entry it published, so config does not name a release that is not live', async function () {
		this.timeout(30000);
		const root = await newRoot('compensate-config');
		await writeLive(root, 'web', 'LIVE v1\n');
		await stage(root, 'web', 'a1', 'STAGED v2\n', {
			describeArtifact: () => ({ rootConfig: { package: 'npm:web@2', isolated: false }, isolated: false }),
		});

		const published = [];
		await failActivation(root, 'web', 'a1', {
			publishRootConfig: async (entry) => {
				published.push(entry);
				return async () => published.pop();
			},
		});

		assert.deepStrictEqual(published, [], 'the entry that named the unactivated release was taken back');
		await fs.rm(root, { recursive: true, force: true });
	});
});

describe('artifact identity is not invocation identity', () => {
	it('releases the deploy it announced, even though the artifact has its own id', async function () {
		this.timeout(20000);
		const root = await newRoot('lifecycle');
		await writeLive(root, 'web', 'LIVE v1\n');

		// `DeployLifecycle` keys suppression by the id a start announces and releases it on the matching
		// end. So a preparation that started under a lifecycle token and ended under the artifact id would
		// never release, and watchers would stay suppressed for the life of the process — which is exactly
		// what conflating the two ids would produce.
		const { deployLifecycle } = require('#src/components/deployLifecycle');
		let inFlightDuring;
		await stage(root, 'web', 'a1', 'STAGED v2\n', {
			validateCandidate: async () => {
				inFlightDuring = deployLifecycle.isDeployInFlight('web');
			},
		});

		assert.strictEqual(inFlightDuring, true, 'the preparation announced a deploy');
		assert.strictEqual(deployLifecycle.isDeployInFlight('web'), false, 'and released the same one, so watchers resume');
		await fs.rm(root, { recursive: true, force: true });
	});
});

describe('a build with no artifact id', () => {
	it('names its staging directory with the lifecycle token, as an ordinary install does', async function () {
		this.timeout(20000);
		const root = await newRoot('no-artifact-id');
		const dirPath = await writeLive(root, 'web', 'LIVE v1\n');
		const app = new Application({
			name: 'web',
			payload: await makeTarball({ 'package.json': '{"name":"web","version":"2.0.0"}\n', 'index.js': 'BUILT\n' }),
		});
		app.dirPath = dirPath;

		const candidatePath = await buildCandidateApplication(app, 'lifecycle-token');

		assert.strictEqual(candidatePath, candidateApplicationPath(dirPath, 'lifecycle-token'));
		await fs.rm(root, { recursive: true, force: true });
	});
});
