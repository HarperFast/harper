/*
 * The two pure decisions the Windows gate makes about a finished group, kept out of
 * unitTests/windowsGate.mjs because that file runs the whole gate on import and so cannot
 * be loaded by a test. Both encode a failure mode that reads as a green gate, which is why
 * they are worth locking: see unitTests/buildTools/windowsGate.test.mjs.
 */

// Anchored and last-match, so a test logging its own "N passing" line cannot stand in for
// the epilogue on a group that terminated before printing one. The anchor only holds
// against uncoloured output, which is why the gate runs mocha with --no-color.
const SUMMARY = /^\s*(\d+) passing\b/gm;

const DEFAULT_GROUP_TIMEOUT_MS = 600_000;
// setTimeout clamps anything outside 1..2^31-1 to 1ms, so an unguarded override that is empty,
// unparseable, negative, sub-millisecond, or huge would SIGKILL every group at spawn.
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The last line-anchored mocha epilogue count in `output`, or undefined if it printed none. */
export function parsePassing(output) {
	return [...output.matchAll(SUMMARY)].at(-1)?.[1];
}

/** A raw HARPER_WINDOWS_GATE_GROUP_TIMEOUT_MS value as an integer setTimeout will not clamp. */
export function resolveTimeout(envValue) {
	const overrideMs = Number(envValue);
	return overrideMs >= 1 ? Math.min(Math.trunc(overrideMs), MAX_TIMEOUT_MS) : DEFAULT_GROUP_TIMEOUT_MS;
}
