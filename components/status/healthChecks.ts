/**
 * System Health Checks
 *
 * Periodic monitoring of system resources (disk, memory, CPU) that reports
 * status via the component status system. Health check statuses self-heal:
 * when the metric returns to normal, status reverts to healthy.
 *
 * Runs on the main thread only.
 */

import { totalmem } from 'node:os';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { getConfigPath } from '../../config/configUtils.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import { componentStatusRegistry } from './registry.ts';
import { COMPONENT_STATUS_LEVELS } from './types.ts';

type MetricName = 'disk' | 'memory' | 'cpu';
interface ThresholdConfig {
	warning: number;
	error: number;
}
interface HealthCheckConfig {
	enabled?: boolean;
	intervalSeconds?: number;
	thresholds?: Partial<Record<MetricName, Partial<ThresholdConfig>>>;
}
interface Metric {
	percent: number;
	label: string;
}
const DEFAULT_THRESHOLDS = {
	disk: { warning: 80, error: 95 },
	memory: { warning: 80, error: 95 },
	cpu: { warning: 85, error: 95 },
};
let stopCurrentChecks: (() => void) | undefined;

function readConfig(): HealthCheckConfig {
	return {
		enabled: env.get(CONFIG_PARAMS.STATUS_HEALTHCHECKS_ENABLED),
		intervalSeconds: env.get(CONFIG_PARAMS.STATUS_HEALTHCHECKS_INTERVALSECONDS),
		thresholds: {
			disk: {
				warning: env.get(CONFIG_PARAMS.STATUS_HEALTHCHECKS_THRESHOLDS_DISK_WARNING),
				error: env.get(CONFIG_PARAMS.STATUS_HEALTHCHECKS_THRESHOLDS_DISK_ERROR),
			},
			memory: {
				warning: env.get(CONFIG_PARAMS.STATUS_HEALTHCHECKS_THRESHOLDS_MEMORY_WARNING),
				error: env.get(CONFIG_PARAMS.STATUS_HEALTHCHECKS_THRESHOLDS_MEMORY_ERROR),
			},
			cpu: {
				warning: env.get(CONFIG_PARAMS.STATUS_HEALTHCHECKS_THRESHOLDS_CPU_WARNING),
				error: env.get(CONFIG_PARAMS.STATUS_HEALTHCHECKS_THRESHOLDS_CPU_ERROR),
			},
		},
	};
}

function normalizeThresholds(config: Partial<ThresholdConfig> | undefined, defaults: ThresholdConfig) {
	const valid = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100;
	const warning = valid(config?.warning) ? config.warning : defaults.warning;
	const error = valid(config?.error) ? config.error : defaults.error;
	return warning <= error ? { warning, error } : defaults;
}

function setHealthStatus(name: MetricName, metric: Metric, thresholds: ThresholdConfig) {
	const { percent, label } = metric;
	const status =
		percent >= thresholds.error
			? COMPONENT_STATUS_LEVELS.ERROR
			: percent >= thresholds.warning
				? COMPONENT_STATUS_LEVELS.WARNING
				: COMPONENT_STATUS_LEVELS.HEALTHY;
	componentStatusRegistry.setStatus(
		`system.${name}`,
		status,
		`${label} at ${percent.toFixed(1)}% utilization`,
		undefined,
		'health-check'
	);
}

async function checkDisk(): Promise<Metric> {
	const { getStorageSpaceStats } = await import('../../server/storageReclamation.ts');
	const path = getConfigPath(CONFIG_PARAMS.STORAGE_PATH) || getConfigPath(CONFIG_PARAMS.ROOTPATH);
	const { available, size, basis } = await getStorageSpaceStats(path);
	if (!(size > 0)) throw new Error('Disk capacity is unavailable');
	return { percent: ((size - available) / size) * 100, label: `Disk (${basis})` };
}

