/**
 * This module is responsible for profiling threads so we can determine how much CPU usage can be attributed
 * to user code, harper code, and individual "hot" functions
 */
import { recordAction } from './write.ts';
import { get as envGet, getHdbBasePath } from '../../utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.js';
import { PACKAGE_ROOT } from '../../utility/packageUtils.js';
import { realpathSync } from 'node:fs';
import { time as timeProfiler } from '@datadog/pprof';
import * as log from '../../utility/logging/harper_logger.js';

type Profile = ReturnType<typeof timeProfiler.stop>;
type Sample = Profile['sample'][0];
const basePath = getHdbBasePath();
export const userCodeFolders = basePath ? [basePath] : [];
if (process.env.RUN_HDB_APP) userCodeFolders.push(realpathSync(process.env.RUN_HDB_APP));

let profilerTimer: NodeJS.Timer | undefined;
const SAMPLING_INTERVAL_IN_MICROSECONDS = 50000;
// TODO: Running this on the thread itself can be a problematic because the profiler snapshots are somewhat expensive
//  (calling timeProfiler.stop and getting the large block of JSON and parsing it). This can take a 5ms or more
//  which can have some impact on latency for users. However, the datadog profiler is much better than the node
//  profiler, so we'll keep this for now.
(async () => {
	if (userCodeFolders.length === 0) return;
	// start the profiler
	timeProfiler.start({ intervalMicros: SAMPLING_INTERVAL_IN_MICROSECONDS });
	const PROFILE_PERIOD = (envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) || 60) * 1000;
	if (PROFILE_PERIOD > 0) {
		profilerTimer = setTimeout(() => {
			captureProfile(PROFILE_PERIOD);
		}, PROFILE_PERIOD).unref();
	}
})();

export async function captureProfile(delayToNextCapture?: number): Promise<void> {
	clearTimeout(profilerTimer);
	const hitCountThreshold = 100;
	const secondsPerHit = SAMPLING_INTERVAL_IN_MICROSECONDS / 1_000_000;
	const locationById = new Map<number, any>();
	const fileNameById = new Map<number, any>();
	const samplesByLocationId = new Map<number, number>();
	let totalUserCount = 0;
	let totalHarperCount = 0;
	try {
		const profile = timeProfiler.stop(true);
		const strings = profile.stringTable.strings;
		for (let func of profile.function) {
			fileNameById.set(func.id as number, strings[func.filename as number]);
		}
		for (let location of profile.location) {
			locationById.set(location.id as number, location.line[0]);
		}

		for (const sample of profile.sample) {
			getUserHitCount(sample);
		}
		recordAction(totalHarperCount * secondsPerHit, 'cpu-usage', 'harper');
		recordAction(totalUserCount * secondsPerHit, 'cpu-usage', 'user');
		for (let [locationId, sampleCount] of samplesByLocationId) {
			if (sampleCount > hitCountThreshold) {
				const location = locationById.get(locationId);
				const locationName = fileNameById.get(location.functionId) + ':' + location.line;
				recordAction(sampleCount * secondsPerHit, 'cpu-usage', locationName);
			}
		}
	} catch (error) {
		log.error?.('analytics profiler error:', error);
	} finally {
		// and start the profiler again
		if (delayToNextCapture > 0) {
			profilerTimer = setTimeout(() => {
				const PROFILE_PERIOD = (envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) || 60) * 1000;
				captureProfile(PROFILE_PERIOD);
			}, delayToNextCapture).unref();
		} else {
			// somehow this can later get set to a negative number which causes big problems (high-frequency restarts of the profiler)
			log.info?.('Profiling disabled');
			timeProfiler.stop();
		}
	}
	// this traverses the nodes and returns the number of sampling hits for the sample and attributes it
	// to harper or user code (as opposed to execution of things like node internal modules or native code)
	function getUserHitCount(sample: Sample) {
		// if we can assign to user code or harper code, do so
		let recordedTopSample = false;
		for (let locationId of sample.locationId) {
			let fileName = fileNameById.get(locationById.get(locationId).functionId);
			if (userCodeFolders.some((userCodeFolder) => fileName.startsWith(userCodeFolder))) {
				// the call frame location is in user code
				const sampleCount = sample.value[0];
				totalUserCount += sampleCount;
				if (!recordedTopSample)
					samplesByLocationId.set(locationId, (samplesByLocationId.get(locationId) ?? 0) + sampleCount);
				return; // if the highest point in the call stack is in user code, we don't need to check the rest of the call stack, this "counts" as user execution
			}
			if (fileName.startsWith(PACKAGE_ROOT)) {
				const sampleCount = sample.value[0];
				totalHarperCount += sampleCount;
				if (!recordedTopSample) {
					samplesByLocationId.set(locationId, (samplesByLocationId.get(locationId) ?? 0) + sampleCount);
					recordedTopSample = true;
				}
			}
		}
	}
}
