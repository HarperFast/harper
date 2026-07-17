'use strict';

// Unit tests for the two-phase deploy primitives in components/Application.ts:
// stageApplication (build the incoming version into a hidden staging dir, never touching the live
// path), activateApplication (atomically swap the staged copy into the live path), and
// discardStagedApplication (drop an aborted stage). These exercise the real filesystem — no
// componentLoader, no network — so they run without the private agent dependency.

const assert = require('node:assert');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const tarfs = require('tar-fs');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	Application,
	stageApplication,
	activateApplication,
	discardStagedApplication,
	DEPLOY_STAGING_DIR,
	ASIDE_STAGING_DIR,
} = require('#src/components/Application');
const { getConfigPath } = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const COMPONENTS_ROOT = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);

// Pack a directory's CONTENTS into a gzipped tar Buffer, the shape a deploy payload takes.
function packDirectory(dir) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		tarfs
			.pack(dir)
			.pipe(zlib.createGzip())
			.on('data', (c) => chunks.push(c))
			.on('end', () => resolve(Buffer.concat(chunks)))
			.on('error', reject);
	});
}

// A minimal component source that already contains node_modules, so installApplication short-circuits
// ("already has node_modules; skipping install") and the test needs no npm/network.
async function makeComponentPayload(marker) {
	const src = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-stage-src-'));
	await fs.writeFile(path.join(src, 'package.json'), JSON.stringify({ name: 'stage-fixture', version: '1.0.0' }));
	await fs.writeFile(path.join(src, 'index.js'), `module.exports = ${JSON.stringify(marker)};\n`);
	await fs.mkdir(path.join(src, 'node_modules'), { recursive: true });
	await fs.writeFile(path.join(src, 'node_modules', '.marker'), marker);
	const payload = await packDirectory(src);
	await fs.rm(src, { recursive: true, force: true });
	return payload;
}

async function readMarker(dir) {
	return fs.readFile(path.join(dir, 'index.js'), 'utf8');
}

