'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const tar = require('tar-fs');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	prepareApplication,
	recoverInterruptedActivations,
	unsettleableComponentsFromDisk,
	dropComponentDirectory,
	DEPLOY_STAGING_DIR,
	ASIDE_STAGING_DIR,
	Application,
} = require('#src/components/Application');
const { DEPLOYMENT_PROVENANCE_FILE } = require('#src/components/deploymentProvenance');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { preserveRootConfig, rootConfigEntry } = require('../rootConfigFixture.js');

const PACKAGE_V1 = { rootConfig: { package: 'npm:web@1' }, isolated: false };

async function newRoot(label) {
	return fs.mkdtemp(path.join(os.tmpdir(), `keep-displaced-${label}-`));
}

/** A tarball packed directly, so it can carry files the component packer leaves out. */
async function makeTarball(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keep-displaced-src-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content);
	}
	const chunks = [];
	await new Promise((resolve, reject) => {
		const gzip = zlib.createGzip();
		gzip.on('data', (chunk) => chunks.push(chunk));
		gzip.on('end', resolve);
		gzip.on('error', reject);
		tar.pack(dir).pipe(gzip);
	});
	await fs.rm(dir, { recursive: true, force: true });
	return Buffer.concat(chunks);
}

function release(marker, extra = {}) {
	return { 'package.json': '{"name":"web","version":"1.0.0"}\n', 'index.js': marker, ...extra };
}

function applicationAt(root, name, payload) {
	const app = new Application({ name, payload });
	app.dirPath = path.join(root, name);
	return app;
}

async function deploy(root, id, marker, options = {}) {
	const app = applicationAt(root, 'web', await makeTarball(release(marker)));
	await prepareApplication(app, {
		artifactId: id,
		describeArtifact: () => ({ rootConfig: null, isolated: false }),
		...options,
	});
	return app;
}

async function stage(root, id, marker, options = {}) {
	const app = applicationAt(root, 'web', await makeTarball(release(marker)));
	await prepareApplication(app, { mode: 'stage', artifactId: id, ...options });
	return app;
}

async function activate(root, id) {
	const app = applicationAt(root, 'web');
	await prepareApplication(app, { mode: 'activate', artifactId: id });
	return app;
}

function deploymentDir(root, id) {
	return path.join(root, DEPLOY_STAGING_DIR, id);
}

function claimDirFor(root, component) {
	const digest = createHash('sha256').update(component).digest('hex').slice(0, 16);
	return path.join(root, DEPLOY_STAGING_DIR, `.claiming-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}-${digest}`);
}

async function readLive(root) {
	return fs.readFile(path.join(root, 'web', 'index.js'), 'utf8');
}

async function provenanceOf(treePath) {
	return JSON.parse(await fs.readFile(path.join(treePath, DEPLOYMENT_PROVENANCE_FILE), 'utf8'));
}

async function entriesOf(dirPath) {
	return (await fs.readdir(dirPath).catch(() => [])).sort();
}

const RECORD = ['.artifact.json', '.certified', '.complete', '.component'];
const KEPT = [...RECORD, '.displaced', 'web'];

function setMaxCount(value) {
	env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, value);
}

/** Whether a read-only directory actually denies this process a write; root and Windows would pass with nothing tested. */
async function readOnlyDirectoryDeniesWrites() {
	const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'keep-displaced-probe-'));
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
}

