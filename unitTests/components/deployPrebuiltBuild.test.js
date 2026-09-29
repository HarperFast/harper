'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const tar = require('tar-fs');
const tarStream = require('tar-stream');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	prepareApplication,
	recoverInterruptedActivations,
	deployedReleaseVerdict,
	installConfiguredApplication,
	DEPLOY_STAGING_DIR,
	Application,
} = require('#src/components/Application');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { inventoryBuild, packBuild } = require('#src/components/buildArtifact');
const { DEPLOYMENT_PROVENANCE_FILE } = require('#src/components/deploymentProvenance');
const { preserveRootConfig } = require('../rootConfigFixture.js');
const {
	recordUnconfirmedBuildPeers,
	assertBuildFitsOperationBody,
	publishesBuild,
	releaseUnreadPayload,
} = require('#src/components/operations');
const { deployComponentValidator } = require('#src/components/operationsValidation');
const { server } = require('#src/server/Server');
const configUtils = require('#src/config/configUtils');

const PACKAGE_V1 = { rootConfig: { package: 'npm:web@1' }, isolated: false };
const PAYLOAD = { rootConfig: null, isolated: false };

const temporaryDirectories = [];
async function temporaryDirectory(prefix) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(dir);
	return dir;
}
after(() => Promise.all(temporaryDirectories.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function newRoot(label) {
	return temporaryDirectory(`prebuilt-${label}-`);
}

async function writeTree(dir, files) {
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content);
	}
	return dir;
}

async function sourceArchive(files) {
	const dir = await writeTree(await temporaryDirectory('prebuilt-src-'), files);
	const chunks = [];
	await new Promise((resolve, reject) => {
		const gzip = zlib.createGzip();
		gzip.on('data', (chunk) => chunks.push(chunk));
		gzip.on('end', resolve);
		gzip.on('error', reject);
		tar.pack(dir).pipe(gzip);
	});
	return Buffer.concat(chunks);
}

async function originBuild(files) {
	const dir = await writeTree(await temporaryDirectory('prebuilt-origin-'), files);
	const chunks = [];
	for await (const chunk of packBuild(dir)) chunks.push(chunk);
	return { archive: Buffer.concat(chunks), manifest: await inventoryBuild(dir), dir };
}

// A package.json that asks for an install, and an install that would fail if anything ran it.
const WOULD_INSTALL = {
	'package.json': JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
	'node_modules/left-pad/index.js': 'module.exports = 1;',
	'index.js': 'V1\n',
};
const FAILING_INSTALL = { command: 'node -e process.exit(1)' };

function applicationAt(root, name, options = {}) {
	const app = new Application({ name, ...options });
	app.dirPath = path.join(root, name);
	return app;
}

function deploymentDir(root, id) {
	return path.join(root, DEPLOY_STAGING_DIR, id);
}

async function descriptorOf(root, id) {
	return JSON.parse(await fs.readFile(path.join(deploymentDir(root, id), '.artifact.json'), 'utf8'));
}

const certifiedTreeOf = async (root, id) => fs.readFile(path.join(deploymentDir(root, id), '.certified'), 'utf8');

async function receive(root, id, build, options = {}) {
	const app = applicationAt(root, 'web', { payload: build.archive, install: FAILING_INSTALL });
	await prepareApplication(app, {
		artifactId: id,
		describeArtifact: () => PAYLOAD,
		prebuilt: { manifest: build.manifest, installationIsOpaque: false },
		...options,
	});
	return app;
}

async function deploy(root, id, files, options = {}) {
	const app = applicationAt(root, 'web', { payload: await sourceArchive(files) });
	await prepareApplication(app, { artifactId: id, describeArtifact: () => PAYLOAD, ...options });
	return app;
}

async function activate(root, id, options = {}) {
	const app = applicationAt(root, 'web');
	await prepareApplication(app, { mode: 'activate', artifactId: id, ...options });
	return app;
}

const readLive = (root) => fs.readFile(path.join(root, 'web', 'index.js'), 'utf8');

