import { readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads.js';
import { logger } from '../utility/logging/logger.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import * as envMgr from '../utility/environment/environmentManager.ts';
import { convertToMS } from '../utility/common_utils.ts';
envMgr.initSync();

const reclamationHandlers = new Map<
	string,
	{ priority: number; handler: (priority: number) => Promise<void> | void }[]
>();

const RECLAMATION_THRESHOLD = envMgr.get(CONFIG_PARAMS.STORAGE_RECLAMATION_THRESHOLD) ?? 0.4; // 40% remaining free space is the default
const RECLAMATION_INTERVAL = convertToMS(envMgr.get(CONFIG_PARAMS.STORAGE_RECLAMATION_INTERVAL)) || 3600000; // 1 hour is the default

// Written by host-manager every ~90s alongside the instance's hdb root
const QUOTA_STATUS_FILE = 'quota-status.json';
// Use statfs fallback if the file is older than this (host-manager outage, container start race, etc.)
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

// If a fresh quota-status.json exists (written by host-manager every ~90s), use quota-based ratio.
// Otherwise fall back to statfs for the registered path.
const defaultGetAvailableSpaceRatio = async (path: string): Promise<number> => {
	const status = await getQuotaStatus();
	if (status?.quotaBytes && Date.now() - status.updatedAt < QUOTA_STATUS_MAX_AGE_MS) {
		return Math.max(0, status.quotaBytes - status.usedBytes) / status.quotaBytes;
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