describe('keeping the release an activation displaces', () => {
	preserveRootConfig();
	afterEach(() => setMaxCount(undefined));

	describe('the provenance marker', () => {
		it('records the component and the deployment that built the tree, replacing one its payload carried', async function () {
			this.timeout(20000);
			const root = await newRoot('marker');
			const stale = JSON.stringify({ v: 1, component: 'web', deploymentId: 'from-elsewhere' });
			const app = applicationAt(
				root,
				'web',
				await makeTarball(release('V1\n', { [DEPLOYMENT_PROVENANCE_FILE]: stale }))
			);

			await prepareApplication(app, { artifactId: 'd1' });

			assert.deepStrictEqual(await provenanceOf(path.join(root, 'web')), {
				v: 1,
				component: 'web',
				deploymentId: 'd1',
			});
			await fs.rm(root, { recursive: true, force: true });
		});

		it('writes nothing through a file: link, whose target is not the deploy’s own', async function () {
			if (process.platform === 'win32') return this.skip(); // packed rather than linked there
			this.timeout(20000);
			const root = await newRoot('marker-link');
			const source = await fs.mkdtemp(path.join(os.tmpdir(), 'keep-displaced-linked-'));
			await fs.writeFile(path.join(source, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
			await fs.writeFile(path.join(source, 'index.js'), 'LINKED\n');
			const app = new Application({ name: 'web', packageIdentifier: `file:${source}` });
			app.dirPath = path.join(root, 'web');

			await prepareApplication(app, { artifactId: 'd1', describeArtifact: () => PACKAGE_V1 });

			assert.ok((await fs.lstat(path.join(root, 'web'))).isSymbolicLink(), 'the live path is the link');
			assert.strictEqual(existsSync(path.join(source, DEPLOYMENT_PROVENANCE_FILE)), false);
			assert.strictEqual(existsSync(deploymentDir(root, 'd1')), false, 'and a link keeps no record to return to');
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(source, { recursive: true, force: true });
		});
	});

	describe('the record of a deployment', () => {
		it('outlives the swap for a deploy that declared what it publishes', async function () {
			this.timeout(20000);
			const root = await newRoot('record');

			await deploy(root, 'd1', 'V1\n', { describeArtifact: () => PACKAGE_V1 });

			assert.strictEqual(await readLive(root), 'V1\n');
			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd1')), RECORD, 'everything but the tree');
			const descriptor = JSON.parse(await fs.readFile(path.join(deploymentDir(root, 'd1'), '.artifact.json'), 'utf8'));
			assert.deepStrictEqual(descriptor.rootConfig, PACKAGE_V1.rootConfig);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('is not kept for a preparation that declares nothing, which is how a boot install runs', async function () {
			this.timeout(20000);
			const root = await newRoot('record-keep');
			const app = applicationAt(root, 'web', await makeTarball(release('BOOT\n')));

			await prepareApplication(app, { artifactId: 'b1' });

			assert.strictEqual(await readLive(root), 'BOOT\n');
			assert.strictEqual(existsSync(deploymentDir(root, 'b1')), false);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('goes, with every release kept for it, when the component is dropped', async function () {
			this.timeout(30000);
			const root = await newRoot('record-drop');
			await deploy(root, 'd1', 'V1\n');
			await deploy(root, 'd2', 'V2\n');
			await fs.mkdir(claimDirFor(root, 'web'));

			await dropComponentDirectory(path.join(root, 'web'), 'web');

			assert.deepStrictEqual(await entriesOf(path.join(root, DEPLOY_STAGING_DIR)), []);
			await fs.rm(root, { recursive: true, force: true });
		});
	});

	describe('activating the release that is already live', () => {
		it('answers without a swap', async function () {
			this.timeout(20000);
			const root = await newRoot('already-live');
			await deploy(root, 'd1', 'V1\n');
			// Written after the swap: a second swap of anything would replace the tree and lose it.
			await fs.writeFile(path.join(root, 'web', 'written-while-live.txt'), 'still here');

			const retry = await activate(root, 'd1');

			assert.strictEqual(retry.alreadyActive, true);
			assert.strictEqual(retry.packageMetadataChanged, true, 'a restart is requested, since nothing can tell');
			assert.strictEqual(await fs.readFile(path.join(root, 'web', 'written-while-live.txt'), 'utf8'), 'still here');
			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd1')), RECORD);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('answers 404 for a record whose release is no longer on the node', async function () {
			this.timeout(20000);
			const root = await newRoot('stale-record');
			await deploy(root, 'd1', 'V1\n');
			// What a release leaves when something that is not an activation replaced its tree.
			await fs.rm(path.join(root, 'web', DEPLOYMENT_PROVENANCE_FILE));

			await assert.rejects(
				() => activate(root, 'd1'),
				(error) => /no longer on this node/.test(error.message) && error.statusCode === 404
			);
			assert.strictEqual(await readLive(root), 'V1\n');
			await fs.rm(root, { recursive: true, force: true });
		});
	});

	describe('the displaced tree', () => {
		it('goes back under the id that built it, and activating that id puts it back with its own configuration', async function () {
			this.timeout(30000);
			const root = await newRoot('revert');
			await deploy(root, 'd1', 'V1\n', { describeArtifact: () => PACKAGE_V1 });
			assert.deepStrictEqual(rootConfigEntry('web'), PACKAGE_V1.rootConfig);

			await deploy(root, 'd2', 'V2\n');

			assert.strictEqual(await readLive(root), 'V2\n');
			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd1')), KEPT, 'V1 is dormant under d1');
			assert.strictEqual(await fs.readFile(path.join(deploymentDir(root, 'd1'), 'web', 'index.js'), 'utf8'), 'V1\n');
			assert.strictEqual(existsSync(path.join(root, ASIDE_STAGING_DIR, 'web')), false, 'and nothing is left aside');
			assert.strictEqual(rootConfigEntry('web'), undefined, 'the payload release owns no registry provenance');

			await activate(root, 'd1');

			assert.strictEqual(await readLive(root), 'V1\n');
			assert.deepStrictEqual(rootConfigEntry('web'), PACKAGE_V1.rootConfig, 'what d1 declared, published again');
			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd2')), KEPT, 'and V2 took its place');
			assert.deepStrictEqual(
				await entriesOf(deploymentDir(root, 'd1')),
				[...RECORD, '.displaced'],
				'a record whose release was kept stays marked as once live'
			);

			await activate(root, 'd2');

			assert.strictEqual(await readLive(root), 'V2\n');
			assert.strictEqual(rootConfigEntry('web'), undefined);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('is swept when retention keeps none, and its record goes with it', async function () {
			this.timeout(30000);
			const root = await newRoot('keep-none');
			setMaxCount(0);
			await deploy(root, 'd1', 'V1\n');

			await deploy(root, 'd2', 'V2\n');

			assert.deepStrictEqual(await entriesOf(path.join(root, DEPLOY_STAGING_DIR)), ['d2']);
			assert.strictEqual(existsSync(path.join(root, ASIDE_STAGING_DIR, 'web')), false);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('is swept when it records no deployment, as a tree made live before this change does', async function () {
			this.timeout(20000);
			const root = await newRoot('unmarked');
			await fs.mkdir(path.join(root, 'web'), { recursive: true });
			await fs.writeFile(path.join(root, 'web', 'index.js'), 'OLD\n');

			await deploy(root, 'd1', 'V1\n');

			assert.deepStrictEqual(await entriesOf(path.join(root, DEPLOY_STAGING_DIR)), ['d1']);
			assert.strictEqual(existsSync(path.join(root, ASIDE_STAGING_DIR, 'web')), false);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('is left in place when keeping it fails, and the next preparation keeps it', async function () {
			this.timeout(40000);
			if (process.platform === 'win32' || !(await readOnlyDirectoryDeniesWrites())) return this.skip();
			const root = await newRoot('keep-fails');
			await deploy(root, 'd1', 'V1\n');
			await fs.chmod(deploymentDir(root, 'd1'), 0o500);
			try {
				await deploy(root, 'd2', 'V2\n');
			} finally {
				await fs.chmod(deploymentDir(root, 'd1'), 0o700);
			}

			assert.strictEqual(await readLive(root), 'V2\n', 'the deploy itself succeeded');
			const aside = await entriesOf(path.join(root, ASIDE_STAGING_DIR, 'web'));
			assert.strictEqual(aside.length, 2, `a retired tree and its marker, not a sweep: ${aside}`);
			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd1')), RECORD, 'and its record is untouched');

			await stage(root, 's1', 'STAGED\n');

			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd1')), KEPT, 'kept by the next preparation');
			assert.strictEqual(await fs.readFile(path.join(deploymentDir(root, 'd1'), 'web', 'index.js'), 'utf8'), 'V1\n');
			assert.strictEqual(existsSync(path.join(root, ASIDE_STAGING_DIR, 'web')), false);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('is ordered by when it stopped being live, so retention keeps it over a stage built after it', async function () {
			this.timeout(30000);
			const root = await newRoot('ordered');
			setMaxCount(1);
			await deploy(root, 'd1', 'V1\n');
			await stage(root, 's1', 'STAGED LATER\n');

			await deploy(root, 'd2', 'V2\n');

			assert.deepStrictEqual(await entriesOf(path.join(root, DEPLOY_STAGING_DIR)), ['d1', 'd2']);
			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd1')), KEPT, 'the release a revert wants');
			await fs.rm(root, { recursive: true, force: true });
		});
	});

	describe('recovery', () => {
		/** d2 committed over d1, then died before putting d1's tree back. */
		async function crashAfterCommit(root) {
			await deploy(root, 'd1', 'V1\n');
			await stage(root, 'd2', 'V2\n');
			await fs.writeFile(
				path.join(deploymentDir(root, 'd2'), '.activation.json'),
				JSON.stringify({ v: 2, component: 'web', candidateId: 'd2', rootConfig: { kind: 'keep' } })
			);
			const asideDir = path.join(root, ASIDE_STAGING_DIR, 'web');
			await fs.mkdir(asideDir, { recursive: true });
			await fs.rename(path.join(root, 'web'), path.join(asideDir, '.in-progress-1-1-aaa'));
			await fs.rename(path.join(deploymentDir(root, 'd2'), 'web'), path.join(root, 'web'));
		}

		it('keeps the tree a crash after the commit left aside, whichever directory the scan reaches first', async function () {
			this.timeout(30000);
			const root = await newRoot('crash-after-commit');
			await crashAfterCommit(root);

			assert.strictEqual((await recoverInterruptedActivations(root)).size, 0);
			assert.strictEqual((await recoverInterruptedActivations(root)).size, 0, 'and again, idempotently');

			assert.strictEqual(await readLive(root), 'V2\n');
			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd1')), KEPT);
			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd2')), RECORD);
			assert.strictEqual(existsSync(path.join(root, ASIDE_STAGING_DIR, 'web')), false);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('leaves the record of a release whose tree is still aside, even with no journal left to put it back', async function () {
			// Deterministic, unlike the case above: with no journal nothing settles, so only the record's own
			// classification keeps it.
			this.timeout(30000);
			const root = await newRoot('record-aside');
			await crashAfterCommit(root);
			await fs.rm(path.join(deploymentDir(root, 'd2'), '.activation.json'));
			await fs.writeFile(path.join(root, ASIDE_STAGING_DIR, 'web', '.retired-1-1-aaa'), '');

			await recoverInterruptedActivations(root);

			assert.deepStrictEqual(
				await entriesOf(deploymentDir(root, 'd1')),
				RECORD,
				'd1 still has somewhere to go back to'
			);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('leaves the record of the live release, and removes one nothing refers to', async function () {
			this.timeout(30000);
			const root = await newRoot('stale');
			await deploy(root, 'd1', 'V1\n');
			const stale = deploymentDir(root, 'gone');
			await fs.mkdir(stale, { recursive: true });
			for (const [name, contents] of [
				['.component', 'web'],
				['.complete', ''],
				[
					'.artifact.json',
					JSON.stringify({ v: 1, component: 'web', rootConfig: null, installationIsOpaque: false, isolated: false }),
				],
			]) {
				await fs.writeFile(path.join(stale, name), contents);
			}

			assert.strictEqual((await recoverInterruptedActivations(root)).size, 0);

			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd1')), RECORD);
			assert.strictEqual(existsSync(stale), false);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('never evicts the artifact a request is activating while its preamble settles another deploy', async function () {
			// Settlement keeps the release a crashed deploy displaced; a prune there, blind to the request's pin, would
			// delete the artifact the request is activating.
			this.timeout(40000);
			const root = await newRoot('pin');
			setMaxCount(1);
			await stage(root, 'wanted', 'WANTED\n');
			await crashAfterCommit(root);

			await activate(root, 'wanted');

			assert.strictEqual(await readLive(root), 'WANTED\n');
			await fs.rm(root, { recursive: true, force: true });
		});

		it('keeps the release a settlement just put back, even when a stage outranks it', async function () {
			// A kept release's completion time is refreshed best-effort; a stage dated after the refresh stands in for a
			// refresh that failed.
			this.timeout(40000);
			const root = await newRoot('kept-pinned');
			setMaxCount(1);
			await stage(root, 's1', 'STAGED\n');
			await crashAfterCommit(root);
			const later = new Date(Date.now() + 3600_000);
			await fs.utimes(path.join(deploymentDir(root, 's1'), '.complete'), later, later);

			const retry = await activate(root, 'd2');

			assert.strictEqual(retry.alreadyActive, true);
			assert.deepStrictEqual(await entriesOf(deploymentDir(root, 'd1')), KEPT, 'the release just put back');
			await fs.rm(root, { recursive: true, force: true });
		});
	});

	describe('claims', () => {
		const claimOf = claimDirFor;

		it('removes a claim the component left unfinished at its next deploy, and leaves another component’s', async function () {
			this.timeout(20000);
			const root = await newRoot('claims');
			await fs.mkdir(claimOf(root, 'web'), { recursive: true });
			await fs.writeFile(path.join(claimOf(root, 'web'), '.component'), 'web');
			await fs.mkdir(claimOf(root, 'api'), { recursive: true });

			await deploy(root, 'd1', 'V1\n');

			assert.strictEqual(existsSync(claimOf(root, 'web')), false);
			assert.strictEqual(existsSync(claimOf(root, 'api')), true);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('is neither settled, failed nor removed by recovery, which cannot know whether it is still being built', async function () {
			this.timeout(20000);
			const root = await newRoot('claims-recovery');
			await fs.mkdir(claimOf(root, 'web'), { recursive: true });
			await fs.writeFile(path.join(claimOf(root, 'web'), '.component'), 'web');

			assert.strictEqual((await recoverInterruptedActivations(root)).size, 0);
			assert.strictEqual((await unsettleableComponentsFromDisk(root)).size, 0);

			assert.strictEqual(existsSync(path.join(claimOf(root, 'web'), '.component')), true);
			await fs.rm(root, { recursive: true, force: true });
		});

		it('claims an id for a component whose name leaves no room to spell it in the claim', async function () {
			this.timeout(20000);
			const root = await newRoot('claims-long-name');
			const name = 'w'.repeat(220);
			const app = new Application({ name, payload: await makeTarball(release('LONG\n')) });
			app.dirPath = path.join(root, name);

			await prepareApplication(app, { mode: 'stage', artifactId: 's1' });

			assert.strictEqual(await fs.readFile(path.join(deploymentDir(root, 's1'), '.component'), 'utf8'), name);
			await fs.rm(root, { recursive: true, force: true });
		});
	});
});