describe('two-phase deploy primitives (stage / activate / discard)', function () {
	this.timeout(30_000);

	before(async () => {
		await fs.mkdir(COMPONENTS_ROOT, { recursive: true });
	});

	// Each case uses a unique component name so the tests are order-independent and don't collide.
	let counter = 0;
	function freshApp(payload) {
		const name = `stage_test_${process.pid}_${counter++}`;
		return new Application({ name, payload });
	}

	it('stageApplication builds into the hidden staging dir and does NOT touch the live path', async () => {
		const app = freshApp(await makeComponentPayload('v1'));

		assert.ok(app.stagingDirPath.includes(DEPLOY_STAGING_DIR), 'staging path is under the staging dir');
		assert.strictEqual(app.buildDirPath, app.dirPath, 'build target defaults to the live dir before staging');

		const stagedPath = await stageApplication(app);

		assert.strictEqual(stagedPath, app.stagingDirPath);
		assert.ok(existsSync(path.join(app.stagingDirPath, 'index.js')), 'component extracted into staging');
		assert.ok(existsSync(path.join(app.stagingDirPath, 'node_modules')), 'node_modules present in staging');
		assert.strictEqual(existsSync(app.dirPath), false, 'live component dir was NOT created by staging');

		await fs.rm(path.dirname(app.stagingDirPath), { recursive: true, force: true });
	});

	it('activateApplication swaps the staged copy into the live path atomically', async () => {
		const app = freshApp(await makeComponentPayload('v1'));
		await stageApplication(app);
		await activateApplication(app);

		assert.ok(existsSync(app.dirPath), 'live component dir now exists');
		assert.match(await readMarker(app.dirPath), /v1/, 'live dir holds the staged content');
		assert.strictEqual(existsSync(app.stagingDirPath), false, 'the staged copy was consumed by the swap');
		assert.strictEqual(app.buildDirPath, app.dirPath, 'build target reset to live after activation');

		await fs.rm(app.dirPath, { recursive: true, force: true });
	});

	it('stage → activate replaces an existing live version and moves the old one aside', async () => {
		const name = `stage_test_${process.pid}_${counter++}`;
		const dirPath = path.join(COMPONENTS_ROOT, name);
		// Seed an existing live version.
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'index.js'), 'module.exports = "OLD";\n');
		await fs.writeFile(path.join(dirPath, 'leftover.txt'), 'from the old version');

		const app = new Application({ name, payload: await makeComponentPayload('v2') });
		await stageApplication(app);
		await activateApplication(app);

		assert.match(await readMarker(dirPath), /v2/, 'live dir now holds the new version');
		assert.strictEqual(existsSync(path.join(dirPath, 'leftover.txt')), false, 'old-version files are gone from live');

		await fs.rm(dirPath, { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, ASIDE_STAGING_DIR), { recursive: true, force: true });
	});

	it('discardStagedApplication removes the staging tree and leaves the live path untouched', async () => {
		const name = `stage_test_${process.pid}_${counter++}`;
		const dirPath = path.join(COMPONENTS_ROOT, name);
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'index.js'), 'module.exports = "LIVE";\n');

		const app = new Application({ name, payload: await makeComponentPayload('v3') });
		await stageApplication(app);
		assert.ok(existsSync(app.stagingDirPath), 'staged before discard');

		await discardStagedApplication(app);

		assert.strictEqual(existsSync(app.stagingDirPath), false, 'staging tree removed');
		assert.match(await readMarker(dirPath), /LIVE/, 'live version untouched by discard');

		await fs.rm(dirPath, { recursive: true, force: true });
	});

	it('a failed stage leaves the live path untouched and cleans up its partial staging tree', async () => {
		const name = `stage_test_${process.pid}_${counter++}`;
		const dirPath = path.join(COMPONENTS_ROOT, name);
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'index.js'), 'module.exports = "LIVE";\n');

		// No payload and no package identifier → extractApplication throws before anything is built.
		const app = new Application({ name });
		await assert.rejects(() => stageApplication(app), /payload or package/i);

		assert.strictEqual(existsSync(app.stagingDirPath), false, 'partial staging tree removed on failure');
		assert.match(await readMarker(dirPath), /LIVE/, 'live version untouched by a failed stage');
		assert.strictEqual(app.buildDirPath, app.dirPath, 'build target reset to live after a failed stage');

		await fs.rm(dirPath, { recursive: true, force: true });
	});

	it('two independent components stage into non-colliding staging dirs', async () => {
		const a = freshApp(await makeComponentPayload('A'));
		const b = freshApp(await makeComponentPayload('B'));
		await Promise.all([stageApplication(a), stageApplication(b)]);

		assert.notStrictEqual(a.stagingDirPath, b.stagingDirPath);
		assert.match(await readMarker(a.stagingDirPath), /A/);
		assert.match(await readMarker(b.stagingDirPath), /B/);

		await Promise.all([discardStagedApplication(a), discardStagedApplication(b)]);
	});

	it('stages a `file:` tarball package identifier (the package path, no payload)', async () => {
		// Regression for the staging parent dir: extractApplication's `file:`-tarball branch (and the
		// npm-pack branch) resolve paths relative to dirname(stagingDirPath), which must exist before
		// extraction. A payload-only test never exercises that branch.
		const name = `stage_test_${process.pid}_${counter++}`;
		const tgzDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-stage-tgz-'));
		const tgzPath = path.join(tgzDir, 'component.tgz');
		await fs.writeFile(tgzPath, await makeComponentPayload('from-tarball'));

		const app = new Application({ name, packageIdentifier: `file:${tgzPath}` });
		await stageApplication(app);
		assert.match(await readMarker(app.stagingDirPath), /from-tarball/, 'tarball extracted into staging');
		assert.strictEqual(existsSync(app.dirPath), false, 'live dir untouched by staging a tarball');

		await discardStagedApplication(app);
		await fs.rm(tgzDir, { recursive: true, force: true });
	});

	it('activate cleanup does NOT sweep a sibling staged build of the same component', async () => {
		// Two deploys of the same component staged concurrently share the .deploy-staging/<name> parent.
		// Activating one must not recursively delete that parent and destroy the other's staged build.
		const name = `stage_test_${process.pid}_${counter++}`;
		const first = new Application({ name, payload: await makeComponentPayload('first') });
		const second = new Application({ name, payload: await makeComponentPayload('second') });
		await stageApplication(first);
		await stageApplication(second);
		assert.notStrictEqual(first.stagingDirPath, second.stagingDirPath);

		await activateApplication(first);

		assert.match(await readMarker(first.dirPath), /first/, 'first went live');
		assert.ok(existsSync(second.stagingDirPath), 'the sibling staged build survived the activate cleanup');

		await fs.rm(first.dirPath, { recursive: true, force: true });
		await discardStagedApplication(second);
		await fs.rm(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, ASIDE_STAGING_DIR), { recursive: true, force: true });
	});

	it('activate moves a DANGLING symlink at the live path aside instead of failing EEXIST', async () => {
		// A prior `file:`-directory deploy leaves the live path as a symlink; if its target is later
		// removed the link dangles. moveDirAside must detect it via lstat (access(F_OK) follows the link
		// and reports ENOENT) so the swap replaces it cleanly.
		const name = `stage_test_${process.pid}_${counter++}`;
		const dirPath = path.join(COMPONENTS_ROOT, name);
		await fs.symlink(path.join(os.tmpdir(), `does-not-exist-${process.pid}-${counter}`), dirPath);
		assert.strictEqual(existsSync(dirPath), false, 'precondition: the symlink is dangling');

		const app = new Application({ name, payload: await makeComponentPayload('replaced') });
		await stageApplication(app);
		await activateApplication(app);

		const stat = await fs.lstat(dirPath);
		assert.strictEqual(stat.isSymbolicLink(), false, 'live path is now a real directory, not the dead link');
		assert.match(await readMarker(dirPath), /replaced/);

		await fs.rm(dirPath, { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, ASIDE_STAGING_DIR), { recursive: true, force: true });
	});
});
