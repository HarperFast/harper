import { statfs } from 'node:fs/promises';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads';
import logger from '../utility/logging/logger';
import { CONFIG_PARAMS } from '../utility/hdbTerms';
import env_mgr from '../utility/environment/environmentManager';
import { convertToMS } from '../utility/common_utils';
env_mgr.initSync();
const reclamationHandlers = new Map<
	string,
	{ priority: number; handler: (priority: number) => Promise<void> | void }[]
>();

const RECLAMATION_THRESHOLD = env_mgr.get(CONFIG_PARAMS.STORAGE_RECLAMATION_THRESHOLD) ?? 0.4; // 40% remaining free space is the default
const RECLAMATION_INTERVAL = convertToMS(env_mgr.get(CONFIG_PARAMS.STORAGE_RECLAMATION_INTERVAL)) || 3600000; // 1 hour is the default
/**
 * Register a handler to be called when storage free space is low and reclamation is needed. The callback is called
 * with the priority of the reclamation, which is the ratio of the threshold to the available space ratio. If space is
 * low, the priority will be greater than 1. If the reclamation is successful, the callback will be called again with
 * a priority of 0.
 * @param path
 * @param handler
 */
export function onStorageReclamation(
	path: string,
	handler: (priority: number) => Promise<void> | void,
	skipThreadCheck?: boolean
) {
	if (skipThreadCheck || getWorkerIndex() === getWorkerCount() - 1) {
		// only run on one thread (last one)
		if (!reclamationHandlers.has(path)) {
			reclamationHandlers.set(path, []);
		}
		reclamationHandlers.get(path).push({ priority: 0, handler });
		if (!reclamationTimer) reclamationTimer = setTimeout(runReclamationHandlers, RECLAMATION_INTERVAL).unref();
	}
}
let reclamationTimer: NodeJS.Timeout;
const defaultGetAvailableSpaceRatio = async (path: string): Promise<number> => {
	if (statfs) {
		const fsStats = await statfs(path);
		return fsStats.bavail / fsStats.blocks;
	} else {
		return new Promise((resolve, reject) => {
			import('hdd-space').then((hddSpace) => {
				hddSpace.default((space: any) => {
					for (const volume of space.parts) {
						if (path.startsWith(volume.place)) return resolve(volume.free / volume.size);
					}
					return resolve(1);
				});
			});
		});
	}
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