export async function readConstrainedMemoryUsage(
	limit: number,
	cgroupRoot = '/sys/fs/cgroup',
	membershipFile = '/proc/self/cgroup'
): Promise<{ used: number; basis: string }> {
	try {
		const membership = await readFile(membershipFile, 'utf8');
		const group = membership
			.split('\n')
			.find((line) => line.startsWith('0::'))
			?.slice(3);
		if (group !== undefined) {
			const root = resolve(cgroupRoot);
			let path = resolve(root, `.${group}`);
			if (path !== root && !path.startsWith(root + sep)) path = root;
			for (;;) {
				try {
					const [maximum, high, current, stats] = await Promise.all([
						readFile(resolve(path, 'memory.max'), 'utf8'),
						readFile(resolve(path, 'memory.high'), 'utf8').catch(() => 'max'),
						readFile(resolve(path, 'memory.current'), 'utf8'),
						readFile(resolve(path, 'memory.stat'), 'utf8'),
					]);
					const effectiveLimit = Math.min(Number(maximum) || Infinity, Number(high) || Infinity);
					const inactive = Number(stats.match(/^inactive_file[ \t]+(\d+)[ \t]*\r?$/m)?.[1]);
					const used = Number(current);
					// Reclaimable file cache must not make a database scan look like memory exhaustion.
					if (effectiveLimit === limit && Number.isFinite(used) && used >= 0 && Number.isFinite(inactive)) {
						return { used: Math.max(0, used - inactive), basis: 'cgroup working set' };
					}
				} catch {
					// A namespaced cgroup mount may expose the process's group at its root.
				}
				if (path === root) break;
				path = dirname(path);
			}
		}
	} catch {
		// Cgroup v1 and runtimes without readable cgroup accounting use process RSS.
	}
	return { used: process.memoryUsage.rss(), basis: 'process RSS' };
}

async function checkMemory(): Promise<Metric> {
	const total = totalmem();
	const constrained = process.constrainedMemory?.() || 0;
	if (constrained > 0 && constrained < total) {
		const { used, basis } = await readConstrainedMemoryUsage(constrained);
		return { percent: Math.min(100, (used / constrained) * 100), label: `Memory (${basis})` };
	}
	const si = await import('systeminformation');
	const mem = await si.mem();
	if (!(mem.total > 0)) throw new Error('Memory capacity is unavailable');
	return { percent: ((mem.total - mem.available) / mem.total) * 100, label: 'Memory' };
}

async function checkCPU(): Promise<Metric> {
	const si = await import('systeminformation');
	const load = await si.currentLoad();
	if (!Number.isFinite(load.currentLoad)) throw new Error('CPU usage is unavailable');
	return { percent: load.currentLoad, label: 'CPU' };
}

export async function withHealthCheckDeadline<T>(sample: Promise<T>, milliseconds: number): Promise<T> {
	let timer: NodeJS.Timeout;
	try {
		return await Promise.race([
			sample,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Health check timed out')), milliseconds);
				timer.unref();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export function stopHealthChecks() {
	stopCurrentChecks?.();
	stopCurrentChecks = undefined;
}

export function startHealthChecks(config?: HealthCheckConfig) {
	if (!isMainThread || stopCurrentChecks) return;
	let active = true;
	let timer: NodeJS.Timeout;
	stopCurrentChecks = () => {
		active = false;
		clearTimeout(timer);
	};
	config ??= readConfig();
	if (config.enabled === false) return;
	const thresholds = {
		disk: normalizeThresholds(config.thresholds?.disk, DEFAULT_THRESHOLDS.disk),
		memory: normalizeThresholds(config.thresholds?.memory, DEFAULT_THRESHOLDS.memory),
		cpu: normalizeThresholds(config.thresholds?.cpu, DEFAULT_THRESHOLDS.cpu),
	};
	const seconds = config.intervalSeconds;
	const intervalMs = Number.isFinite(seconds) && seconds >= 1 && seconds <= 2147483 ? seconds * 1000 : 60_000;
	const readers = { disk: checkDisk, memory: checkMemory, cpu: checkCPU };
	const pending = new Map<MetricName, Promise<Metric>>();
	async function sample(name: MetricName) {
		try {
			let reading = pending.get(name);
			if (!reading) {
				reading = readers[name]();
				pending.set(name, reading);
				void reading.then(
					() => pending.delete(name),
					() => pending.delete(name)
				);
			}
			const metric = await withHealthCheckDeadline(reading, Math.min(intervalMs, 30_000));
			if (active) setHealthStatus(name, metric, thresholds[name]);
		} catch (error) {
			if (active) {
				componentStatusRegistry.setStatus(
					`system.${name}`,
					COMPONENT_STATUS_LEVELS.WARNING,
					error.message === 'Health check timed out' ? 'Health check timed out' : 'Health check unavailable',
					undefined,
					'health-check'
				);
			}
		}
	}
	async function runChecks() {
		try {
			await Promise.all((Object.keys(readers) as MetricName[]).map(sample));
		} finally {
			if (active) timer = setTimeout(runChecks, intervalMs).unref();
		}
	}
	void runChecks();
}
