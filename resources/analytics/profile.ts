/**
 * This module is responsible for profiling threads so we can determine how much CPU usage can be attributed
 * to user code, harper code, and individual "hot" functions
 */
import { Session } from 'node:inspector/promises';
import { recordAction } from './write.ts';
import { get as envGet, getHdbBasePath } from '../../utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.js';
import { PACKAGE_ROOT } from '../../utility/packageUtils.js';
import { pathToFileURL } from 'node:url';
import * as log from '../../utility/logging/harper_logger.js';

const basePath = getHdbBasePath();
export const userCodeFolders = basePath ? [pathToFileURL(basePath).toString()] : [];
if (process.env.RUN_HDB_APP) userCodeFolders.push(pathToFileURL(process.env.RUN_HDB_APP).toString());

const SAMPLING_INTERVAL_IN_MICROSECONDS = 1000;
const session = new Session();
// We create an inspector session with ourself
// TODO: Running this on the thread itself can be problematic because the profiler snapshots are expensive
//  (calling Profiler.stop and getting the large block of JSON and parsing it). This can take a 20ms or more
//  which can have a noticeable impact on latency for users. I would like to move this all to the main thread
//  and we would probably need to connect to all the child threads with WebSockets.
session.connect();
(async () => {
	if (userCodeFolders.length === 0) return;
	// start the profiler
	await session.post('Profiler.enable');
	await session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_IN_MICROSECONDS });
	await session.post('Profiler.start');
	const PROFILE_PERIOD = (envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) || 60) * 1000;
	setTimeout(() => {
		captureProfile(PROFILE_PERIOD);
	}, PROFILE_PERIOD).unref();
})();

export async function captureProfile(delayToNextCapture?: number): Promise<void> {
	const HARPER_URL = pathToFileURL(PACKAGE_ROOT).toString();
	const nodeById = new Map();
	const hitCountThreshold = 100;
	const secondsPerHit = SAMPLING_INTERVAL_IN_MICROSECONDS / 1_000_000;
	let totalUserCount = 0;
	let totalHarperCount = 0;
	try {
		const { profile } = await session.post('Profiler.stop');
		for (const node of profile.nodes) {
			nodeById.set(node.id, node);
		}
		for (const node of profile.nodes) {
			getUserHitCount(node);
		}
		recordAction(totalHarperCount * secondsPerHit, 'cpu-usage', 'harper');
		recordAction(totalUserCount * secondsPerHit, 'cpu-usage', 'user');
	} catch (error) {
		log.error?.('analytics profiler error:', error);
	} finally {
		// and start the profiler again
		await session.post('Profiler.start');
		if (delayToNextCapture) {
			setTimeout(() => {
				const PROFILE_PERIOD = (envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) || 60) * 1000;
				captureProfile(PROFILE_PERIOD);
			}, delayToNextCapture).unref();
		}
	}
	// this traverses the nodes and returns the number of sampling hits for the descendants that has been attributed
	// to harper or user code (execution of things like node internal modules or native code)
	function getUserHitCount(node: any): number {
		if (node.unassignedCount !== undefined) return node.unassignedCount; // already visited
		let unassignedCount = node.hitCount as number;
		if (node.children) {
			for (const child of node.children) {
				unassignedCount += getUserHitCount(nodeById.get(child));
			}
		}
		// if we can assign to user code or harper code, do so
		if (isUserCode(node)) {
			totalUserCount += unassignedCount;
			if (unassignedCount > hitCountThreshold) {
				recordAction(unassignedCount * secondsPerHit, 'cpu-usage', node.callFrame.url);
			}
			// assigned/attributed counts, nothing to return
			node.unassignedCount = 0;
			return 0;
		}
		if (isHarperCode(node)) {
			totalHarperCount += unassignedCount;
			if (unassignedCount > hitCountThreshold) {
				recordAction(unassignedCount * secondsPerHit, 'cpu-usage', node.callFrame.url);
			}
			// assigned/attributed counts, nothing to return
			node.unassignedCount = 0;
			return 0;
		}
		node.unassignedCount = unassignedCount;
		return unassignedCount;
	}
	function isHarperCode(node: any) {
		return node.callFrame?.url.startsWith(HARPER_URL);
	}
	function isUserCode(node: any) {
		if (userCodeFolders.some((userCodeFolder) => node.callFrame?.url.startsWith(userCodeFolder))) return true;
	}
}
