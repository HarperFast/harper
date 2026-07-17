'use strict';

// Operation-level tests for the two-phase deploy handlers: stage_component, activate_component, and
// deploy_component (both the two-phase default and the two_phase:false one-shot fallback). These run
// the real handlers against a real temp filesystem with a real tarball payload — no stubbing — in the
// deployStaging.test.js style (AGENTS.md: new tests use plain `assert` against real modules, no
// sinon/rewire). Payload deploys are used throughout so nothing reaches the component loader (a
// `package` deploy's protected-name guard would), and no test requests a restart.

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
const { DEPLOY_STAGING_DIR } = require('#src/components/Application');
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

// A component source that already contains node_modules, so installApplication short-circuits and no
// npm/network is needed.
async function makeComponentPayload(marker) {
	const src = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-op-src-'));
	await fs.writeFile(path.join(src, 'package.json'), JSON.stringify({ name: 'op-fixture', version: '1.0.0' }));
	await fs.writeFile(path.join(src, 'index.js'), `module.exports = ${JSON.stringify(marker)};\n`);
	await fs.mkdir(path.join(src, 'node_modules'), { recursive: true });
	await fs.writeFile(path.join(src, 'node_modules', '.marker'), marker);
	const payload = await packDirectory(src);
	await fs.rm(src, { recursive: true, force: true });
	return payload;
}

const readIndex = (dir) => fs.readFile(path.join(dir, 'index.js'), 'utf8');

describe('deploy operations: stage_component / activate_component / deploy_component', function () {
	this.timeout(30_000);

	before(async () => {
		await fs.mkdir(COMPONENTS_ROOT, { recursive: true });
	});

	let counter = 0;
	const names = [];
	function freshName() {
		const name = `op_test_${process.pid}_${counter++}`;
		names.push(name);
		return name;
	}

	// Sweep any live dirs, staging, and aside created by the suite.
	after(async () => {
		for (const name of names) await fs.rm(path.join(COMPONENTS_ROOT, name), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, '.deploy-aside'), { recursive: true, force: true });
	});

	it('stage_component builds the incoming version into staging without going live, and returns a deployment_id', async () => {
		const name = freshName();
		const res = await operations.stageComponent({ project: name, payload: await makeComponentPayload('op-staged') });

		assert.strictEqual(res.staged, true);
		assert.strictEqual(res.project, name);
		assert.strictEqual(typeof res.deployment_id, 'string');

		const stagedDir = path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR, res.deployment_id, name);
		assert.ok(existsSync(path.join(stagedDir, 'index.js')), 'component was built into the staging dir');
		assert.strictEqual(existsSync(path.join(COMPONENTS_ROOT, name)), false, 'staging did not touch the live path');
	});

	it('activate_component takes a prior stage live', async () => {
		const name = freshName();
		const staged = await operations.stageComponent({
			project: name,
			payload: await makeComponentPayload('op-activated'),
		});
		const res = await operations.activateComponent({ project: name, deployment_id: staged.deployment_id });

		assert.strictEqual(res.activated, true);
		assert.strictEqual(res.project, name);
		const liveDir = path.join(COMPONENTS_ROOT, name);
		assert.ok(existsSync(liveDir), 'live component dir now exists');
		assert.match(await readIndex(liveDir), /op-activated/);
		// A restart was not requested, so the message must not claim one.
		assert.doesNotMatch(res.message, /restart/i);
	});

	it('activate_component rejects when no deployment_id is supplied', async () => {
		const name = freshName();
		await assert.rejects(() => operations.activateComponent({ project: name }), /deployment_id.*required/i);
	});

	it('deploy_component (two-phase default) stages then activates end-to-end', async () => {
		const name = freshName();
		const res = await operations.deployComponent({ project: name, payload: await makeComponentPayload('op-deployed') });

		assert.match(res.message, /Successfully deployed/);
		assert.strictEqual(typeof res.deployment_id, 'string');
		const liveDir = path.join(COMPONENTS_ROOT, name);
		assert.match(await readIndex(liveDir), /op-deployed/, 'component is live after a two-phase deploy');
		// The staged copy was consumed by the swap; its per-deploy staging parent is cleaned up.
		assert.strictEqual(
			existsSync(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR, res.deployment_id)),
			false,
			'per-deploy staging parent removed after activation'
		);
	});

	it('deploy_component with two_phase:false runs the legacy one-shot path', async () => {
		const name = freshName();
		const res = await operations.deployComponent({
			project: name,
			payload: await makeComponentPayload('op-oneshot'),
			two_phase: false,
		});

		assert.match(res.message, /Successfully deployed/);
		const liveDir = path.join(COMPONENTS_ROOT, name);
		assert.match(await readIndex(liveDir), /op-oneshot/, 'component is live after a one-shot deploy');
	});
});
