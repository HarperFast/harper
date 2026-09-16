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
	publishClaimOwnership,
	DEPLOY_STAGING_DIR,
	Application,
} = require('#src/components/Application');
const { packageDirectory } = require('#src/components/packageComponent');
const { unconfirmedStagingPeers, publishedEntryStillStands } = require('#src/components/operations');

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
			// A 4xx, not the 500 a bare Error gets from the operations handler: the operator asked to stage a
			// component that cannot be staged, and the same component still deploys immediately.
			(error) => /links outside the build/.test(error.message) && error.statusCode === 400
		);
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});

	it('refuses a relative link that leaves the build and re-enters it', async function () {
		this.timeout(20000);
		if (process.platform === 'win32') return this.skip();
		const root = await newRoot('reentrant-link');
		await writeLive(root, 'web', 'LIVE v1\n');
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
						// Resolves inside the candidate today — `.deploy-staging/a1/web/shared` — so the containment
						// check passes. After activation renames the tree the same expression is evaluated from
						// `components/web/assets/`, where it names a path that does not exist.
						await fs.mkdir(path.join(candidateDirPath, 'shared'), { recursive: true });
						await fs.mkdir(path.join(candidateDirPath, 'assets'), { recursive: true });
						await fs.symlink('../../../a1/web/shared', path.join(candidateDirPath, 'assets', 'shared'), 'dir');
					},
				}),
			/leaving the build/
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('refuses a link whose escape is hidden behind an intermediate symlink', async function () {
		this.timeout(20000);
		if (process.platform === 'win32') return this.skip();
		const root = await newRoot('hidden-escape');
		await writeLive(root, 'web', 'LIVE v1\n');
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
						// `up` spells one segment but resolves to `..`, so counting `..` in the target never dips
						// below zero and a lexical check passes it. Only following the links prefix by prefix sees
						// that the walk leaves the candidate.
						await fs.mkdir(path.join(candidateDirPath, 'a', 'b'), { recursive: true });
						await fs.mkdir(path.join(candidateDirPath, 'shared'), { recursive: true });
						await fs.symlink('..', path.join(candidateDirPath, 'a', 'b', 'up'), 'dir');
						await fs.symlink('up/../../../a1/web/shared', path.join(candidateDirPath, 'a', 'b', 'link'), 'dir');
					},
				}),
			/leaving the build/
		);
		await fs.rm(root, { recursive: true, force: true });
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

		// 409, not the 500 a bare Error reaches the caller as: an id that is taken is the caller's to resolve.
		await assert.rejects(
			() => stage(root, 'web', 'a1', 'DIFFERENT v3\n'),
			(error) => /already holds a completed build/.test(error.message) && error.statusCode === 409
		);
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

		await assert.rejects(
			() => stage(root, 'web', 'a1', 'WEB STAGED\n'),
			(error) => /already holds a build of 'api'/.test(error.message) && error.statusCode === 409
		);
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

		await assert.rejects(
			() => stage(root, 'web', 'a1', 'WEB STAGED\n'),
			(error) => /has not named its component yet/.test(error.message) && error.statusCode === 409
		);
		assert.strictEqual(
			await fs.readFile(path.join(dir, 'payload.tgz'), 'utf8'),
			'BEING BUILT\n',
			'the in-flight build is left alone'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('refuses an id whose directory is empty, because a claim in flight looks exactly like that', async function () {
		this.timeout(20000);
		const root = await newRoot('claim-empty');
		await writeLive(root, 'web', 'LIVE v1\n');
		// What another component's claim looks like for as long as it takes to resolve and pack: the
		// directory exists, names nobody, and holds nothing yet. Emptiness cannot distinguish it from a
		// claim that got no further, and only that component's own preparation lock — not this one —
		// serializes it, so deleting on an empty read deletes a build that is still running.
		const dir = deploymentDir(root, 'a1');
		await fs.mkdir(dir, { recursive: true });

		await assert.rejects(
			() => stage(root, 'web', 'a1', 'WEB STAGED\n'),
			(error) => /has not named its component yet/.test(error.message) && error.statusCode === 409
		);
		assert.ok(existsSync(dir), 'the in-flight claim is left alone');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('names its component as part of the claim, before there is a tree to infer it from', async function () {
		this.timeout(20000);
		const root = await newRoot('claim-names-early');
		const tarball = await makeTarball({
			'package.json': '{"name":"web","version":"2.0.0"}\n',
			'index.js': 'STAGED v2\n',
		});
		const app = applicationAt(root, 'web');
		let namedWhenClaimed;
		let treeWhenClaimed;
		Object.defineProperty(app, 'payload', {
			configurable: true,
			get() {
				// The deployment directory exists only once the claim has succeeded, so the first read that
				// sees it is inside the window a concurrent claim used to reclaim: after the mkdir, before
				// anything is extracted.
				if (existsSync(deploymentDir(root, 'a1'))) {
					namedWhenClaimed ??= existsSync(path.join(deploymentDir(root, 'a1'), '.component'));
					treeWhenClaimed ??= existsSync(path.join(deploymentDir(root, 'a1'), 'web'));
				}
				return tarball;
			},
		});

		await prepareApplication(app, { mode: 'stage', artifactId: 'a1' });

		assert.strictEqual(treeWhenClaimed, false, 'no single component directory to infer an owner from yet');
		assert.strictEqual(namedWhenClaimed, true, 'and the claim has already published who it belongs to');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('takes back a directory it created but could not name, so the id is not burned', async () => {
		// Unattributed is a permanent refusal, so a claim that wins the mkdir and then cannot record who it
		// belongs to — a full disk, an EIO on the temp write or its sync — would leave every retry of that id
		// refused by its own wreckage. The write is injected because no filesystem can be made to fail on
		// exactly this write and nothing else.
		const root = await newRoot('claim-unnameable');
		const dir = deploymentDir(root, 'a1');
		await fs.mkdir(dir, { recursive: true });

		await assert.rejects(
			() =>
				publishClaimOwnership(dir, 'web', async () => {
					throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
				}),
			/no space left on device/
		);

		assert.strictEqual(existsSync(dir), false, 'the directory it created is gone, so the id can be claimed again');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('keeps the directory when it can name it', async () => {
		const root = await newRoot('claim-nameable');
		const dir = deploymentDir(root, 'a1');
		await fs.mkdir(dir, { recursive: true });

		await publishClaimOwnership(dir, 'web');

		assert.strictEqual(await fs.readFile(path.join(dir, '.component'), 'utf8'), 'web');
		await fs.rm(root, { recursive: true, force: true });
	});

	it('stages a link whose target is a single legal filename containing a backslash', async function () {
		this.timeout(20000);
		if (process.platform === 'win32') return this.skip(); // there a backslash IS a separator
		// On POSIX a backslash is an ordinary filename character, so `..\\asset` names one entry inside the
		// candidate and keeps resolving there after relocation. Splitting link targets on it anyway turned that
		// into `..` plus `asset` and refused a component that never left its own tree.
		const root = await newRoot('backslash-name');
		await writeLive(root, 'web', 'LIVE v1\n');
		const app = applicationAt(
			root,
			'web',
			await makeTarball({ 'package.json': '{"name":"web","version":"2.0.0"}\n', 'index.js': 'STAGED\n' })
		);

		await prepareApplication(app, {
			mode: 'stage',
			artifactId: 'a1',
			validateCandidate: async (candidateDirPath) => {
				await fs.writeFile(path.join(candidateDirPath, '..\\asset'), 'INSIDE\n');
				await fs.symlink('..\\asset', path.join(candidateDirPath, 'alias'));
			},
		});

		assert.ok(existsSync(path.join(deploymentDir(root, 'a1'), 'web', 'alias')), 'the artifact was staged');
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

		await prepareApplication(applicationAt(root, 'web'), { mode: 'activate', artifactId: 'a1' });

		assert.strictEqual(await readLive(root, 'web'), 'STAGED v2\n');
		assert.strictEqual(
			existsSync(deploymentDir(root, 'a1')),
			false,
			'the rename consumes the artifact, so the id is not activatable twice'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('publishes the root-config entry the build recorded, in the window recovery rolls forward from', async function () {
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
				published.push({
					entry,
					liveDisplaced: !existsSync(path.join(root, 'web')),
					journalPresent: existsSync(path.join(deploymentDir(root, 'a1'), '.activation.json')),
				});
			},
		});

		assert.deepStrictEqual(published[0].entry, { package: 'npm:web', isolated: false });
		// Both true is what makes a crash here roll FORWARD to the certified artifact. Published any earlier
		// — live still present, no rollback record — settlement reads it as an activation that never started,
		// deletes the artifact, and the next boot rebuilds the published package from the registry instead.
		assert.strictEqual(published[0].journalPresent, true, 'the journal is already on disk');
		assert.strictEqual(published[0].liveDisplaced, true, 'and the previous version is already displaced');
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

			// The one 404: nothing here answers to that id. Every other refusal below is a 409, so a caller can
			// tell "never existed or already used" from "present, but not activatable".
			await assert.rejects(
				() => activate(root, 'web', 'nope'),
				(error) => /no staged build with that id/.test(error.message) && error.statusCode === 404
			);
			assert.strictEqual(await readLive(root, 'web'), 'LIVE v1\n');
			await fs.rm(root, { recursive: true, force: true });
		});

		it('when the artifact belongs to another component, without deleting it', async function () {
			this.timeout(20000);
			const root = await newRoot('reject-foreign');
			await writeLive(root, 'web', 'LIVE web\n');
			await writeLive(root, 'api', 'LIVE api\n');
			await stage(root, 'api', 'a1', 'API STAGED\n');

			await assert.rejects(
				() => activate(root, 'web', 'a1'),
				(error) => /belongs to 'api'/.test(error.message) && error.statusCode === 409
			);
			assert.ok(existsSync(deploymentDir(root, 'a1')), "another component's artifact is not this request's to remove");
			assert.strictEqual(await readLive(root, 'web'), 'LIVE web\n');
			await fs.rm(root, { recursive: true, force: true });
		});

		it('when the artifact gained a link out of its tree while it sat dormant', async function () {
			this.timeout(20000);
			const root = await newRoot('reject-tampered-link');
			await writeLive(root, 'web', 'LIVE v1\n');
			await stage(root, 'web', 'a1', 'STAGED v2\n');
			// `.complete` vouches that the bytes reached storage; it is not a seal over them. The link rule
			// ran at stage time, so without re-running it here an artifact edited while dormant reaches the
			// commit rename — and the post-swap repair runs past that point and can only warn.
			await fs.symlink(root, path.join(deploymentDir(root, 'a1'), 'web', 'escape'), 'dir');

			// 409 rather than the stage path's 400: the artifact exists and is this component's, but is no
			// longer what was certified — and rather than the 500 a bare Error would have produced.
			await assert.rejects(
				() => activate(root, 'web', 'a1'),
				(error) => /links outside the build/.test(error.message) && error.statusCode === 409
			);
			assert.strictEqual(await readLive(root, 'web'), 'LIVE v1\n', 'the previous version is still serving');
			assert.ok(existsSync(deploymentDir(root, 'a1')), 'and a refusal never deletes what it refused');
			await fs.rm(root, { recursive: true, force: true });
		});

		it('when the build never completed', async function () {
			this.timeout(20000);
			const root = await newRoot('reject-incomplete');
			await writeLive(root, 'web', 'LIVE v1\n');
			await stage(root, 'web', 'a1', 'STAGED v2\n');
			await fs.rm(path.join(deploymentDir(root, 'a1'), '.complete'));

			await assert.rejects(
				() => activate(root, 'web', 'a1'),
				(error) => /its build never completed/.test(error.message) && error.statusCode === 409
			);
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

				// 409 throughout: the artifact exists and is this component's, but does not describe a build this
				// can activate. A bare Error would reach the caller as a 500.
				await assert.rejects(
					() => activate(root, 'web', 'a1'),
					(error) => expected.test(error.message) && error.statusCode === 409,
					contents
				);
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
	// A read-only components ROOT is what lands the failure past verification, `publishRootConfig` and the
	// journal write: reads still succeed, the deployment directory and lock root stay writable, and only a
	// rename whose parent is the root fails. The aside staging directory is pre-created so the preparation
	// preamble takes its recovery branch here rather than creating it later from inside the boundary.
	/**
	 * Whether a read-only directory actually denies this process a write. Root ignores the mode bits and
	 * Windows does not model them this way, so the injection below would silently do nothing there; probing
	 * keeps such an environment skipping rather than passing with nothing exercised.
	 */
	const readOnlyDirectoryDeniesWrites = async () => {
		const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-activate-probe-'));
		try {
			await fs.chmod(probe, 0o500);
			await fs.writeFile(path.join(probe, 'x'), '');
			return false;
		} catch {
			return true;
		} finally {
			await fs.chmod(probe, 0o700).catch(() => {});
			await fs.rm(probe, { recursive: true, force: true });
		}
	};

	const failAfterJournal = async (root, component, id, options = {}) => {
		await fs.mkdir(path.join(root, '.deploy-aside', component), { recursive: true, mode: 0o700 });
		await fs.chmod(root, 0o500);
		try {
			await assert.rejects(
				() => prepareApplication(applicationAt(root, component), { mode: 'activate', artifactId: id, ...options }),
				(error) => {
					// The window is proven by WHICH failure arrives. A read-only root cannot fail verification
					// (those are reads, and they throw our own "Cannot deploy" message) and cannot fail the
					// journal write (the deployment directory stays writable), so a permission error here can
					// only have come from a rename whose parent is the root — B1 or B2, both past the journal.
					assert.match(String(error.message), /EACCES|EPERM/);
					assert.doesNotMatch(String(error.message), /Cannot deploy|EEXIST/);
					return true;
				}
			);
		} finally {
			await fs.chmod(root, 0o700);
		}
	};

	it('leaves an existing component live and its artifact dormant and retryable', async function () {
		this.timeout(30000);
		if (!(await readOnlyDirectoryDeniesWrites())) return this.skip();
		const root = await newRoot('compensate-existing');
		await writeLive(root, 'web', 'LIVE v1\n');
		await stage(root, 'web', 'a1', 'STAGED v2\n');

		await failAfterJournal(root, 'web', 'a1');

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
		if (!(await readOnlyDirectoryDeniesWrites())) return this.skip();
		const root = await newRoot('compensate-first');
		await fs.mkdir(root, { recursive: true });
		await stage(root, 'web', 'a1', 'STAGED v1\n');

		await failAfterJournal(root, 'web', 'a1');

		assert.strictEqual(existsSync(path.join(root, 'web')), false, 'a first deploy that failed is still not live');
		assert.strictEqual(
			existsSync(path.join(deploymentDir(root, 'a1'), '.activation.json')),
			false,
			'and recovery has nothing telling it to activate a component nobody activated'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	// A read-only ROOT cannot reach the config publish: B1 renames the live tree out of the root, so it is
	// the step that fails and the callback never runs. To land the failure between the publish and the
	// commit, the publish itself takes write permission off the DEPLOYMENT directory — B2 renames the
	// candidate out of there — and the undo puts it back so compensation can still do its work.
	const failAfterConfigPublish = async (root, component, id, onUndo) => {
		const seen = { published: [], undone: 0 };
		await assert.rejects(
			() =>
				prepareApplication(applicationAt(root, component), {
					mode: 'activate',
					artifactId: id,
					publishRootConfig: async (entry) => {
						seen.published.push(entry);
						await fs.chmod(deploymentDir(root, id), 0o500);
						return async () => {
							await fs.chmod(deploymentDir(root, id), 0o700);
							seen.undone++;
							await onUndo?.();
						};
					},
				}),
			(error) => {
				assert.match(String(error.message), /EACCES|EPERM/);
				assert.doesNotMatch(String(error.message), /Cannot deploy/);
				return true;
			}
		);
		await fs.chmod(deploymentDir(root, id), 0o700).catch(() => {});
		assert.strictEqual(seen.published.length, 1, 'the config publish ran, so the failure is past it');
		return seen;
	};

	it('takes back the root-config entry it published, so config does not name a release that is not live', async function () {
		this.timeout(30000);
		if (!(await readOnlyDirectoryDeniesWrites())) return this.skip();
		const root = await newRoot('compensate-config');
		await writeLive(root, 'web', 'LIVE v1\n');
		await stage(root, 'web', 'a1', 'STAGED v2\n', {
			describeArtifact: () => ({ rootConfig: { package: 'npm:web@2', isolated: false }, isolated: false }),
		});

		const seen = await failAfterConfigPublish(root, 'web', 'a1');

		assert.strictEqual(seen.undone, 1, 'the entry that named the unactivated release was taken back');
		assert.strictEqual(await readLive(root, 'web'), 'LIVE v1\n');
		assert.strictEqual(
			existsSync(path.join(deploymentDir(root, 'a1'), '.activation.json')),
			false,
			'and the artifact is dormant again'
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	it('returns the artifact to dormant even when the config undo fails, because an existing component cannot roll forward', async function () {
		this.timeout(30000);
		if (!(await readOnlyDirectoryDeniesWrites())) return this.skip();
		const root = await newRoot('compensate-config-undo-fails');
		await writeLive(root, 'web', 'LIVE v1\n');
		await stage(root, 'web', 'a1', 'STAGED v2\n', {
			describeArtifact: () => ({ rootConfig: { package: 'npm:web@2', isolated: false }, isolated: false }),
		});

		// Compensation has already put the live tree back and taken its rollback record with it, so the next
		// settle reads live-plus-candidate-with-no-record: for a staged artifact that means dormant, never a
		// roll forward. Holding the journal for a roll-forward that cannot happen only defers the same
		// verdict to the next start and leaves the artifact unusable until then.
		const seen = await failAfterConfigPublish(root, 'web', 'a1', async () => {
			throw new Error('config undo failed');
		});

		// ASSERTED, not glossed: the entry this activation published is still standing while the previous
		// release is what is live. That divergence is the whole of #2315 step 3 — and it includes the
		// isolation the artifact recorded — so it is pinned here rather than left for a reader to infer from
		// trees and journals. Whoever closes step 3 should find this assertion inverted.
		assert.strictEqual(seen.undone, 1, 'the undo was attempted');
		assert.deepStrictEqual(
			seen.published[0],
			{ package: 'npm:web@2', isolated: false },
			'and its entry is the one config is left naming, though that release is not live'
		);
		assert.strictEqual(await readLive(root, 'web'), 'LIVE v1\n');
		assert.strictEqual(
			existsSync(path.join(deploymentDir(root, 'a1'), '.activation.json')),
			false,
			'the journal is retired rather than held for a roll forward recovery will not perform'
		);
		assert.ok(existsSync(path.join(deploymentDir(root, 'a1'), 'web')), 'and the certified build is still there');
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

describe('whether a failed activation still owns the root-config entry it published', () => {
	// The only guard on a hazard the preparation lock does not cover — it serializes deploys of one
	// component, not root-config writers — and both ways it can regress fail silently.
	it('refreshes before it reads, because a config write does not update this process in place', () => {
		const order = [];
		publishedEntryStillStands(
			{ package: 'npm:web@2' },
			() => order.push('refresh'),
			() => {
				order.push('read');
				return { package: 'npm:web@2' };
			}
		);

		assert.deepStrictEqual(
			order,
			['refresh', 'read'],
			'reading first compares against a value that predates the change this guard exists to protect'
		);
	});

	it('still stands when nothing else touched it, whatever order the keys come back in', () => {
		assert.strictEqual(
			publishedEntryStillStands(
				{ package: 'npm:web@2', isolated: false },
				() => {},
				() => ({ isolated: false, package: 'npm:web@2' })
			),
			true
		);
	});

	it('does not stand once something else has changed the entry, so the undo leaves it alone', () => {
		assert.strictEqual(
			publishedEntryStillStands(
				{ package: 'npm:web@2' },
				() => {},
				() => ({ package: 'npm:web@3' })
			),
			false,
			"a set_configuration acknowledged while the swap retried is not this activation's to overwrite"
		);
	});

	it('does not stand when the entry is gone entirely', () => {
		assert.strictEqual(
			publishedEntryStillStands(
				{ package: 'npm:web@2' },
				() => {},
				() => undefined
			),
			false
		);
	});
});

describe('which peers confirmed a stage', () => {
	// The only safety net for the mixed-version hazard #2315 records as accepted: a node running a build
	// that predates staged deploys treats `activate: false` as an ordinary deploy and serves the release.
	// It cannot be prevented, so a regression in detecting it fails silently.
	it("accepts the marker flat or wrapped, because the entry shape is the replicator's", () => {
		assert.deepStrictEqual(
			unconfirmedStagingPeers([
				{ node: 'a', staged: true },
				{ node: 'b', value: { staged: true } },
				{ node: 'c', body: { staged: true } },
			]),
			[],
			'a fully-upgraded cluster must not read as unconfirmed whichever shape the replicator returns'
		);
	});

	it('names every peer that did not confirm, whatever it did answer', () => {
		const unconfirmed = unconfirmedStagingPeers([
			{ node: 'upgraded', staged: true },
			{ node: 'old', message: 'Successfully deployed: web' },
			{ node: 'failed', status: 'failed', error: { message: 'boom' } },
			{ node: 'wrapped-false', value: { staged: false } },
		]);

		assert.deepStrictEqual(
			unconfirmed.map((peer) => peer.node),
			['old', 'failed', 'wrapped-false'],
			'an old peer, a failed one and an explicit false are all "did not confirm"'
		);
	});

	it('treats a missing or non-array aggregate as nothing to report', () => {
		for (const replicated of [undefined, null, {}, 'nope']) {
			assert.deepStrictEqual(unconfirmedStagingPeers(replicated), [], String(replicated));
		}
		assert.deepStrictEqual(unconfirmedStagingPeers([null, undefined]), [], 'holes are not peers');
	});
});
