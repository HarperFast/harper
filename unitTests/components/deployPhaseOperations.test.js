'use strict';

// Operation-level orchestration tests for the two-phase deploy handlers: stage_component,
// activate_component, and the legacy one-shot deploy_component (two_phase: false). The heavy,
// environment-dependent internals (the actual build/swap, payload blob ingest, credential resolution)
// are rewired to stubs so these assert the ORCHESTRATION — which primitive runs, whether replication
// and restart fire, the response shape — without needing npm/network or the full component loader.

const assert = require('node:assert');
const rewire = require('rewire');
const sinon = require('sinon');

const operations = rewire('#js/components/operations');
const manageThreads = require('#src/server/threads/manageThreads');

// Neutralize the parts that touch the filesystem / datastore / cluster, leaving the control flow.
function stubInternals(sandbox) {
	const stage = sandbox.stub().resolves('/staging');
	const activate = sandbox.stub().resolves();
	const prepare = sandbox.stub().resolves();
	operations.__set__('stageApplication', stage);
	operations.__set__('activateApplication', activate);
	operations.__set__('prepareApplication', prepare);
	// Skip payload-blob ingest and credential resolution — not what these tests exercise.
	operations.__set__('sourceExtractionPayload', sandbox.stub().resolves(Buffer.from('tarball')));
	operations.__set__('resolveNodeCredentials', sandbox.stub().resolves([]));
	// Don't actually bounce workers.
	sandbox.stub(manageThreads, 'restartWorkers');
	return { stage, activate, prepare };
}

describe('stage_component / activate_component / one-shot deploy orchestration', () => {
	let sandbox;
	beforeEach(() => {
		sandbox = sinon.createSandbox();
	});
	afterEach(() => {
		sandbox.restore();
	});

	it('stageComponent stages, replicates, and returns a staged marker + deployment_id — no restart, no config write', async () => {
		const { stage, activate, prepare } = stubInternals(sandbox);
		const addConfig = sandbox.stub(require('#src/config/configUtils'), 'addConfig').resolves();

		const res = await operations.stageComponent({ project: 'my_app', payload: Buffer.from('x') });

		assert.strictEqual(stage.calledOnce, true, 'stageApplication was called');
		assert.strictEqual(activate.called, false, 'activate never runs during a stage');
		assert.strictEqual(prepare.called, false, 'the one-shot prepare path is not used');
		assert.strictEqual(res.staged, true);
		assert.strictEqual(res.project, 'my_app');
		assert.ok(res.deployment_id, 'a deployment_id is returned');
		assert.strictEqual(addConfig.called, false, 'staging never writes root config');
		assert.strictEqual(manageThreads.restartWorkers.called, false, 'staging never restarts');
	});

	it('activateComponent swaps live and restarts when restart:true; returns an activated marker', async () => {
		const { activate } = stubInternals(sandbox);

		const res = await operations.activateComponent({
			project: 'my_app',
			deployment_id: 'dep-123',
			restart: true,
		});

		assert.strictEqual(activate.calledOnce, true, 'activateApplication was called');
		assert.strictEqual(res.activated, true);
		assert.strictEqual(res.project, 'my_app');
		assert.strictEqual(manageThreads.restartWorkers.calledWith('http'), true, 'restarted the http workers');
	});

	it('activateComponent does not restart when restart is omitted', async () => {
		const { activate } = stubInternals(sandbox);
		await operations.activateComponent({ project: 'my_app', deployment_id: 'dep-123' });
		assert.strictEqual(activate.calledOnce, true);
		assert.strictEqual(manageThreads.restartWorkers.called, false);
	});

	it('activateComponent rejects when no deployment_id is supplied', async () => {
		stubInternals(sandbox);
		await assert.rejects(() => operations.activateComponent({ project: 'my_app' }), /deployment_id.*required/i);
	});

	it('deploy_component with two_phase:false takes the legacy one-shot path (prepareApplication, not stage/activate)', async () => {
		const { stage, activate, prepare } = stubInternals(sandbox);

		const res = await operations.deployComponent({
			project: 'my_app',
			payload: Buffer.from('x'),
			two_phase: false,
		});

		assert.strictEqual(prepare.calledOnce, true, 'one-shot prepareApplication was called');
		assert.strictEqual(stage.called, false, 'two-phase stage not used on the one-shot path');
		assert.strictEqual(activate.called, false, 'two-phase activate not used on the one-shot path');
		assert.match(res.message, /Successfully deployed/);
	});
});
