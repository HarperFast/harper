import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { availableParallelism, cpus } from 'node:os';

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

export async function readCgroupCPU(
	root = '/sys/fs/cgroup',
	membership = '/proc/self/cgroup',
	parallelism = availableParallelism(),
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
	let affinityGroup: CPUGroup;
	for (const path of paths) {
		let maximum: string;
		try {
			maximum = await readFile(resolve(path, 'cpu.max'), 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
			throw error;
		}
		const match = maximum.trim().match(/^(max|\d+)\s+(\d+)$/);
		if (
			!match ||
			!Number.isSafeInteger(Number(match[2])) ||
			!(Number(match[2]) > 0) ||
			(match[1] !== 'max' && (!Number.isSafeInteger(Number(match[1])) || !(Number(match[1]) > 0)))
		)
			throw new Error('CPU quota is unavailable');
		const quota = match[1] === 'max' ? Infinity : Number(match[1]) / Number(match[2]);
		if (!Number.isFinite(quota) && (affinityGroup || !(parallelism < hostCPUs))) continue;
		const stats = await readFile(resolve(path, 'cpu.stat'), 'utf8');
		const rawUsage = stats.match(/^usage_usec\s+(\d+)\s*$/m)?.[1];
		const usage = Number(rawUsage);
		if (rawUsage === undefined || !Number.isSafeInteger(usage)) throw new Error('CPU usage is unavailable');
		const group = { path, usage, capacity: Math.min(quota, parallelism) };
		if (Number.isFinite(quota)) groups.push(group);
		else affinityGroup ??= group;
	}
	if (groups.length) return { time: performance.now(), groups, basis: 'cgroup quota' };
	if (affinityGroup) return { time: performance.now(), groups: [affinityGroup], basis: 'cgroup affinity' };
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
