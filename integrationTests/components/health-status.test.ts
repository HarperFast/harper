import { suite, test } from 'node:test';
import assert from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

async function waitForDisk(ctx: ContextWithHarper, status: string, percent: string) {
	const deadline = performance.now() + 15_000;
	let last;
	do {
		const result = await sendOperation(ctx.harper, { operation: 'get_status', components: true });
		last = result.componentStatus.find((entry: { name: string }) => entry.name === 'system.disk');
		if (last?.status === status && (status === 'healthy' || last.latestMessage?.includes(percent))) {
			assert.equal(result.components.system.children.disk.status, status);
			if (status !== 'healthy') assert.ok(last.latestMessage.includes('quota'));
			assert.equal(last.source, 'health-check');
			return;
		}
		await delay(50);
	} while (performance.now() < deadline);
	assert.fail(`Expected ${status} disk at ${percent}; last status: ${JSON.stringify(last)}`);
}

suite('configured runtime health status', { timeout: 360_000 }, () => {
	for (const threadCount of [1, 0]) {
		test(`uses quota pressure, custom thresholds and repeated polling with ${threadCount} workers`, async (t) => {
			const ctx = t as ContextWithHarper;
			try {
				await startHarper(ctx, {
					config: {
						threads: { count: threadCount },
						status: {
							healthChecks: { enabled: true, intervalSeconds: 1, thresholds: { disk: { warning: 70, error: 90 } } },
						},
					},
				});
				const quotaPath = join(ctx.harper.dataRootDir, 'quota-status.json');
				for (const [usedBytes, expected] of [
					[96, 'error'],
					[92, 'error'],
					[85, 'warning'],
					[75, 'warning'],
					[40, 'healthy'],
				] as const) {
					await writeFile(quotaPath, JSON.stringify({ usedBytes, quotaBytes: 100, updatedAt: Date.now() }));
					await waitForDisk(ctx, expected, `${usedBytes}.0%`);
				}
			} finally {
				await teardownHarper(ctx);
			}
		});
	}

	test('a disabled instance publishes no OS health samples after three polling intervals', async (t) => {
		const ctx = t as ContextWithHarper;
		try {
			await startHarper(ctx, {
				config: { status: { healthChecks: { intervalSeconds: 1 } } },
				env: { STATUS_HEALTHCHECKS_ENABLED: 'false' },
			});
			await delay(3100);
			const result = await sendOperation(ctx.harper, { operation: 'get_status' });
			for (const name of ['system.disk', 'system.memory', 'system.cpu']) {
				assert.ok(!result.componentStatus.some((entry: { name: string }) => entry.name === name), name);
			}
		} finally {
			await teardownHarper(ctx);
		}
	});
});
