import assert from 'node:assert';
import { resolve } from 'node:path';
import { suite, test } from 'node:test';
import { createHarperContext, HarperStartupError, startHarper, teardownHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/worker-startup-liveness');
const PRELOAD_PATH = resolve(FIXTURE_PATH, 'preload.cjs');
const LOAD_ROOT_COMPONENTS_PATH = resolve(process.cwd(), 'dist/server/loadRootComponents.js');
const WORKER_COUNT = 4;

function startupOptions(mode: 'ref' | 'unref' | 'reject') {
	return {
		config: {
			threads: { count: WORKER_COUNT, preloadRequire: PRELOAD_PATH },
			logging: { console: true, level: 'error' },
		},
		env: {
			HARPER_TEST_LOAD_ROOT_COMPONENTS_PATH: LOAD_ROOT_COMPONENTS_PATH,
			HARPER_TEST_WORKER_STARTUP_MODE: mode,
		},
	};
}

async function startWithMode(mode: 'ref' | 'unref') {
	const context = createHarperContext(`worker-startup-${mode}`);
	try {
		const startedContext = await startHarper(context, startupOptions(mode));
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
	} finally {
		await teardownHarper(context);
	}
}

suite('HTTP worker startup liveness', { skip: process.platform === 'win32' }, () => {
	test('starts all workers when component initialization owns a ref handle', async () => {
		await startWithMode('ref');
	});

	test('starts all workers when component initialization awaits only an unref handle', async () => {
		await startWithMode('unref');
	});

	test('exits explicitly when worker component initialization rejects', async () => {
		const context = createHarperContext('worker-startup-reject');
		let startupError;
		try {
			await startHarper(context, startupOptions('reject'));
		} catch (error) {
			startupError = error;
		} finally {
			await teardownHarper(context);
		}

		assert(startupError instanceof HarperStartupError, 'expected startup to fail');
		assert.match(startupError.stderr, /Failed to load root components in worker/);
		assert.doesNotMatch(startupError.message, /maximum startup time|produced no startup output/);
	});
});
