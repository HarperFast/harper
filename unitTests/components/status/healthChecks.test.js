'use strict';

const assert = require('node:assert');
const { mkdtemp, writeFile, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const env = require('#src/utility/environment/environmentManager');
require('#src/server/storageReclamation');
const { componentStatusRegistry } = require('#src/components/status/registry');
const {
	startHealthChecks,
	stopHealthChecks,
	readConstrainedMemoryUsage,
	withHealthCheckDeadline,
} = require('#src/components/status/healthChecks');
const { waitFor } = require('../../waitFor.js');
const { ENV_DIR_PATH } = require('../../perPidRoot.js');

async function runFreshProcess(script) {
	const result = spawnSync(
		process.execPath,
		['--require', resolve(__dirname, '../../mocha.init.js'), '--eval', script],
		{ cwd: resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 30000 }
	);
	if (result.pid) await rm(join(ENV_DIR_PATH, String(result.pid)), { recursive: true, force: true });
	assert.equal(result.status, 0, result.stdout + result.stderr);
}

describe('runtime health checks', function () {
	this.timeout(45000);
	let root;
	const previousRoot = env.get('rootPath');
	const previousStorage = env.get('storage_path');
	beforeEach(async function () {
		stopHealthChecks?.();
		componentStatusRegistry.reset();
		root = await mkdtemp(join(tmpdir(), 'harper-health-'));
		env.setProperty('rootPath', root);
		env.setProperty('storage_path', root);
	});
	afterEach(async function () {
		stopHealthChecks?.();
		componentStatusRegistry.reset();
		env.setProperty('rootPath', previousRoot);
		env.setProperty('storage_path', previousStorage);
		if (root) await rm(root, { recursive: true, force: true });
		root = undefined;
	});
	const quota = (usedBytes) =>
		writeFile(join(root, 'quota-status.json'), JSON.stringify({ usedBytes, quotaBytes: 100, updatedAt: Date.now() }));
	const disk = () => componentStatusRegistry.getStatus('system.disk');

	it('reports 96% quota usage as error and recovers when writable space returns', async function () {
		await quota(96);
		startHealthChecks({ intervalSeconds: 1 });
		await waitFor(() => disk()?.status === 'error' && disk().message.includes('96.0%'), 5000);
		assert.ok(disk().message.includes('quota'));
		await quota(40);
		await waitFor(() => disk()?.status === 'healthy' && disk().message.includes('40.0%'), 5000);
	});

	it('labels the accounting domain of the CPU status', async function () {
		await quota(40);
		startHealthChecks({ intervalSeconds: 1 });
		await waitFor(() => componentStatusRegistry.getStatus('system.cpu')?.message?.includes('%'), 5000);
		assert.match(
			componentStatusRegistry.getStatus('system.cpu').message,
			/^CPU \((host|cgroup quota|cgroup affinity)\)/
		);
	});

	it('merges partial thresholds and does not reconfigure an active poller on re-entry', async function () {
		await quota(85);
		startHealthChecks({ intervalSeconds: 1, thresholds: { disk: { warning: 90 } } });
		await waitFor(() => disk()?.status === 'healthy', 5000);
		startHealthChecks({ intervalSeconds: 1, thresholds: { disk: { warning: 50, error: 60 } } });
		await quota(86);
		await waitFor(() => disk()?.message.includes('86.0%'), 5000);
		assert.equal(disk().status, 'healthy');
	});

	it('uses registered configuration keys when no explicit config is passed', async function () {
		await quota(75);
		await runFreshProcess(`
			const env = require('#src/utility/environment/environmentManager');
			require('#src/server/storageReclamation');
			const { startHealthChecks, stopHealthChecks } = require('#src/components/status/healthChecks');
			const { componentStatusRegistry } = require('#src/components/status/registry');
			const { waitFor } = require('./unitTests/waitFor.js');
			env.setProperty('rootPath', ${JSON.stringify(root)});
			env.setProperty('storage_path', ${JSON.stringify(root)});
			env.setProperty('status_healthChecks_enabled', true);
			env.setProperty('status_healthChecks_intervalSeconds', 1);
			env.setProperty('status_healthChecks_thresholds_disk_warning', 50);
			env.setProperty('status_healthChecks_thresholds_disk_error', 70);
			startHealthChecks();
			waitFor(() => {
				const disk = componentStatusRegistry.getStatus('system.disk');
				return disk?.status === 'error' && disk.message.includes('75.0%');
			}, 7500).then(() => {
				stopHealthChecks();
				process.exit(0);
			}, error => { console.error(error); process.exit(1); });
		`);
	});

	it('does not start OS polling merely by importing status in a fresh process', async function () {
		const script = `
			require('#src/components/status/internal');
			const { componentStatusRegistry } = require('#src/components/status/registry');
			setTimeout(() => {
				const names = [...componentStatusRegistry.getAllStatuses().keys()].filter(name => /^system\\.(disk|memory|cpu)$/.test(name));
				console.log(JSON.stringify(names));
				process.exit(names.length ? 1 : 0);
			}, 1000);
		`;
		await runFreshProcess(script);
	});

	it('starts no polling when disabled or when the status module is merely imported', async function () {
		require('#src/components/status/internal');
		startHealthChecks({ enabled: false, intervalSeconds: 1 });
		await delay(1200);
		assert.equal(disk(), undefined);
		assert.equal(componentStatusRegistry.getStatus('system.memory'), undefined);
		assert.equal(componentStatusRegistry.getStatus('system.cpu'), undefined);
	});

	it('does not publish a delayed sample after stop', async function () {
		await quota(96);
		startHealthChecks({ intervalSeconds: 1 });
		stopHealthChecks();
		await delay(1200);
		assert.equal(disk(), undefined);
	});

	it('replaces a previous error with a warning when its metric becomes unavailable', async function () {
		await quota(96);
		startHealthChecks({ intervalSeconds: 1 });
		await waitFor(() => disk()?.status === 'error', 5000);
		await rm(join(root, 'quota-status.json'));
		env.setProperty('storage_path', join(root, 'missing-storage'));
		await waitFor(() => disk()?.status === 'warning' && disk().message === 'Health check unavailable', 5000);
	});

	it('bounds a genuinely pending promise and accepts subsequent samples', async function () {
		await Promise.all([
			assert.rejects(withHealthCheckDeadline(new Promise(() => {}), 20), /Health check timed out/),
			delay(30),
		]);
		assert.equal(await withHealthCheckDeadline(Promise.resolve(42), 20), 42);
	});

	it('subtracts reclaimable file cache from constrained memory and detects real pressure', async function () {
		const group = join(root, 'tenant');
		await mkdir(group);
		const membership = join(root, 'membership');
		await writeFile(membership, '0::/tenant\n');
		await writeFile(join(group, 'memory.max'), '100\n');
		await writeFile(join(group, 'memory.current'), '99\n');
		await writeFile(join(group, 'memory.stat'), 'anon 49\ninactive_file 50\n');
		assert.deepEqual(await readConstrainedMemoryUsage(100, root, membership), {
			used: 49,
			basis: 'cgroup working set',
		});
		await writeFile(join(group, 'memory.stat'), 'inactive_file\t3  \r\n');
		assert.equal((await readConstrainedMemoryUsage(100, root, membership)).used, 96);
	});

	it('finds a namespaced cgroup at the mount root and honours memory.high', async function () {
		const membership = join(root, 'membership');
		await writeFile(membership, '0::/unmapped/tenant\n');
		await writeFile(join(root, 'memory.max'), '1000\n');
		await writeFile(join(root, 'memory.high'), '100\n');
		await writeFile(join(root, 'memory.current'), '95\n');
		await writeFile(join(root, 'memory.stat'), 'inactive_file 0\n');
		assert.equal((await readConstrainedMemoryUsage(100, root, membership)).used, 95);
	});

	it('labels the process-RSS fallback rather than claiming host usage is container usage', async function () {
		const sample = await readConstrainedMemoryUsage(100, root, join(root, 'missing-membership'));
		assert.equal(sample.basis, 'process RSS');
		assert.ok(sample.used > 0);
	});
});
