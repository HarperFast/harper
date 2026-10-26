'use strict';

const assert = require('node:assert');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { createCPUReader } = require('#src/components/status/healthChecks');
const { cgroupPaths, readCgroupCPU, getCPUUtilization } = require('#src/components/status/cgroup');

describe('cgroup CPU accounting', function () {
	let root;
	let membership;
	beforeEach(async function () {
		root = await mkdtemp(join(tmpdir(), 'harper-cpu-'));
		membership = join(root, 'membership');
		await writeFile(membership, '0::/tenant/worker\n');
	});
	afterEach(async function () {
		if (root) await rm(root, { recursive: true, force: true });
	});
	async function group(relative, quota, usage) {
		const path = join(root, relative);
		await mkdir(path, { recursive: true });
		await writeFile(join(path, 'cpu.max'), `${quota}\n`);
		await writeFile(join(path, 'cpu.stat'), `usage_usec ${usage}\nuser_usec 0\n`);
		return path;
	}

	it('pairs each quota with its own usage and detects a saturated shared ancestor', async function () {
		await group('tenant/worker', '100000 100000', 1000);
		await group('tenant', '200000 100000', 2000);
		const first = await readCgroupCPU(root, membership, 16);
		assert.deepEqual(
			first.groups.map(({ capacity }) => capacity),
			[1, 2]
		);
		await group('tenant/worker', '100000 100000', 201000);
		await group('tenant', '200000 100000', 2002000);
		const second = await readCgroupCPU(root, membership, 16);
		assert.equal(getCPUUtilization({ ...first, time: 0 }, { ...second, time: 1000 }), 100);
	});

	it('does not divide shared-parent usage by a narrow child affinity', async function () {
		if (
			process.platform !== 'linux' ||
			spawnSync('taskset', ['--version'], { timeout: 5000, killSignal: 'SIGKILL' }).error?.code === 'ENOENT'
		)
			this.skip();
		const allowed = readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)[1];
		const [first, last = first] = allowed.split(',')[0].split('-').map(Number);
		const mask = first < last ? `${first},${first + 1}` : String(first);
		const allowedCount = allowed.split(',').reduce((count, range) => {
			const [start, end = start] = range.split('-').map(Number);
			return count + end - start + 1;
		}, 0);
		const parentCapacity = Math.min(8, cpus().length, allowedCount);
		const child = await group('tenant/worker', 'max 100000', 0);
		const parent = await group('tenant', '800000 100000', 0);
		await writeFile(join(child, 'cpuset.cpus.effective'), mask);
		await writeFile(join(parent, 'cpuset.cpus.effective'), allowed);
		const script = `
			const assert = require('node:assert');
			const { writeFile } = require('node:fs/promises');
			const { readCgroupCPU, getCPUUtilization } = require('#src/components/status/cgroup');
			(async () => {
				const previous = await readCgroupCPU(process.argv[1], process.argv[2]);
				await writeFile(process.argv[3], 'usage_usec ${parentCapacity * 375000}\\n');
				const current = await readCgroupCPU(process.argv[1], process.argv[2]);
				assert.equal(getCPUUtilization({ ...previous, time: 0 }, { ...current, time: 1000 }), 37.5);
			})().catch(error => { console.error(error); process.exitCode = 1; });
		`;
		const result = spawnSync(
			'taskset',
			['--cpu-list', mask, process.execPath, '--eval', script, root, membership, join(parent, 'cpu.stat')],
			{ encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' }
		);
		assert.equal(result.status, 0, result.stdout + result.stderr);
	});

	it('supports fractional quotas and caps quota capacity by available CPUs', async function () {
		await group('tenant/worker', '50000 100000', 0);
		assert.equal((await readCgroupCPU(root, membership, 4)).groups[0].capacity, 0.5);
		await group('tenant/worker', '800000 100000', 0);
		assert.equal((await readCgroupCPU(root, membership, 4)).groups[0].capacity, 4);
	});

	it('finds namespaced root accounting and affinity-only constraints', async function () {
		await group('', 'max 100000', 123);
		await writeFile(join(root, 'cpuset.cpus.effective'), '0-1');
		const sample = await readCgroupCPU(root, membership, 16);
		assert.equal(sample.basis, 'cgroup affinity');
		assert.deepEqual(sample.groups, [{ path: root, usage: 123, capacity: 2 }]);
		await group('', '200000 100000', 456);
		assert.equal((await readCgroupCPU(root, membership, 16)).basis, 'cgroup quota');
	});

	it('counts CPU-set ranges without expanding them and rejects overlapping sets', async function () {
		const path = await group('tenant/worker', 'max 100000', 0);
		await writeFile(join(path, 'cpuset.cpus.effective'), '0-1,4,6-7');
		assert.equal((await readCgroupCPU(root, membership, 16)).groups[0].capacity, 5);
		for (const invalid of ['', '0-1,1-2', '4-2', 'invalid']) {
			await writeFile(join(path, 'cpuset.cpus.effective'), invalid);
			await assert.rejects(readCgroupCPU(root, membership), /CPU set/);
		}
	});

	it('uses the host fallback only when no applicable constraint is present', async function () {
		await group('', 'max 100000', 0);
		assert.equal(await readCgroupCPU(root, membership, 16), undefined);
		assert.equal(await readCgroupCPU(root, join(root, 'absent')), undefined);
		await writeFile(membership, '2:cpu:/legacy\n');
		assert.equal(await readCgroupCPU(root, membership, 16), undefined);
	});

	it('rejects corrupt quota or usage instead of claiming a healthy sample', async function () {
		await group('tenant/worker', '0 100000', 0);
		await assert.rejects(readCgroupCPU(root, membership), /CPU quota/);
		const path = await group('tenant/worker', '100000 100000', 0);
		await writeFile(join(path, 'cpu.stat'), 'user_usec 123\n');
		await assert.rejects(readCgroupCPU(root, membership), /CPU usage/);
	});

	it('normalizes the interval and re-primes after reset, quota changes or migration', function () {
		const snapshot = (time, usage, capacity = 0.5, path = 'tenant') => ({
			time,
			basis: 'cgroup quota',
			groups: [{ path, usage, capacity }],
		});
		assert.equal(getCPUUtilization(snapshot(1000, 100), snapshot(3000, 750100)), 75);
		assert.equal(getCPUUtilization(snapshot(0, 0), snapshot(1000, 1000000)), 100);
		assert.equal(getCPUUtilization(snapshot(0, 10), snapshot(1000, 0)), undefined);
		assert.equal(getCPUUtilization(snapshot(0, 0), snapshot(1000, 100, 1)), undefined);
		assert.equal(getCPUUtilization(snapshot(0, 0), snapshot(1000, 100, 0.5, 'other')), undefined);
		assert.equal(getCPUUtilization(snapshot(0, 0), snapshot(0, 100)), undefined);
	});

	it('the production reader measures successive cycles and re-primes changed accounting', async function () {
		await group('tenant/worker', '100000 100000', 0);
		const read = createCPUReader(root, membership);
		assert.deepEqual(await read(), { percent: 0, label: 'CPU (cgroup quota)' });
		await group('tenant/worker', '100000 100000', 1_000_000_000_000);
		assert.equal((await read()).percent, 100);
		assert.equal((await read()).percent, 0);
		await group('tenant/worker', '50000 100000', 0);
		assert.equal((await read()).percent, 0);
	});

	it('the production reader labels its host fallback', async function () {
		const metric = await createCPUReader(root, join(root, 'absent'))();
		assert.equal(metric.label, 'CPU (host)');
		assert.ok(Number.isFinite(metric.percent));
	});

	it('keeps membership traversal inside the supplied mount', async function () {
		await writeFile(membership, '0::/../../outside\n');
		assert.deepEqual(await cgroupPaths(root, membership), [root]);
	});
});
