/**
 * A `corsAccessList` (`http.corsAccessList`, `operationsApi.network.corsAccessList`) entry is an exact origin, `*`,
 * or a single-label wildcard origin such as `https://*.app.example.com`. A wildcard covers exactly one DNS label in
 * place of the `*`, and the scheme, the rest of the host and the port must match exactly. It needs at least two
 * labels after the `*`, so no entry covers every name under a top-level domain. Any other entry with a `*` in it
 * matches nothing.
 */
type CompiledAccessList = { any: boolean; exact: Set<string>; wildcards: { prefix: string; suffix: string }[] };

const WILDCARD_ORIGIN = /^([a-z][a-z0-9+.-]*:\/\/)\*(\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?)$/i;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const compiledLists = new WeakMap<object, CompiledAccessList>();
const compiledEntries = new Map<string, CompiledAccessList>();

function compile(accessList: unknown[]): CompiledAccessList {
	const compiled: CompiledAccessList = { any: false, exact: new Set(), wildcards: [] };
	for (const entry of accessList) {
		if (typeof entry !== 'string') continue;
		if (entry === '*') compiled.any = true;
		else if (!entry.includes('*')) compiled.exact.add(entry);
		else {
			const wildcard = WILDCARD_ORIGIN.exec(entry);
			if (wildcard) compiled.wildcards.push({ prefix: wildcard[1].toLowerCase(), suffix: wildcard[2].toLowerCase() });
		}
	}
	return compiled;
}

/** Whether `origin` is allowed by `accessList`. A string is a list of one entry; anything else allows nothing. */
export function corsAccessListAllows(accessList: unknown, origin: string | undefined): boolean {
	if (typeof origin !== 'string') return false;
	let compiled: CompiledAccessList;
	if (typeof accessList === 'string') {
		compiled = compiledEntries.get(accessList);
		if (!compiled) compiledEntries.set(accessList, (compiled = compile([accessList])));
	} else if (!Array.isArray(accessList) || accessList.length === 0) return false;
	else {
		compiled = compiledLists.get(accessList);
		if (!compiled) compiledLists.set(accessList, (compiled = compile(accessList)));
	}
	if (compiled.any || compiled.exact.has(origin)) return true;
	if (compiled.wildcards.length === 0) return false;
	const lowered = origin.toLowerCase();
	return compiled.wildcards.some(
		({ prefix, suffix }) =>
			lowered.length > prefix.length + suffix.length &&
			lowered.startsWith(prefix) &&
			lowered.endsWith(suffix) &&
			LABEL.test(lowered.slice(prefix.length, lowered.length - suffix.length))
	);
}
