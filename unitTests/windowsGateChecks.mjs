// Split out of unitTests/windowsGate.mjs, which runs the gate on import and so cannot be
// loaded by a test.

// Anchored and last-match, so a line a test printed itself cannot stand in for the epilogue
// of a group that terminated before printing one. The anchor holds only against uncoloured
// output, which is why the gate runs mocha with --no-color.
const SUMMARY = /^\s*(\d+) passing\b/gm;

const DEFAULT_GROUP_TIMEOUT_MS = 600_000;
// setTimeout clamps anything outside 1..2^31-1 to 1ms, so an unguarded override that is empty,
// unparseable, negative, sub-millisecond, or huge would SIGKILL every group at spawn.
const MAX_TIMEOUT_MS = 2_147_483_647;

export function parsePassing(output) {
	return [...output.matchAll(SUMMARY)].at(-1)?.[1];
}

export function resolveTimeout(envValue) {
	const overrideMs = Number(envValue);
	return overrideMs >= 1 ? Math.min(Math.trunc(overrideMs), MAX_TIMEOUT_MS) : DEFAULT_GROUP_TIMEOUT_MS;
}
