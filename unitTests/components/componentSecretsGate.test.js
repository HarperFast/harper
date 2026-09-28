'use strict';

// Loader-level tests for the `env:` load-gate (#1550): a component whose required env
// declarations are unsatisfied fails to load with a clear error — and the instance survives
// (loadComponent resolves; the failure is contained to that component's status). Uses real
// loadComponent against temp component directories — no stubs.

const assert = require('node:assert');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { loadComponent } = require('#src/components/componentLoader');
const { resetResources } = require('#src/resources/Resources');
const { internal: statusInternal } = require('#src/components/status/index');
const { resetComponentSecrets, getUnsatisfiedEnv } = require('#src/components/componentSecrets');

describe('componentSecrets load-gate (loader integration)', () => {
	let tempRoot;
	let resources;

	before(() => {
		tempRoot = mkdtempSync(path.join(tmpdir(), 'harper-component-secrets-'));
	});

	after(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	beforeEach(() => {
		resources = resetResources();
		resources.isWorker = false;
		delete process.env.CS_GATE_LITERAL;
	});

	afterEach(() => {
		resetComponentSecrets();
		delete process.env.CS_GATE_LITERAL;
	});

	function makeComponent(name, configYaml) {
		const dir = path.join(tempRoot, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'config.yaml'), configYaml);
		return dir;
	}

	it('an unsatisfied required declaration fails the component but not the instance', async () => {
		const dir = makeComponent('gated-app', 'env:\n  CS_GATE_REQ:\n    required: true\n    description: needed key\n');
		// resolves (no throw) — the instance keeps running
		const result = await loadComponent(dir, resources, 'test-origin', { isRoot: false, appName: 'gated-app' });
		assert.equal(result, undefined);
		const status = statusInternal.componentStatusRegistry.getStatus('gated-app');
		assert.equal(status.status, 'error');
		assert.equal(/CS_GATE_REQ/.test(String(status.error?.message ?? status.message)), true);
		assert.equal(/missing/.test(String(status.error?.message ?? status.message)), true);
		// the unsatisfied set is exposed for status surfaces (metadata only)
		const unsatisfied = getUnsatisfiedEnv('gated-app');
		assert.equal(unsatisfied.length, 1);
		assert.deepEqual(
			{ name: unsatisfied[0].name, required: unsatisfied[0].required, reason: unsatisfied[0].reason },
			{ name: 'CS_GATE_REQ', required: true, reason: 'missing' }
		);
	});

	it('a satisfiable env block loads: literals land in process.env, optional gaps do not gate', async () => {
		const dir = makeComponent('ok-app', 'env:\n  CS_GATE_LITERAL: from-config\n  CS_GATE_OPT:\n    required: false\n');
		await loadComponent(dir, resources, 'test-origin', { isRoot: false, appName: 'ok-app' });
		assert.equal(process.env.CS_GATE_LITERAL, 'from-config');
		const status = statusInternal.componentStatusRegistry.getStatus('ok-app');
		assert.equal(status?.status === 'error', false);
		assert.equal(getUnsatisfiedEnv('ok-app')[0].reason, 'missing');
		assert.equal(getUnsatisfiedEnv('ok-app')[0].required, false);
	});
});
