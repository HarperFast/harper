import { readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads.js';
import { logger } from '../utility/logging/logger.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import * as envMgr from '../utility/environment/environmentManager.ts';
import { convertToMS, convertToBytes } from '../utility/common_utils.ts';
envMgr.initSync();

const execFileAsync = promisify(execFile);

const reclamationHandlers = new Map<
	string,
	{ priority: number; handler: (priority: number) => Promise<void> | void }[]
>();

const RECLAMATION_THRESHOLD = envMgr.get(CONFIG_PARAMS.STORAGE_RECLAMATION_THRESHOLD) ?? 0.4; // 40% remaining free space is the default
const RECLAMATION_INTERVAL = convertToMS(envMgr.get(CONFIG_PARAMS.STORAGE_RECLAMATION_INTERVAL)) || 3600000; // 1 hour is the default
let QUOTA_SIZE_BYTES: number | undefined = convertToBytes(envMgr.get(CONFIG_PARAMS.STORAGE_QUOTASIZE));

// Written by host-manager every ~90s alongside the instance's hdb root
const QUOTA_STATUS_FILE = 'quota-status.json';
// Fall back to du if the file is older than this (host-manager outage, container start race, etc.)
const QUOTA_STATUS_MAX_AGE_MS = 5 * 60 * 1000;

export type QuotaStatusData = {
	usedBytes: number;
	quotaBytes?: number;
	updatedAt: number;
};

/**
 * Reads the quota-status.json file written by host-manager.
 * Returns undefined if the file is absent or malformed; does not apply age filtering.
 */
export async function getQuotaStatus(): Promise<QuotaStatusData | undefined> {
	const rootPath = envMgr.get(CONFIG_PARAMS.ROOTPATH);
	if (!rootPath) return undefined;
	try {
		const raw = await readFile(join(rootPath, QUOTA_STATUS_FILE), 'utf8');
		return JSON.parse(raw) as QuotaStatusData;
	} catch {
		return undefined;
	}
}

/**
 * Returns the disk block usage (bytes) for a directory path.
 * Uses `du -sb` which is a GNU extension available on all Linux deployments.
 * The `--` separator guards against paths that start with `-`.
 * Used as fallback when the quota-status file is absent or stale.
 */
export async function getDirectoryUsageBytes(dirPath: string): Promise<number> {
	const { stdout } = await execFileAsync('du', ['-sb', '--', dirPath]);
	return parseInt(stdout, 10);
}

/**
 * Register a handler to be called when storage free space is low and reclamation is needed. The callback is called
 * with the priority of the reclamation, which is the ratio of the threshold to the available space ratio. If space is
 * low, the priority will be greater than 1. If the reclamation is successful, the callback will be called again with
 * a priority of 0.
 * @param path
 * @param handler
 * @param skipThreadCheck
 */
export function onStorageReclamation(
	path: string,
	handler: (priority: number) => Promise<void> | void,
	skipThreadCheck?: boolean
) {
	if (skipThreadCheck || getWorkerIndex() === getWorkerCount() - 1) {
		// only run on one thread (last one)
		if (!path) {
			throw new Error('Storage reclamation path cannot be empty');
		}
		if (!reclamationHandlers.has(path)) {
			reclamationHandlers.set(path, []);
		}
		reclamationHandlers.get(path).push({ priority: 0, handler });
		if (!reclamationTimer) reclamationTimer = setTimeout(runReclamationHandlers, RECLAMATION_INTERVAL).unref();
	}
}
let reclamationTimer: NodeJS.Timeout;

// Checked at call time so QUOTA_SIZE_BYTES changes (via setQuotaSizeBytes) take effect immediately.
// In quota mode: prefer the host-manager-written quota-status file (O(1)); fall back to
// `du` on the rootPath (O(inodes)) when the file is absent or stale.
// The rootPath `du` covers ALL Harper files (logs, blobs, databases), matching how XFS
// user quotas count usage — as opposed to per-table paths registered for reclamation.
const defaultGetAvailableSpaceRatio = async (path: string): Promise<number> => {
	if (QUOTA_SIZE_BYTES) {
		const rootPath = envMgr.get(CONFIG_PARAMS.ROOTPATH);
		const status = await getQuotaStatus();
		const usedBytes =
			status && Date.now() - status.updatedAt < QUOTA_STATUS_MAX_AGE_MS
				? status.usedBytes
				: await getDirectoryUsageBytes(rootPath ?? path);
		return Math.max(0, QUOTA_SIZE_BYTES - usedBytes) / QUOTA_SIZE_BYTES;
	}
	const fsStats = await statfs(path);
	return fsStats.bavail / fsStats.blocks;
};
let getAvailableSpaceRatio: (path: string) => Promise<number> = defaultGetAvailableSpaceRatio;

/**
 * Run the registered reclamation handlers, if any disk drives are below the threshold
 */
export async function runReclamationHandlers() {
	for (const [path, handlers] of reclamationHandlers) {
		try {
			const availableRatio = await getAvailableSpaceRatio(path);
			const priority = RECLAMATION_THRESHOLD / availableRatio;
			for (const entry of handlers) {
				const { priority: previousPriority, handler } = entry;
				entry.priority = priority;
				if (priority > 1 || previousPriority > 1) {
					const resolution = handler(priority > 1 ? priority : 0);
					if (resolution) {
						// if the handler returns a promise, wait for it, otherwise it is probably not doing anything worth logging
						logger.info?.(`Running storage reclamation handler for ${path} with priority ${priority}`);
						await resolution;
					}
				}
			}
		} catch (e) {
			logger.error?.('Error running storage reclamation handlers', e);
		}
	}
	reclamationTimer = setTimeout(runReclamationHandlers, RECLAMATION_INTERVAL).unref();
}

/**
 * Set the function used to get the available space ratio (for testing and backfill for Node v16)
 * @param newGetter
 */
export function setAvailableSpaceRatioGetter(newGetter?: (path: string) => Promise<number>) {
	getAvailableSpaceRatio = newGetter ?? defaultGetAvailableSpaceRatio;
}

/**
 * Override the quota size in bytes (for testing only).
 */
export function setQuotaSizeBytes(n: number | undefined): void {
	QUOTA_SIZE_BYTES = n;
}

/**
 * Returns which basis is used for free-space calculations: 'quota' when storage_quotaSize is
 * configured, 'filesystem' otherwise.
 */
export function getFreeSpaceBasis(): 'quota' | 'filesystem' {
	return QUOTA_SIZE_BYTES ? 'quota' : 'filesystem';
}

/**
 * Returns quota config info when storage_quotaSize is configured, undefined otherwise.
 */
export function getQuotaInfo(): { quotaSizeBytes: number } | undefined {
	return QUOTA_SIZE_BYTES ? { quotaSizeBytes: QUOTA_SIZE_BYTES } : undefined;
}
