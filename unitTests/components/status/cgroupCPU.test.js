'use strict';

const assert = require('node:assert');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
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
		await rm(root, { recursive: true, force: true });
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
		const first = await readCgroupCPU(root, membership, 16, 16);
		assert.deepEqual(
			first.groups.map(({ capacity }) => capacity),
			[1, 2]
		);
		await group('tenant/worker', '100000 100000', 201000);
		await group('tenant', '200000 100000', 2002000);
		const second = await readCgroupCPU(root, membership, 16, 16);
		assert.equal(getCPUUtilization({ ...first, time: 0 }, { ...second, time: 1000 }), 100);
	});

	it('supports fractional quotas and caps quota capacity by available CPUs', async function () {
		await group('tenant/worker', '50000 100000', 0);
		assert.equal((await readCgroupCPU(root, membership, 4, 16)).groups[0].capacity, 0.5);
		await group('tenant/worker', '800000 100000', 0);
		assert.equal((await readCgroupCPU(root, membership, 4, 16)).groups[0].capacity, 4);
	});

	it('finds namespaced root accounting and affinity-only constraints', async function () {
		await group('', 'max 100000', 123);
		const sample = await readCgroupCPU(root, membership, 2, 16);
		assert.equal(sample.basis, 'cgroup affinity');
		assert.deepEqual(sample.groups, [{ path: root, usage: 123, capacity: 2 }]);
		await group('', '200000 100000', 456);
		assert.equal((await readCgroupCPU(root, membership, 16, 16)).basis, 'cgroup quota');
	});

	it('uses the host fallback only when no applicable constraint is present', async function () {
		await group('', 'max 100000', 0);
		assert.equal(await readCgroupCPU(root, membership, 16, 16), undefined);
		assert.equal(await readCgroupCPU(root, join(root, 'absent')), undefined);
		await writeFile(membership, '2:cpu:/legacy\n');
		assert.equal(await readCgroupCPU(root, membership, 2, 16), undefined);
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
