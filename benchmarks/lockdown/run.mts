/**
 * Cost of each `applications.lockdown` mode to application code, measured inside a Harper worker thread after its
 * components loaded (so after-load modes have locked). Each mode boots its own Harper, since lockdown is per realm
 * and irreversible. Operations: building a short string from a holey array (msgpackr's string path), msgpackr
 * `unpack` of a small record, and two controls that never store into array holes.
 *
 * Usage (after npm run build from the repo root):
 *   node benchmarks/lockdown/run.mts
 *   node benchmarks/lockdown/run.mts --modes=none,seal-after-load,freeze-after-load --iterations=200000 --rounds=5
 *
 * Result format:
 *   LOCKDOWN_RESULT mode=<mode> op=<operation> ns_per_op=N.N ratio_vs_none=N.NN
 */
import { parseArgs } from 'node:util';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarperContext, setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = join(REPO_ROOT, 'dist', 'bin', 'harper.js');

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		modes: { type: 'string', default: 'none,seal-after-load,freeze-after-load' },
		iterations: { type: 'string', default: '200000' },
		rounds: { type: 'string', default: '5' },
	},
});
const modes = values.modes.split(',');

type BenchResult = { sealed: boolean; frozen: boolean; nanoseconds: Record<string, number> };

async function measure(mode: string): Promise<BenchResult> {
	const fixtureParent = await mkdtemp(join(tmpdir(), 'lockdown-bench-'));
	const appDirectory = join(fixtureParent, 'lockdown-bench-app');
	await cp(join(import.meta.dirname, 'app'), appDirectory, { recursive: true });
	await mkdir(join(appDirectory, 'node_modules'));
	// setupHarperWithFixture copies the app with dereference, so the instance gets a real msgpackr
	await symlink(join(REPO_ROOT, 'node_modules', 'msgpackr'), join(appDirectory, 'node_modules', 'msgpackr'));
	const ctx = createHarperContext(`lockdown-bench-${mode}`);
	try {
		await setupHarperWithFixture(ctx, appDirectory, {
			harperBinPath: HARPER_BIN,
			config: {
				threads: { count: 1 },
				analytics: { aggregatePeriod: -1 },
				logging: { level: 'warn' },
				applications: { lockdown: mode },
			},
		});
		const url = `${ctx.harper.httpURL}/LockdownBench?iterations=${values.iterations}&rounds=${values.rounds}`;
		const authorization = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(url, {
					headers: { Authorization: authorization },
					signal: AbortSignal.timeout(120_000),
				});
				if (response.status === 200) return (await response.json()) as BenchResult;
				await response.body?.cancel();
			} catch {}
			await delay(250);
		}
		throw new Error(`LockdownBench never answered under lockdown: ${mode}`);
	} finally {
		await teardownHarper(ctx);
		await rm(fixtureParent, { recursive: true, force: true });
	}
}

const results = new Map<string, BenchResult>();
for (const mode of modes) {
	results.set(mode, await measure(mode));
	console.error(`measured ${mode}`);
}

const baseline = results.get('none');
if (!baseline) console.error('no `none` run in --modes, so no ratios');
const operations = Object.keys(results.values().next().value.nanoseconds);
console.log(`node ${process.version}; best of ${values.rounds} rounds x ${values.iterations} iterations, ns/op`);
console.log(['mode'.padEnd(20), 'sealed', 'frozen', ...operations.map((name) => name.padStart(16))].join(' '));
for (const [mode, result] of results) {
	console.log(
		[
			mode.padEnd(20),
			String(result.sealed).padEnd(6),
			String(result.frozen).padEnd(6),
			...operations.map((name) => result.nanoseconds[name].toFixed(1).padStart(16)),
		].join(' ')
	);
}
for (const [mode, result] of results) {
	for (const name of operations) {
		const ratio = baseline
			? ` ratio_vs_none=${(result.nanoseconds[name] / baseline.nanoseconds[name]).toFixed(2)}`
			: '';
		console.log(`LOCKDOWN_RESULT mode=${mode} op=${name} ns_per_op=${result.nanoseconds[name].toFixed(1)}${ratio}`);
	}
}
