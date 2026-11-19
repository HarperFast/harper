import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { cpus } from 'node:os';

export async function cgroupPaths(root = '/sys/fs/cgroup', membership = '/proc/self/cgroup'): Promise<string[]> {
	const group = (await readFile(membership, 'utf8'))
		.split('\n')
		.find((line) => line.startsWith('0::'))
		?.slice(3);
	if (group === undefined) return [];
	root = resolve(root);
	let path = resolve(root, `.${group}`);
	if (path !== root && !path.startsWith(root + sep)) path = root;
	const paths = [];
	for (;;) {
		paths.push(path);
		if (path === root) return paths;
		path = dirname(path);
	}
}

interface CPUGroup {
	path: string;
	usage: number;
	capacity: number;
}
export interface CPUSample {
	time: number;
	groups: CPUGroup[];
	basis: 'cgroup quota' | 'cgroup affinity';
}

async function optionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
	}
}

function cpuSetSize(text: string): number {
	let count = 0;
	let previous = -1;
	for (const part of text.trim().split(',')) {
		const match = part.match(/^(\d+)(?:-(\d+))?$/);
		if (!match) throw new Error('CPU set is unavailable');
		const start = Number(match[1]);
		const end = Number(match[2] ?? match[1]);
		if (!Number.isSafeInteger(end) || !(start > previous) || end < start) throw new Error('CPU set is unavailable');
		count += end - start + 1;
		previous = end;
	}
	if (!Number.isSafeInteger(count) || !(count > 0)) throw new Error('CPU set is unavailable');
	return count;
}

export async function readCgroupCPU(
	root = '/sys/fs/cgroup',
	membership = '/proc/self/cgroup',
	hostCPUs = cpus().length
): Promise<CPUSample | undefined> {
	let paths: string[];
	try {
		paths = await cgroupPaths(root, membership);
	} catch (error) {
		if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
		throw error;
	}
	const groups: CPUGroup[] = [];
	let hasQuota = false;
	for (const path of paths) {
		const [maximum, cpuSet] = await Promise.all([
			optionalFile(resolve(path, 'cpu.max')),
			optionalFile(resolve(path, 'cpuset.cpus.effective')),
		]);
		let quota = Infinity;
		if (maximum !== undefined) {
			const match = maximum.trim().match(/^(max|\d+)\s+(\d+)$/);
			if (
				!match ||
				!Number.isSafeInteger(Number(match[2])) ||
				!(Number(match[2]) > 0) ||
				(match[1] !== 'max' && (!Number.isSafeInteger(Number(match[1])) || !(Number(match[1]) > 0)))
			)
				throw new Error('CPU quota is unavailable');
			if (match[1] !== 'max') quota = Number(match[1]) / Number(match[2]);
		}
		const capacity = Math.min(quota, cpuSet === undefined ? hostCPUs : cpuSetSize(cpuSet), hostCPUs);
		if (!(capacity > 0)) throw new Error('CPU capacity is unavailable');
		if (!Number.isFinite(quota) && capacity === hostCPUs) continue;
		const stats = await readFile(resolve(path, 'cpu.stat'), 'utf8');
		const rawUsage = stats.match(/^usage_usec\s+(\d+)\s*$/m)?.[1];
		const usage = Number(rawUsage);
		if (rawUsage === undefined || !Number.isSafeInteger(usage)) throw new Error('CPU usage is unavailable');
		groups.push({ path, usage, capacity });
		hasQuota ||= Number.isFinite(quota);
	}
	if (groups.length) return { time: performance.now(), groups, basis: hasQuota ? 'cgroup quota' : 'cgroup affinity' };
}

export function getCPUUtilization(previous: CPUSample, current: CPUSample): number | undefined {
	const elapsed = (current.time - previous.time) * 1000;
	if (!(elapsed > 0) || current.basis !== previous.basis || current.groups.length !== previous.groups.length) return;
	let percent = 0;
	for (let i = 0; i < current.groups.length; i++) {
		const before = previous.groups[i];
		const after = current.groups[i];
		if (before.path !== after.path || before.capacity !== after.capacity || after.usage < before.usage) return;
		percent = Math.max(percent, ((after.usage - before.usage) / elapsed / after.capacity) * 100);
	}
	return Math.min(100, percent);
}
