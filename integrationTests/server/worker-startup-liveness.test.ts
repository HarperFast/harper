/**
 * Run: npm run build && npm run test:integration -- "integrationTests/server/worker-startup-liveness.test.ts"
 * The harness is pinned to this repository's dist build because the preload replaces one of its modules.
 */
import assert from 'node:assert';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { suite, test } from 'node:test';
import { createHarperContext, HarperStartupError, startHarper, teardownHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/worker-startup-liveness');
const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const PRELOAD_PATH = resolve(FIXTURE_PATH, 'preload.cjs');
const HARPER_BIN_PATH = resolve(REPO_ROOT, 'dist/bin/harper.js');
const LOAD_ROOT_COMPONENTS_PATH = resolve(REPO_ROOT, 'dist/server/loadRootComponents.js');
const WORKER_COUNT = 4;

function startupOptions(mode: 'ref' | 'unref' | 'reject', markerDirectory: string) {
	return {
		harperBinPath: HARPER_BIN_PATH,
		config: {
			threads: { count: WORKER_COUNT, preloadRequire: PRELOAD_PATH },
			logging: { console: true, level: 'error' },
		},
		env: {
			HARPER_TEST_LOAD_ROOT_COMPONENTS_PATH: LOAD_ROOT_COMPONENTS_PATH,
			HARPER_TEST_WORKER_STARTUP_MARKER_DIR: markerDirectory,
			HARPER_TEST_WORKER_STARTUP_MODE: mode,
		},
	};
}

function assertPreloadRan(markerDirectory: string, expectedCount: number | null = WORKER_COUNT) {
	const markers = readdirSync(markerDirectory).sort();
	if (expectedCount === null) assert(markers.length > 0, 'expected the worker preload to write a marker');
	else
		assert.strictEqual(markers.length, expectedCount, `expected one preload marker per worker: ${markers.join(', ')}`);
}

async function startWithMode(mode: 'ref' | 'unref') {
	const context = createHarperContext(`worker-startup-${mode}`);
	const markerDirectory = mkdtempSync(join(tmpdir(), `worker-startup-${mode}-`));
	try {
		const startedContext = await startHarper(context, startupOptions(mode, markerDirectory));
		const response = await fetch(startedContext.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Authorization': `Basic ${Buffer.from(`${startedContext.harper.admin.username}:${startedContext.harper.admin.password}`).toString('base64')}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ operation: 'system_information', attributes: ['threads'] }),
		});
		const body = (await response.json()) as { threads?: unknown[] };
		assert.strictEqual(response.status, 200, JSON.stringify(body));
		assert.strictEqual(body.threads?.length, WORKER_COUNT);
		assertPreloadRan(markerDirectory);
	} finally {
		try {
			await teardownHarper(context);
		} finally {
			rmSync(markerDirectory, { recursive: true, force: true });
		}
	}
}

// Bun does not pass preloadRequire through worker execArgv, so it cannot install this fixture.
const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

suite('HTTP worker startup liveness', { skip: skipSuite }, () => {
	test('starts all workers when component initialization owns a ref handle', async () => {
		await startWithMode('ref');
	});

	test('starts all workers when component initialization awaits only an unref handle', async () => {
		await startWithMode('unref');
	});

	test('exits explicitly when worker component initialization rejects', async () => {
		const context = createHarperContext('worker-startup-reject');
		const markerDirectory = mkdtempSync(join(tmpdir(), 'worker-startup-reject-'));
		let startupError;
		try {
			await startHarper(context, startupOptions('reject', markerDirectory));
		} catch (error) {
			startupError = error;
		} finally {
			try {
				await teardownHarper(context);
			} catch (error) {
				rmSync(markerDirectory, { recursive: true, force: true });
				throw error;
			}
		}

		try {
			assertPreloadRan(markerDirectory, null);
			assert(startupError instanceof HarperStartupError, 'expected startup to fail');
			assert.match(startupError.stderr, /Failed to load root components in worker/);
			assert.doesNotMatch(startupError.message, /maximum startup time|produced no startup output/);
		} finally {
			rmSync(markerDirectory, { recursive: true, force: true });
		}
	});
});