describe('replicated builds', () => {
	preserveRootConfig();

	describe('a node taking another node’s build', () => {
		it('installs nothing, and holds exactly the tree the origin built', async function () {
			this.timeout(30000);
			const root = await newRoot('take');
			const build = await originBuild(WOULD_INSTALL);

			const app = await receive(root, 'd1', build);

			assert.strictEqual(await readLive(root), 'V1\n', 'live, although the install command would have failed');
			assert.strictEqual((await inventoryBuild(path.join(root, 'web'))).tree, build.manifest.tree);
			assert.strictEqual(app.admittedTree, build.manifest.tree);
			const descriptor = await descriptorOf(root, 'd1');
			assert.deepStrictEqual(descriptor.build, build.manifest, 'recorded with the origin’s manifest');
			assert.strictEqual(await certifiedTreeOf(root, 'd1'), build.manifest.tree);
			const marker = JSON.parse(await fs.readFile(path.join(root, 'web', DEPLOYMENT_PROVENANCE_FILE), 'utf8'));
			assert.deepStrictEqual(marker, { v: 1, component: 'web', deploymentId: 'd1', described: true });
		});

		it('refuses a tree that is not the one the origin built, leaving the live release and no candidate', async function () {
			this.timeout(30000);
			const root = await newRoot('mismatch');
			await deploy(root, 'd0', { 'index.js': 'LIVE\n' });
			const build = await originBuild(WOULD_INSTALL);
			const forged = { ...build, manifest: { ...build.manifest, tree: 'f'.repeat(64) } };

			await assert.rejects(
				() => receive(root, 'd1', forged),
				(error) => error.statusCode === 409 && /is not the tree its origin built/.test(error.message)
			);
			assert.strictEqual(await readLive(root), 'LIVE\n');
			assert.strictEqual(existsSync(deploymentDir(root, 'd1')), false, 'the candidate is discarded');
		});

		it('never writes through a link the archive planted, whatever the link rule allows', async function () {
			if (process.platform === 'win32') return this.skip(); // links are not extracted there at all
			this.timeout(30000);
			const root = await newRoot('write-through');
			const outside = await temporaryDirectory('prebuilt-outside-');
			const pack = tarStream.pack();
			pack.entry({ name: 'escape', type: 'symlink', linkname: outside });
			pack.entry({ name: 'escape/planted.txt' }, 'written through the link');
			pack.finalize();
			const chunks = [];
			for await (const chunk of pack.pipe(zlib.createGzip())) chunks.push(chunk);
			const archive = Buffer.concat(chunks);
			const manifest = { tree: 'a'.repeat(64), platform: { os: 'x', arch: 'x', libc: null, abi: 'x', binds: {} } };

			await assert.rejects(() => receive(root, 'd1', { archive, manifest }), /is not a valid path/);
			assert.deepStrictEqual(await fs.readdir(outside), [], 'nothing landed outside the candidate');
			assert.strictEqual(existsSync(deploymentDir(root, 'd1')), false, 'and the candidate is discarded');
		});

		it('refuses a build that links outside itself, whatever manifest came with it', async function () {
			if (process.platform === 'win32') return this.skip(); // links are not extracted there at all
			this.timeout(30000);
			const root = await newRoot('receive-escape');
			const dir = await writeTree(await temporaryDirectory('prebuilt-escape-'), { 'index.js': 'V1\n' });
			await fs.symlink('../../../outside', path.join(dir, 'escape'));
			const chunks = [];
			for await (const chunk of packBuild(dir)) chunks.push(chunk);
			const build = { archive: Buffer.concat(chunks), manifest: await inventoryBuild(dir) };

			await assert.rejects(
				() => receive(root, 'd1', build),
				(error) => error.statusCode === 400 && /Cannot receive web: .* links outside the build/.test(error.message)
			);
			assert.strictEqual(existsSync(path.join(root, 'web')), false, 'nothing went live');
			assert.strictEqual(existsSync(deploymentDir(root, 'd1')), false, 'and the candidate is discarded');
		});

		it('keeps the tree its own load wrote into as what it certified', async function () {
			this.timeout(30000);
			const root = await newRoot('load-writes');
			const build = await originBuild(WOULD_INSTALL);

			await receive(root, 's1', build, {
				mode: 'stage',
				validateCandidate: async (candidateDirPath) => {
					await fs.writeFile(path.join(candidateDirPath, 'generated.js'), 'written by a plugin at load');
					return true;
				},
			});

			const descriptor = await descriptorOf(root, 's1');
			assert.strictEqual(descriptor.build.tree, build.manifest.tree, 'identity is still the origin’s');
			assert.notStrictEqual(
				await certifiedTreeOf(root, 's1'),
				build.manifest.tree,
				'but this node certified what it holds'
			);
			await activate(root, 's1', { expectedTree: build.manifest.tree });
			assert.strictEqual(await readLive(root), 'V1\n', 'which a delayed activation then finds unchanged');
		});
	});

	describe('an origin publishing its build', () => {
		it('hands over the certified candidate before it is described or live, and nothing goes live when that fails', async function () {
			this.timeout(30000);
			const root = await newRoot('publish');
			await deploy(root, 'd0', { 'index.js': 'LIVE\n' });
			let seen;
			await deploy(
				root,
				'd1',
				{ 'index.js': 'V1\n' },
				{
					publishBuild: async (candidateDirPath, build) => {
						seen = {
							candidate: candidateDirPath,
							tree: build.manifest.tree,
							live: await readLive(root),
							described: existsSync(path.join(deploymentDir(root, 'd1'), '.artifact.json')),
						};
					},
				}
			);
			assert.strictEqual(seen.live, 'LIVE\n', 'still the previous release while publishing');
			assert.strictEqual(seen.described, false, 'and not yet described');
			assert.strictEqual(seen.tree, (await descriptorOf(root, 'd1')).build.tree);

			await assert.rejects(
				() =>
					deploy(
						root,
						'd2',
						{ 'index.js': 'V2\n' },
						{
							publishBuild: async () => {
								throw new Error('the row could not take it');
							},
						}
					),
				/the row could not take it/
			);
			assert.strictEqual(await readLive(root), 'V1\n');
			assert.strictEqual(existsSync(deploymentDir(root, 'd2')), false);
		});

		it('refuses a file: directory source, which it could not hand over', async function () {
			if (process.platform === 'win32') return this.skip(); // packed rather than linked there
			this.timeout(30000);
			const root = await newRoot('publish-link');
			const source = await writeTree(await temporaryDirectory('prebuilt-linked-'), {
				'package.json': '{"name":"web","version":"1.0.0"}',
				'index.js': 'LINKED\n',
			});
			const app = applicationAt(root, 'web', { packageIdentifier: `file:${source}` });
			await assert.rejects(
				() =>
					prepareApplication(app, {
						artifactId: 'd1',
						describeArtifact: () => PACKAGE_V1,
						publishBuild: async () => {},
					}),
				(error) => error.statusCode === 400 && /Cannot replicate web .*replicated: false/.test(error.message)
			);
		});

		it('refuses a tree that links outside itself', async function () {
			if (process.platform === 'win32') return this.skip();
			this.timeout(30000);
			const root = await newRoot('publish-escape');
			const outside = await temporaryDirectory('prebuilt-outside-');
			// Extraction already refuses such a link in a payload; an install is what can still make one.
			const app = applicationAt(root, 'web', {
				payload: await sourceArchive({ 'package.json': '{"name":"web","version":"1.0.0"}', 'index.js': 'V1\n' }),
				install: { command: `ln -s ${outside} escape` },
			});
			await assert.rejects(
				() =>
					prepareApplication(app, { artifactId: 'd1', describeArtifact: () => PAYLOAD, publishBuild: async () => {} }),
				(error) => error.statusCode === 400 && /Cannot replicate web: .* links outside the build/.test(error.message)
			);
			assert.strictEqual(existsSync(path.join(root, 'web')), false, 'nothing went live');
		});
	});

	describe('a delayed activation', () => {
		it('refuses a staged tree that changed since it was certified, leaving the live release', async function () {
			this.timeout(30000);
			const root = await newRoot('tampered');
			await deploy(root, 'd0', { 'index.js': 'LIVE\n' });
			await deploy(root, 's1', { 'index.js': 'STAGED\n' }, { mode: 'stage' });
			await fs.writeFile(path.join(deploymentDir(root, 's1'), 'web', 'index.js'), 'EDITED WHILE DORMANT\n');

			await assert.rejects(
				() => activate(root, 's1'),
				(error) => error.statusCode === 409 && /no longer the one this node certified/.test(error.message)
			);
			assert.strictEqual(await readLive(root), 'LIVE\n');
		});

		it('lets a retry through after its own load check wrote into the tree and then failed', async function () {
			this.timeout(30000);
			const root = await newRoot('load-then-fail');
			await deploy(root, 'd0', { 'index.js': 'LIVE\n' });
			await deploy(root, 's1', { 'index.js': 'STAGED\n' }, { mode: 'stage' });
			await assert.rejects(
				() =>
					activate(root, 's1', {
						validateCandidate: async (candidateDirPath) => {
							await fs.writeFile(path.join(candidateDirPath, '.next-build'), 'written by a plugin at load');
							throw new Error('the component threw while loading');
						},
					}),
				/threw while loading/
			);
			assert.strictEqual(await readLive(root), 'LIVE\n');

			await activate(root, 's1');
			assert.strictEqual(await readLive(root), 'STAGED\n', 'the retry is not refused for what that load left');
		});

		it('does not re-verify a kept release, which may hold what it wrote while live', async function () {
			this.timeout(30000);
			const root = await newRoot('kept');
			await deploy(root, 'd1', { 'index.js': 'V1\n' });
			await fs.writeFile(path.join(root, 'web', 'cache.json'), 'written while serving');
			await deploy(root, 'd2', { 'index.js': 'V2\n' });

			await activate(root, 'd1');

			assert.strictEqual(await readLive(root), 'V1\n');
			assert.strictEqual(await fs.readFile(path.join(root, 'web', 'cache.json'), 'utf8'), 'written while serving');
		});

		it('refuses a build this node cannot run, naming why', async function () {
			this.timeout(30000);
			const root = await newRoot('platform');
			await deploy(root, 'd0', { 'index.js': 'LIVE\n' });
			await deploy(root, 's1', { 'index.js': 'STAGED\n' }, { mode: 'stage' });
			const descriptorPath = path.join(deploymentDir(root, 's1'), '.artifact.json');
			const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
			descriptor.build.platform.arch = `not-${process.arch}`;
			descriptor.build.platform.binds.arch = 'node_modules/@esbuild/other/package.json';
			await fs.writeFile(descriptorPath, JSON.stringify(descriptor));

			await assert.rejects(
				() => activate(root, 's1'),
				(error) =>
					error.statusCode === 409 &&
					new RegExp(`CPU architecture not-${process.arch} .*, and this node has ${process.arch}`).test(error.message)
			);
			assert.strictEqual(await readLive(root), 'LIVE\n');
		});

		it('refuses a build other than the one the requesting node holds', async function () {
			this.timeout(30000);
			const root = await newRoot('expected');
			await deploy(root, 's1', { 'index.js': 'STAGED\n' }, { mode: 'stage' });
			await assert.rejects(
				() => activate(root, 's1', { expectedTree: 'f'.repeat(64) }),
				(error) => error.statusCode === 409 && /is not the one the requesting node holds/.test(error.message)
			);
			const app = await activate(root, 's1', { expectedTree: (await descriptorOf(root, 's1')).build.tree });
			assert.strictEqual(app.admittedTree, (await descriptorOf(root, 's1')).build.tree);
		});

		it('admits an artifact staged before builds recorded a manifest, with nothing to check', async function () {
			this.timeout(30000);
			const root = await newRoot('v1');
			await deploy(root, 's1', { 'index.js': 'STAGED\n' }, { mode: 'stage' });
			await fs.writeFile(path.join(deploymentDir(root, 's1'), 'web', 'index.js'), 'EDITED\n');
			const descriptorPath = path.join(deploymentDir(root, 's1'), '.artifact.json');
			const legacy = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
			delete legacy.build;
			delete legacy.certifiedTree;
			await fs.writeFile(descriptorPath, JSON.stringify({ ...legacy, v: 1 }));

			const app = await activate(root, 's1');
			assert.strictEqual(await readLive(root), 'EDITED\n');
			assert.strictEqual(app.admittedTree, undefined);
		});
	});

	describe('boot deciding whether to reinstall', () => {
		const config = (overrides = {}) => ({ package: 'npm:web@1', ...overrides });

		async function deployedPackage(label, rootConfig = PACKAGE_V1.rootConfig) {
			const root = await newRoot(label);
			await deploy(root, 'd1', { 'index.js': 'V1\n' }, { describeArtifact: () => ({ rootConfig, isolated: false }) });
			return root;
		}

		it('keeps a deployed release built from the configured package and install, whatever else the entry says', async function () {
			this.timeout(30000);
			const root = await deployedPackage('keep');
			const dir = path.join(root, 'web');
			assert.strictEqual(await deployedReleaseVerdict(dir, 'web', config()), 'keep');
			assert.strictEqual(await deployedReleaseVerdict(dir, 'web', config({ urlPath: '/x', isolated: true })), 'keep');
			assert.strictEqual(await deployedReleaseVerdict(dir, 'web', config({ package: 'npm:web@2' })), 'reinstall');
			assert.strictEqual(
				await deployedReleaseVerdict(dir, 'web', config({ install: { command: 'npm ci' } })),
				'reinstall'
			);
		});

		it('keeps a release whose record lost its descriptor, through recovery, instead of rebuilding it', async function () {
			this.timeout(30000);
			const root = await deployedPackage('damaged');
			await fs.rm(path.join(deploymentDir(root, 'd1'), '.artifact.json'));
			await recoverInterruptedActivations(root);
			assert.strictEqual(await deployedReleaseVerdict(path.join(root, 'web'), 'web', config()), 'keep');

			await fs.rm(deploymentDir(root, 'd1'), { recursive: true, force: true });
			assert.strictEqual(
				await deployedReleaseVerdict(path.join(root, 'web'), 'web', config()),
				'keep',
				'or its whole record'
			);
		});

		it('keeps a release whose provenance cannot be read, rather than treating it as absent', async function () {
			if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip(); // chmod does not deny either
			this.timeout(30000);
			const root = await deployedPackage('marker-unreadable');
			const marker = path.join(root, 'web', DEPLOYMENT_PROVENANCE_FILE);
			await fs.chmod(marker, 0o000);
			try {
				assert.strictEqual(await deployedReleaseVerdict(path.join(root, 'web'), 'web', config()), 'keep');
			} finally {
				await fs.chmod(marker, 0o600);
			}
		});

		it('decides again under the preparation lock, so a deploy that lands meanwhile is not rebuilt over', async function () {
			this.timeout(30000);
			const root = await newRoot('boot-race');
			const dirPath = path.join(root, 'web');
			const lockPath = path.join(root, 'harper-application-lock.json');
			// A package boot could never install, so reaching the build at all fails the test.
			const entry = { package: `file:${path.join(root, 'no-such-package.tgz')}` };
			// Boot builds its own Application, at the configured components root.
			const priorComponentsRoot = env.get(CONFIG_PARAMS.COMPONENTSROOT);
			env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, root);
			try {
				let releaseDeploy;
				const deployHolding = new Promise((resolve) => (releaseDeploy = resolve));
				let deployHasLock;
				const lockHeld = new Promise((resolve) => (deployHasLock = resolve));
				const deploying = deploy(
					root,
					'd1',
					{ 'index.js': 'DEPLOYED\n' },
					{
						describeArtifact: () => ({ rootConfig: entry, isolated: false }),
						beforePrepare: async () => {
							deployHasLock();
							await deployHolding;
						},
					}
				);
				await lockHeld;
				// Boot looks while the deploy holds the lock: no tree yet, so it sets out to install.
				const booting = installConfiguredApplication('web', entry, dirPath, lockPath, () => {});
				releaseDeploy();
				await deploying;
				await booting;
				assert.strictEqual(await readLive(root), 'DEPLOYED\n', 'the deploy’s release is what runs');
			} finally {
				env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, priorComponentsRoot);
			}
		});

		it('keeps a release whose descriptor is unreadable', async function () {
			this.timeout(30000);
			const root = await deployedPackage('unreadable');
			await fs.writeFile(path.join(deploymentDir(root, 'd1'), '.artifact.json'), '{"v":2,');
			assert.strictEqual(await deployedReleaseVerdict(path.join(root, 'web'), 'web', config()), 'keep');
		});

		it('reinstalls a payload build under an entry that now names a package', async function () {
			this.timeout(30000);
			const root = await deployedPackage('payload', null);
			assert.strictEqual(await deployedReleaseVerdict(path.join(root, 'web'), 'web', config()), 'reinstall');
		});

		it('leaves a tree nothing described to the install lock', async function () {
			this.timeout(30000);
			const root = await newRoot('undescribed');
			const app = applicationAt(root, 'web', { payload: await sourceArchive({ 'index.js': 'BOOT\n' }) });
			await prepareApplication(app, { artifactId: 'boot-token' });
			assert.strictEqual(await deployedReleaseVerdict(path.join(root, 'web'), 'web', config()), 'unknown');
			await fs.rm(path.join(root, 'web', DEPLOYMENT_PROVENANCE_FILE));
			assert.strictEqual(await deployedReleaseVerdict(path.join(root, 'web'), 'web', config()), 'unknown');
		});

		it('keeps a release this node can no longer run rather than rebuilding it', async function () {
			this.timeout(30000);
			const root = await deployedPackage('platform');
			const descriptorPath = path.join(deploymentDir(root, 'd1'), '.artifact.json');
			const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
			descriptor.build.platform.abi = 'other';
			descriptor.build.platform.binds.abi = 'addon.node';
			await fs.writeFile(descriptorPath, JSON.stringify(descriptor));
			assert.strictEqual(await deployedReleaseVerdict(path.join(root, 'web'), 'web', config()), 'keep');
		});
	});

	describe('the origin checking what its peers admitted', () => {
		const TREE = 'a'.repeat(64);
		function recorder(failed = []) {
			return {
				recorded: [],
				getFailedPeers: () => failed.map((node) => ({ node, status: 'failed' })),
				recordPeer(result) {
					this.recorded.push(result);
				},
			};
		}

		it('records a peer that did not name the published tree as failed, and nothing for one that did', () => {
			const rec = recorder();
			recordUnconfirmedBuildPeers(
				rec,
				[
					{ node: 'confirms', artifact: TREE },
					{ node: 'confirms-in-value', value: { artifact: TREE } },
					{ node: 'older', message: 'Successfully deployed: web' },
					{ node: 'different', artifact: 'b'.repeat(64) },
				],
				TREE,
				'deploy'
			);
			assert.deepStrictEqual(
				rec.recorded.map((result) => result.node),
				['older', 'different']
			);
			assert.match(rec.recorded[0].error, /deployed the release without confirming it holds this node's build/);
			assert.match(rec.recorded[1].error, /deployed a different build \(tree b{64}\)/);
			assert.ok(rec.recorded.every((result) => result.status === 'failed'));
		});

		it('leaves a peer that already failed, and one that did not confirm staging, to their own messages', () => {
			const rec = recorder(['broken']);
			recordUnconfirmedBuildPeers(
				rec,
				[
					{ node: 'broken', status: 'failed', reason: 'socket closed' },
					{ node: 'pre-staging', message: 'Successfully deployed: web' },
					{ node: 'staged-by-itself', staged: true },
					null,
				],
				TREE,
				'stage'
			);
			assert.deepStrictEqual(
				rec.recorded.map((result) => result.node),
				['staged-by-itself']
			);
			assert.match(rec.recorded[0].error, /^staged the release without confirming/);
			recordUnconfirmedBuildPeers(rec, undefined, TREE, 'deploy');
			assert.strictEqual(rec.recorded.length, 1, 'no aggregate, nothing to check');
		});
	});

	describe('a build carried in the operation itself', () => {
		let priorNodes;
		beforeEach(() => {
			priorNodes = server.nodes;
			server.nodes = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
		});
		afterEach(() => {
			server.nodes = priorNodes;
		});

		it('is packed only for an operation that will reach another node', () => {
			const recorder = {};
			assert.strictEqual(publishesBuild({}, recorder, false), true);
			assert.strictEqual(publishesBuild({ replicated: true }, recorder, false), true);
			assert.strictEqual(publishesBuild({ replicated: false }, recorder, false), false, 'explicitly local');
			assert.strictEqual(publishesBuild({}, undefined, false), false, 'a peer, which records nothing');
			assert.strictEqual(publishesBuild({}, recorder, true), false, 'an activation, which builds nothing');
			server.nodes = [];
			assert.strictEqual(publishesBuild({}, recorder, false), false, 'no other node');
			server.nodes = undefined;
			assert.strictEqual(publishesBuild({}, recorder, false), false, 'core, which has no peers');
		});

		it('is refused when its copies for every peer pass the replication message bound', () => {
			const bound = Number(configUtils.getConfigValue('replication_maxPayload')) || 100_000_000;
			assert.doesNotThrow(() => assertBuildFitsOperationBody('web', Math.floor(bound / 3)));
			assert.throws(
				() => assertBuildFitsOperationBody('web', Math.floor(bound / 3) + 1),
				(error) =>
					error.statusCode === 409 &&
					/each of 3 node\(s\).*replication_maxPayload/.test(error.message) &&
					/Replicate the system database/.test(error.message)
			);
		});
	});

	describe('a deploy that ends before reading what it opened', () => {
		it('releases the build it was verifying, down to the stored blob it came from', async () => {
			const { Readable, pipeline } = require('node:stream');
			const { verifiedArchive } = require('#src/components/buildArtifact');
			const blobRead = new Readable({ read() {} });
			const verifying = pipeline(blobRead, verifiedArchive({ sha256: 'a'.repeat(64), size: 1 }), () => {});
			releaseUnreadPayload(verifying);
			await new Promise((resolve) => setImmediate(resolve));
			assert.ok(blobRead.destroyed, 'the blob read is closed');
		});

		it('cancels a blob stream nothing took, and leaves one that is being read', async () => {
			let cancelled = 0;
			const stream = () => new ReadableStream({ cancel: () => void cancelled++ });
			releaseUnreadPayload(stream());
			const reading = stream();
			reading.getReader();
			releaseUnreadPayload(reading);
			releaseUnreadPayload(undefined);
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(cancelled, 1);
		});
	});

	describe('validating what a peer is told to take', () => {
		const base = {
			operation: 'deploy_component',
			project: 'web',
			_deploymentId: '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12),
		};

		it('admits the origin’s descriptor and refuses a malformed one', () => {
			const artifact = {
				sha256: 'a'.repeat(64),
				size: 10,
				installationIsOpaque: false,
				build: { tree: 'b'.repeat(64) },
			};
			assert.strictEqual(deployComponentValidator({ ...base, _artifact: artifact }), undefined);
			assert.strictEqual(deployComponentValidator({ ...base, _artifact: { tree: 'b'.repeat(64) } }), undefined);
			for (const broken of [
				{ ...artifact, sha256: 'not-a-digest' },
				{ ...artifact, size: -1 },
				{ ...artifact, installationIsOpaque: 'false' },
				{ ...artifact, build: 'x' },
				{ tree: 'short' },
			]) {
				assert.ok(deployComponentValidator({ ...base, _artifact: broken }), JSON.stringify(broken));
			}
		});
	});
});
