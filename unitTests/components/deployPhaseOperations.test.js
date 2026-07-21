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
const { DEPLOY_STAGING_DIR, Application, stageApplication } = require('#src/components/Application');
const { restartNeeded, resetRestartNeeded } = require('#src/components/requestRestart');
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

	// Sweep any live dirs, staging, previous, and aside created by the suite.
	after(async () => {
		for (const name of names) await fs.rm(path.join(COMPONENTS_ROOT, name), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, '.deploy-previous'), { recursive: true, force: true });
		await fs.rm(path.join(COMPONENTS_ROOT, '.deploy-aside'), { recursive: true, force: true });
		// Deploying a genuinely-new component flips the process-wide restart-needed buffer on
		// (harper#674, via deployComponent's requestRestart() scoping). That buffer is shared across
		// the whole mocha process, so restore it or a later test asserting a pristine buffer
		// (e.g. requestRestart.test.js) fails on ordering alone.
		resetRestartNeeded();
	});

	// Each test below deploys fresh components, and deploying a never-live component flips the
	// process-wide restart-needed buffer (harper#674). Start every test from a known-clean buffer so the
	// restartNeeded() assertions below reflect only that test's own deploy, not a prior test's leak.
	beforeEach(() => resetRestartNeeded());

	it('deploy_component({activate:false}) stages into the hidden dir without going live, and returns a deployment_id', async () => {
		const name = freshName();
		const res = await operations.deployComponent({
			project: name,
			payload: await makeComponentPayload('op-staged'),
			activate: false,
		});

		assert.strictEqual(res.staged, true);
		assert.strictEqual(res.project, name);
		assert.strictEqual(typeof res.deployment_id, 'string');

		const stagedDir = path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR, res.deployment_id, name);
		assert.ok(existsSync(path.join(stagedDir, 'index.js')), 'component was built into the staging dir');
		assert.strictEqual(existsSync(path.join(COMPONENTS_ROOT, name)), false, 'staging did not touch the live path');
	});

	it('deploy_component({deployment_id}) takes a prior stage live', async () => {
		const name = freshName();
		const staged = await operations.deployComponent({
			project: name,
			payload: await makeComponentPayload('op-activated'),
			activate: false,
		});
		const res = await operations.deployComponent({ project: name, deployment_id: staged.deployment_id });

		assert.strictEqual(res.activated, true);
		assert.strictEqual(res.project, name);
		assert.strictEqual(res.deployment_id, staged.deployment_id);
		const liveDir = path.join(COMPONENTS_ROOT, name);
		assert.ok(existsSync(liveDir), 'live component dir now exists');
		assert.match(await readIndex(liveDir), /op-activated/);
		// A restart was not requested, so the message must not claim one.
		assert.doesNotMatch(res.message, /restart/i);
		// ...but this component was never live before, so activating it without a restart must mark one
		// as required (harper#674) — the activate-existing leg of the two-phase restart-required fix. The
		// message assertion above can't see this: the string never mentions "restart" on the no-restart
		// path whether or not the marking runs, so assert the flag directly.
		assert.strictEqual(
			restartNeeded(),
			true,
			'activating a never-live component without restart marks a restart required'
		);
	});

	it('deploy_component (two-phase default) stages then activates end-to-end', async () => {
		const name = freshName();
		const res = await operations.deployComponent({ project: name, payload: await makeComponentPayload('op-deployed') });

		assert.match(res.message, /Successfully deployed/);
		assert.strictEqual(typeof res.deployment_id, 'string');
		const liveDir = path.join(COMPONENTS_ROOT, name);
		assert.match(await readIndex(liveDir), /op-deployed/, 'component is live after a two-phase deploy');
		// New component deployed without a restart → restart required (harper#674), the origin two-phase leg.
		assert.strictEqual(restartNeeded(), true, 'a fresh two-phase deploy without restart marks a restart required');
		// The staged copy was consumed by the swap; its per-deploy staging parent is cleaned up.
		assert.strictEqual(
			existsSync(path.join(COMPONENTS_ROOT, DEPLOY_STAGING_DIR, res.deployment_id)),
			false,
			'per-deploy staging parent removed after activation'
		);
	});

	it('redeploying an already-live component without restart does NOT mark a restart required', async () => {
		// The negative direction of harper#674/#1806: an existing, already-active component's own watcher
		// requests any restart a redeploy needs, so deploy_component must stay quiet. Two-phase can't lean
		// on extractApplication's in-place check (it builds into a fresh staging dir), so this guards that
		// activateApplication correctly reports isNewComponent:false when a live version already exists.
		const name = freshName();
		await operations.deployComponent({ project: name, payload: await makeComponentPayload('redeploy-v1') });
		resetRestartNeeded(); // clear the flag the first (new-component) deploy legitimately set
		await operations.deployComponent({ project: name, payload: await makeComponentPayload('redeploy-v2') });
		assert.strictEqual(
			restartNeeded(),
			false,
			'a redeploy of an already-live component must not self-request a restart'
		);
	});

	it('peer _phase:activate takes a locally-staged build live and marks a restart for a new component', async () => {
		// The peer leg of the fix: a peer applies the fanned-out deploy_component tagged _phase:'activate'
		// (deployPhaseActivate), swapping its OWN locally-staged build live. It must mark restart-required
		// per node for a genuinely-new component (harper#674) — otherwise a cluster-wide restart:false
		// deploy reports restartRequired on the origin only. Stage the build directly (standing in for the
		// peer's earlier stage phase), then drive the activate phase through the public op with the
		// internal markers, exactly as the replicated fan-out does.
		const name = freshName();
		const deploymentId = `peer-activate-${name}`;
		const staged = new Application({
			name,
			payload: await makeComponentPayload('peer-activated'),
			stagingId: deploymentId,
		});
		await stageApplication(staged);

		const res = await operations.deployComponent({
			project: name,
			_phase: 'activate',
			_deploymentId: deploymentId,
			restart: false,
		});

		assert.strictEqual(res.activated, true, 'peer activate reports the component activated');
		const liveDir = path.join(COMPONENTS_ROOT, name);
		assert.match(await readIndex(liveDir), /peer-activated/, 'the locally-staged build is now live');
		assert.strictEqual(
			restartNeeded(),
			true,
			'peer activate of a never-live component without restart marks a restart required'
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

	it('revert_component swaps the live version back to the previous deployment', async () => {
		const name = freshName();
		const liveDir = path.join(COMPONENTS_ROOT, name);
		await operations.deployComponent({ project: name, payload: await makeComponentPayload('rev-v1') });
		await operations.deployComponent({ project: name, payload: await makeComponentPayload('rev-v2') });
		assert.match(await readIndex(liveDir), /rev-v2/, 'v2 is live before revert');

		const res = await operations.revertComponent({ project: name });

		assert.strictEqual(res.reverted, true);
		assert.strictEqual(res.project, name);
		assert.match(await readIndex(liveDir), /rev-v1/, 'revert restored v1 to live');
	});

	it('revert_component rejects a component with no retained previous version', async () => {
		const name = freshName();
		await operations.deployComponent({ project: name, payload: await makeComponentPayload('rev-once') });
		await assert.rejects(() => operations.revertComponent({ project: name }), /no previous version is retained/i);
	});

	it('revert_component requires a project', async () => {
		await assert.rejects(() => operations.revertComponent({}), /project/i);
	});

	// The revert_on_failure fan-out itself needs a live multi-node cluster (harper-pro's replicator) to
	// run end-to-end, but its node-targeting is a pure function — and the exact spot that had two
	// review-caught bugs (skip failed peers, skip self). Exercise it directly.
	describe('selectRevertTargets (revert_on_failure node targeting)', () => {
		const nodes = [{ name: 'origin' }, { name: 'peerA' }, { name: 'peerB' }, { name: 'peerC' }];

		it('returns activated peers, excluding this node and failed peers', () => {
			const failed = [{ node: 'peerB', status: 'failed' }];
			const targets = operations.selectRevertTargets(nodes, failed, 'origin').map((n) => n.name);
			assert.deepStrictEqual(targets.sort(), ['peerA', 'peerC'], 'peerB (failed) and origin (self) excluded');
		});

		it('excludes THIS node even when it is present in server.nodes (bidirectional double-revert guard)', () => {
			const targets = operations.selectRevertTargets(nodes, [], 'origin').map((n) => n.name);
			assert.ok(!targets.includes('origin'), 'self must never receive a self-directed revert');
			assert.deepStrictEqual(targets.sort(), ['peerA', 'peerB', 'peerC']);
		});

		it('excludes every failed peer (they never activated and are on the correct version)', () => {
			const failed = [
				{ node: 'peerA', status: 'failed' },
				{ node: 'peerC', status: 'failed' },
			];
			const targets = operations.selectRevertTargets(nodes, failed, 'origin').map((n) => n.name);
			assert.deepStrictEqual(targets, ['peerB'], 'only the one activated peer is a revert target');
		});

		it('is safe with empty/undefined nodes and failed lists, and ignores failed entries with no node name', () => {
			assert.deepStrictEqual(operations.selectRevertTargets(undefined, undefined, 'origin'), []);
			assert.deepStrictEqual(operations.selectRevertTargets([], [{ node: null }], 'origin'), []);
			const targets = operations.selectRevertTargets(nodes, [{ node: null }], 'origin').map((n) => n.name);
			assert.deepStrictEqual(targets.sort(), ['peerA', 'peerB', 'peerC'], 'a null-node failed entry drops nobody');
		});
	});
});
