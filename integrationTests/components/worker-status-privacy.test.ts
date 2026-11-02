import { suite, test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

suite('worker faults keep private diagnostic text in the log', { timeout: 180_000 }, () => {
	test('reports real uncaught and worker error events without publishing their contents', async (t) => {
		const ctx = t as ContextWithHarper;
		try {
			await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'fixtures/status-privacy'), {
				config: { threads: { count: 1 }, status: { healthChecks: { enabled: false } } },
				env: {
					HARPER_BUILTIN_COMPONENTS: 'qaStatusFaults=@/integrationTests/components/fixtures/status-privacy/main.js',
				},
			});
			const response = await fetch(new URL('/UncaughtFault', ctx.harper.httpURL));
			assert.equal(response.status, 200, await response.text());
			const deadline = performance.now() + 20_000;
			let status;
			let log = '';
			for (;;) {
				status = await sendOperation(ctx.harper, { operation: 'get_status', components: true });
				log = await readFile(join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log'), 'utf8');
				const keys = ['threads.uncaught-exception', 'threads.worker-error'];
				if (
					keys.every((key) =>
						status.componentStatus.some(
							(entry: { name: string; status: string }) => entry.name === key && entry.status === 'error'
						)
					) &&
					log.includes('QA372-UNCAUGHT-PRIVATE') &&
					log.includes('QA372-WORKER-PRIVATE')
				)
					break;
				assert.ok(
					performance.now() < deadline,
					`Missing fault witness: ${JSON.stringify(status)}; ${log.slice(-2000)}`
				);
				await delay(50);
			}
			const wire = JSON.stringify(status);
			for (const marker of ['QA372-UNCAUGHT-PRIVATE', 'QA372-WORKER-PRIVATE', 'request-token=synthetic']) {
				assert.ok(!wire.includes(marker), `Status disclosed ${marker}: ${wire}`);
			}
			for (const key of ['uncaught-exception', 'worker-error']) {
				const flat = status.componentStatus.find((entry: { name: string }) => entry.name === `threads.${key}`);
				assert.equal(flat.source, 'log');
				assert.equal(flat.error, undefined);
				assert.equal(flat.latestMessage, undefined);
				assert.equal(status.components.threads.children[key].status, 'error');
			}
		} finally {
			await teardownHarper(ctx);
		}
	});
});
