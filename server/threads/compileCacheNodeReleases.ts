/**
 * The first release on each Node line whose compile cache frees an entry's bytes once V8 has accepted them. Before
 * that, every thread keeps all of its entries until it exits, about 7 MiB of RSS per Harper thread, so Harper enables
 * the cache by default only on these releases. A line missing from the table stays off.
 */
export const COMPILE_CACHE_FREES_ACCEPTED_ENTRIES: Record<number, string> = {};

export function nodeFreesAcceptedCompileCacheEntries(version: string = process.version): boolean {
	const running = parseVersion(version);
	const minimum = running && COMPILE_CACHE_FREES_ACCEPTED_ENTRIES[running[0]];
	if (!minimum) return false;
	const required = parseVersion(minimum);
	if (!required) return false;
	for (let i = 0; i < 3; i++) {
		if (running[i] !== required[i]) return running[i] > required[i];
	}
	return true;
}

function parseVersion(version: string): [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
