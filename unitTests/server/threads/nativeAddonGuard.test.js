'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { installNativeAddonGuard, nativeAddonGuardExecArgv } = require('#src/server/threads/nativeAddonGuard');
const { IncompatibleNativeAddonError, isPointerCompressionRuntime } = require('#src/utility/nativeAddonAbi');
const { buildElf64, V8_API_SYMBOLS, NODE_API_SYMBOLS } = require('../../utility/fixtures/syntheticElf64.js');

const FIXTURE = path.join(__dirname, 'nativeAddonGuard-fixture.cjs');

describe('nativeAddonGuard', () => {
	let root;
	let incompatibleAddon;
	let nodeApiAddon;
	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-addon-guard-'));
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'guard-fixture' }));
		incompatibleAddon = path.join(root, 'v8-api.node');
		nodeApiAddon = path.join(root, 'node-api.node');
		fs.writeFileSync(incompatibleAddon, buildElf64(V8_API_SYMBOLS));
		fs.writeFileSync(nodeApiAddon, buildElf64(NODE_API_SYMBOLS));
	});
	after(() => {
		if (root) fs.rmSync(root, { recursive: true, force: true });
	});

	function recordingTarget() {
		const calls = [];
		const dlopen = function (...args) {
			calls.push({ self: this, args });
		};
		return { target: { dlopen }, dlopen, calls };
	}

	it('leaves dlopen untouched without pointer compression', () => {
		const { target, dlopen } = recordingTarget();
		assert.strictEqual(installNativeAddonGuard(target, false), false);
		assert.strictEqual(target.dlopen, dlopen);
		if (!isPointerCompressionRuntime()) {
			assert.strictEqual(process.dlopen[Symbol.for('harper.nativeAddonGuard')], undefined);
			assert.deepStrictEqual(nativeAddonGuardExecArgv(), []);
		}
	});

	it('refuses an incompatible addon before dlopen runs', () => {
		const { target, calls } = recordingTarget();
		assert.strictEqual(installNativeAddonGuard(target, true), true);
		assert.throws(() => target.dlopen({ exports: {} }, incompatibleAddon), IncompatibleNativeAddonError);
		assert.strictEqual(calls.length, 0);
	});

	it('forwards a compatible addon load with its exact arguments and receiver', () => {
		const { target, calls } = recordingTarget();
		installNativeAddonGuard(target, true);
		const module = { exports: {} };
		target.dlopen(module, nodeApiAddon);
		target.dlopen(module, nodeApiAddon, 1);
		assert.deepStrictEqual(
			calls.map((call) => call.args),
			[
				[module, nodeApiAddon],
				[module, nodeApiAddon, 1],
			]
		);
		assert.strictEqual(calls[0].self, target);
	});

	it('wraps dlopen once', () => {
		const { target } = recordingTarget();
		installNativeAddonGuard(target, true);
		const guarded = target.dlopen;
		assert.strictEqual(installNativeAddonGuard(target, true), true);
		assert.strictEqual(target.dlopen, guarded);
	});

	async function workerReport(options) {
		const worker = new Worker(FIXTURE, options);
		try {
			return await new Promise((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
				worker.once('exit', (code) => reject(new Error(`fixture worker exited with ${code} before reporting`)));
			});
		} finally {
			await worker.terminate();
		}
	}

	it("guards Node's own .node loader in a worker thread", async function () {
		this.timeout(30000);
		const report = await workerReport({ workerData: { incompatibleAddon, forceInstall: true } });
		assert.deepStrictEqual(report, { nodeApi: 'function', incompatible: 'IncompatibleNativeAddonError' });
	});

	it('gives workers an execArgv that requires this module', () => {
		const [flag, guardPath] = nativeAddonGuardExecArgv(true);
		assert.strictEqual(flag, '--require');
		assert.strictEqual(guardPath, require.resolve('#src/server/threads/nativeAddonGuard'));
	});

	it('installs from execArgv alone in a worker on a pointer-compression runtime', async function () {
		if (!isPointerCompressionRuntime()) this.skip(); // process.config cannot be overridden
		this.timeout(30000);
		const report = await workerReport({ workerData: { incompatibleAddon }, execArgv: nativeAddonGuardExecArgv() });
		assert.deepStrictEqual(report, { nodeApi: 'function', incompatible: 'IncompatibleNativeAddonError' });
	});
});
