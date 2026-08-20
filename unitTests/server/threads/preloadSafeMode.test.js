'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const envMgr = require('#src/utility/environment/environmentManager');
const hdbTerms = require('#src/utility/hdbTerms');
const { startWorker } = require('#js/server/threads/manageThreads');

const FIXTURES = path.join(__dirname, 'preloadSafeMode-fixtures');
const WORKER_FIXTURE = path.join(FIXTURES, 'worker.cjs');

async function getWorkerReport() {
	let worker;
	try {
		return await new Promise((resolve, reject) => {
			worker = startWorker(WORKER_FIXTURE, {
				name: 'safe-mode-preload-test',
				autoRestart: false,
				onStarted(spawned) {
					spawned.once('message', resolve);
					spawned.once('error', reject);
					spawned.once('exit', (code) => reject(new Error(`Worker exited before reporting (code ${code})`)));
				},
			});
		});
	} finally {
		if (worker) {
			worker.wasShutdown = true;
			await worker.terminate();
		}
	}
}

describe('worker preloads in safe mode', () => {
	let originalSafeMode;
	let originalPreload;
	let originalPreloadRequire;

	before(() => {
		originalSafeMode = process.env.HARPER_SAFE_MODE;
		originalPreload = envMgr.get(hdbTerms.CONFIG_PARAMS.THREADS_PRELOAD);
		originalPreloadRequire = envMgr.get(hdbTerms.CONFIG_PARAMS.THREADS_PRELOADREQUIRE);
		envMgr.setProperty(hdbTerms.CONFIG_PARAMS.THREADS_PRELOAD, path.join(FIXTURES, 'import.cjs'));
		envMgr.setProperty(hdbTerms.CONFIG_PARAMS.THREADS_PRELOADREQUIRE, path.join(FIXTURES, 'require.cjs'));
		process.env.HARPER_SAFE_MODE = '1';
	});

	after(() => {
		envMgr.setProperty(hdbTerms.CONFIG_PARAMS.THREADS_PRELOAD, originalPreload);
		envMgr.setProperty(hdbTerms.CONFIG_PARAMS.THREADS_PRELOADREQUIRE, originalPreloadRequire);
		if (originalSafeMode === undefined) delete process.env.HARPER_SAFE_MODE;
		else process.env.HARPER_SAFE_MODE = originalSafeMode;
	});

	it('does not load or add flags for threads.preload and threads.preloadRequire modules', async function () {
		this.timeout(30000);
		const report = await getWorkerReport();
		assert.strictEqual(report.importLoaded, false);
		assert.strictEqual(report.requireLoaded, false);
		assert.strictEqual(report.execArgv.includes('--import'), false);
		assert.strictEqual(report.execArgv.includes('--require'), false);
	});

	it('loads both configured preload forms outside safe mode', async function () {
		this.timeout(30000);
		delete process.env.HARPER_SAFE_MODE;
		const report = await getWorkerReport();
		assert.strictEqual(report.importLoaded, true);
		assert.strictEqual(report.requireLoaded, true);
		assert.strictEqual(report.execArgv.includes('--import'), true);
		assert.strictEqual(report.execArgv.includes('--require'), true);
	});

	it('refreshes resolved preloads when configuration changes after a worker starts', async function () {
		this.timeout(30000);
		delete process.env.HARPER_SAFE_MODE;
		envMgr.setProperty(hdbTerms.CONFIG_PARAMS.THREADS_PRELOAD, null);
		envMgr.setProperty(hdbTerms.CONFIG_PARAMS.THREADS_PRELOADREQUIRE, null);
		const before = await getWorkerReport();
		assert.strictEqual(before.importLoaded, false);
		assert.strictEqual(before.requireLoaded, false);

		envMgr.setProperty(hdbTerms.CONFIG_PARAMS.THREADS_PRELOAD, path.join(FIXTURES, 'import.cjs'));
		envMgr.setProperty(hdbTerms.CONFIG_PARAMS.THREADS_PRELOADREQUIRE, path.join(FIXTURES, 'require.cjs'));
		const after = await getWorkerReport();
		assert.strictEqual(after.importLoaded, true);
		assert.strictEqual(after.requireLoaded, true);
	});

	it('retries an unresolved preload when the module becomes available', async function () {
		this.timeout(30000);
		delete process.env.HARPER_SAFE_MODE;
		const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'preload-late-install-'));
		const importPath = path.join(fixtureDirectory, 'import.cjs');
		envMgr.setProperty(hdbTerms.CONFIG_PARAMS.THREADS_PRELOAD, importPath);
		envMgr.setProperty(hdbTerms.CONFIG_PARAMS.THREADS_PRELOADREQUIRE, null);
		try {
			const before = await getWorkerReport();
			assert.strictEqual(before.importLoaded, false);
			writeFileSync(importPath, 'globalThis.__harperImportPreloaded = true;\n');
			const after = await getWorkerReport();
			assert.strictEqual(after.importLoaded, true);
		} finally {
			rmSync(fixtureDirectory, { recursive: true, force: true });
		}
	});
});
