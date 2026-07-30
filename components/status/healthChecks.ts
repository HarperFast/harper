/**
 * System Health Checks
 *
 * Periodic monitoring of system resources (disk, memory, CPU) that reports
 * status via the component status system. Health check statuses self-heal:
 * when the metric returns to normal, status reverts to healthy.
 *
 * Runs on the main thread only.
 */

import { componentStatusRegistry } from './registry.ts';
import { COMPONENT_STATUS_LEVELS } from './types.ts';

interface ThresholdConfig {
	warning: number;
	error: number;
}

interface HealthCheckConfig {
	enabled?: boolean;
	intervalSeconds?: number;
	thresholds?: {
		disk?: ThresholdConfig;
		memory?: ThresholdConfig;
		cpu?: ThresholdConfig;
	};
}

const DEFAULT_THRESHOLDS: Record<string, ThresholdConfig> = {
	disk: { warning: 80, error: 95 },
	memory: { warning: 80, error: 95 },
	cpu: { warning: 85, error: 95 },
};

const DEFAULT_INTERVAL_SECONDS = 60;

function setHealthStatus(name: string, percent: number, thresholds: ThresholdConfig, label: string) {
	const key = `system.${name}`;
	if (percent >= thresholds.error) {
		componentStatusRegistry.setStatus(
			key,
			COMPONENT_STATUS_LEVELS.ERROR,
			`${label} at ${percent.toFixed(1)}% utilization`,
			undefined,
			'health-check'
		);
	} else if (percent >= thresholds.warning) {
		componentStatusRegistry.setStatus(
			key,
			COMPONENT_STATUS_LEVELS.WARNING,
			`${label} at ${percent.toFixed(1)}% utilization`,
			undefined,
			'health-check'
		);
	} else {
		componentStatusRegistry.setStatus(
			key,
			COMPONENT_STATUS_LEVELS.HEALTHY,
			`${label} at ${percent.toFixed(1)}% utilization`,
			undefined,
			'health-check'
		);
	}
}

async function checkDisk(thresholds: ThresholdConfig) {
	try {
		const si = await import('systeminformation');
		const fsSizes = await si.fsSize();
		// Check the filesystem with the highest usage
		let worstPercent = 0;
		let worstMount = '';
		for (const fs of fsSizes) {
			if (fs.use > worstPercent) {
				worstPercent = fs.use;
				worstMount = fs.mount;
			}
		}
		if (worstPercent > 0) {
			setHealthStatus('disk', worstPercent, thresholds, `Disk (${worstMount})`);
		}
	} catch {
		// systeminformation may not be available in all environments
	}
}

async function checkMemory(thresholds: ThresholdConfig) {
	try {
		const si = await import('systeminformation');
		const mem = await si.mem();
		if (mem.total > 0) {
			const usedPercent = ((mem.total - mem.available) / mem.total) * 100;
			setHealthStatus('memory', usedPercent, thresholds, 'Memory');
		}
	} catch {
		// systeminformation may not be available in all environments
	}
}

async function checkCPU(thresholds: ThresholdConfig) {
	try {
		const si = await import('systeminformation');
		const load = await si.currentLoad();
		if (load.currentLoad !== undefined) {
			setHealthStatus('cpu', load.currentLoad, thresholds, 'CPU');
		}
	} catch {
		// systeminformation may not be available in all environments
	}
}

async function runChecks(thresholds: Record<string, ThresholdConfig>) {
	await Promise.all([checkDisk(thresholds.disk), checkMemory(thresholds.memory), checkCPU(thresholds.cpu)]);
}

export function startHealthChecks(config?: HealthCheckConfig) {
	if (config?.enabled === false) return;

	const thresholds = {
		disk: config?.thresholds?.disk || DEFAULT_THRESHOLDS.disk,
		memory: config?.thresholds?.memory || DEFAULT_THRESHOLDS.memory,
		cpu: config?.thresholds?.cpu || DEFAULT_THRESHOLDS.cpu,
	};
	const intervalMs = (config?.intervalSeconds || DEFAULT_INTERVAL_SECONDS) * 1000;

	// Run immediately
	runChecks(thresholds);

	// Then periodically
	const timer = setInterval(() => runChecks(thresholds), intervalMs);
	timer.unref();
}
