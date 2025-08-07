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

const session = new Session();
// We create an inspector session with ourself
// TODO: Running this on the thread itself can be problematic because the profiler snapshots are expensive
//  (calling Profiler.stop and getting the large block of JSON and parsing it). This can take a 20ms or more
//  which can have a noticeable impact on latency for users. I would like to move this all to the main thread
//  and we would probably need to connect to all the child threads with WebSockets.
session.connect();
(async () => {
	// start the profiler
	await session.post('Profiler.enable');
	await session.post('Profiler.setSamplingInterval', { interval: 1000 });
	await session.post('Profiler.start');
	const PROFILE_PERIOD = envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) * 1000;
	setInterval(profile, PROFILE_PERIOD).unref();
})();
// TODO: If a user starts with harperdb run ., we should add that path/url to the userCodeFolders
export const userCodeFolders = [pathToFileURL(getHdbBasePath()).toString()];
export async function profile() {
	const HARPER_URL = pathToFileURL(PACKAGE_ROOT).toString();
	const { profile } = await session.post('Profiler.stop');
	const hitCountThreshold = 100;
	const nodeById = new Map();
	let totalUserCount = 0,
		totalHarperCount = 0;
	for (const node of profile.nodes) {
		nodeById.set(node.id, node);
	}
	for (const node of profile.nodes) {
		getUserHitCount(node);
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
				recordAction(unassignedCount, 'cpu-usage', node.callFrame.url);
			}
			// assigned/attributed counts, nothing to return
			node.unassignedCount = 0;
			return 0;
		}
		if (isHarperCode(node)) {
			totalHarperCount += unassignedCount;
			if (unassignedCount > hitCountThreshold) {
				recordAction(unassignedCount, 'cpu-usage', node.callFrame.url);
			}
			// assigned/attributed counts, nothing to return
			node.unassignedCount = 0;
			return 0;
		}
		node.unassignedCount = unassignedCount;
		return unassignedCount;
	}
	function isHarperCode(node: any) {
		return node.callFrame?.url.startsWith(HARPER_URL));
	}
	function isUserCode(node: any) {
		if (userCodeFolders.some((userCodeFolder) => node.callFrame?.url.startsWith(userCodeFolder))) return true;
	}
	recordAction(totalHarperCount, 'cpu-usage', 'harper');
	recordAction(totalUserCount, 'cpu-usage', 'user');
	// and start the profiler again
	await session.post('Profiler.start');
}
