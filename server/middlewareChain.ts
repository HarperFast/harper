export type HttpEntry = {
	listener: Function;
	port: number | string;
	name?: string;
	before?: string;
	after?: string;
	urlPath?: string;
	host?: string;
};

/**
 * Topological sort of middleware entries respecting `before`/`after` constraints.
 * Uses the original registration index as a tiebreaker so config order is preserved
 * when there are no constraints between two entries.
 *
 * `before: 'X'` → this entry must run before the FIRST entry named X.
 * `after: 'X'`  → this entry must run after the LAST entry named X.
 *
 * @param onCycle - called when a cycle is detected; entries are returned unsorted.
 */
export function topoSort(entries: HttpEntry[], onCycle?: () => void): HttpEntry[] {
	const n = entries.length;
	if (n <= 1) return entries;

	// Map name → first and last index (for before/after semantics)
	const nameToFirst = new Map<string, number>();
	const nameToLast = new Map<string, number>();
	for (let i = 0; i < n; i++) {
		const name = entries[i].name;
		if (name) {
			if (!nameToFirst.has(name)) nameToFirst.set(name, i);
			nameToLast.set(name, i);
		}
	}

	// successors[i] = list of indices that must come after i
	const successors: number[][] = Array.from({ length: n }, () => []);
	const inDegree = new Int32Array(n);
	const addEdge = (from: number, to: number) => {
		successors[from].push(to);
		inDegree[to]++;
	};

	for (let i = 0; i < n; i++) {
		const { before, after } = entries[i];
		if (before) {
			const j = nameToFirst.get(before);
			if (j !== undefined && j !== i) addEdge(i, j);
		}
		if (after) {
			const j = nameToLast.get(after);
			if (j !== undefined && j !== i) addEdge(j, i);
		}
	}

	// Kahn's algorithm; use original index as tiebreaker to preserve registration/config order
	const ready: number[] = [];
	for (let i = 0; i < n; i++) {
		if (inDegree[i] === 0) ready.push(i);
	}

	const sorted: HttpEntry[] = [];
	while (ready.length > 0) {
		const i = ready.shift()!;
		sorted.push(entries[i]);
		for (const j of successors[i]) {
			if (--inDegree[j] === 0) {
				// Binary-insert to keep ready sorted by original index
				let lo = 0,
					hi = ready.length;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					if (ready[mid] < j) lo = mid + 1;
					else hi = mid;
				}
				ready.splice(lo, 0, j);
			}
		}
	}

	if (sorted.length !== n) {
		onCycle?.();
		return entries;
	}
	return sorted;
}

/**
 * Builds a linear middleware chain from a sorted array of entries.
 * The first entry in `sorted` is the outermost (called first).
 * `fallback` is invoked when all entries call next() without handling the request.
 */
export function buildLinearChain(sorted: HttpEntry[], fallback: Function): Function {
	let next = fallback;
	for (let i = sorted.length; i > 0; ) {
		const { listener } = sorted[--i];
		const callback = next;
		next = (...args: any[]) => listener(...args, callback);
	}
	return next;
}

/**
 * Resolves transitive `after` dependencies for a set of entries.
 * If entry A says `after: 'auth'` and auth is in `nameToEntry` but not in `entries`,
 * auth is pulled into the result so that the ordering constraint can be satisfied.
 * `before` constraints do NOT pull in entries — they only affect ordering.
 */
export function resolveDeps(entries: HttpEntry[], nameToEntry: Map<string, HttpEntry>): HttpEntry[] {
	const included = new Set(entries);
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of [...included]) {
			if (entry.after) {
				const dep = nameToEntry.get(entry.after);
				if (dep && !included.has(dep)) {
					included.add(dep);
					changed = true;
				}
			}
		}
	}
	return [...included];
}

/**
 * Normalizes a urlPath by stripping a single trailing slash (except for the root '/').
 * '/api' and '/api/' are treated equivalently for routing/matching.
 */
export function normalizeUrlPath(urlPath: string | undefined): string | undefined {
	if (!urlPath || urlPath.length <= 1) return urlPath;
	return urlPath.endsWith('/') ? urlPath.slice(0, -1) : urlPath;
}

/**
 * Returns true when `request` satisfies the route's host and urlPath constraints.
 * urlPath matching is prefix-based and segment-boundary-aware:
 *   '/api' matches '/api' and '/api/foo' but NOT '/api2'.
 * Trailing slashes on `route.urlPath` are ignored.
 */
export function matchesRoute(request: any, route: { host?: string; urlPath?: string }): boolean {
	if (route.host) {
		const hostHeader: string = request.headers?.asObject?.host ?? '';
		const requestHost = hostHeader.split(':')[0];
		if (requestHost !== route.host) return false;
	}
	const urlPath = normalizeUrlPath(route.urlPath);
	if (urlPath) {
		const pathname: string = request.pathname ?? '/';
		if (pathname !== urlPath && !pathname.startsWith(urlPath + '/')) return false;
	}
	return true;
}

/**
 * Returns a proxy of `request` with `pathname` and `url` rewritten so that
 * `prefix` is stripped from the path. e.g. prefix='/foo', pathname='/foo/bar' → '/bar'.
 * Trailing slashes on `prefix` are ignored. The strip is computed lazily on each
 * access so that downstream mutations to `request.pathname` remain reflected.
 * The original request object is not mutated.
 */
export function stripPrefix(request: any, prefix: string): any {
	const normalizedPrefix = normalizeUrlPath(prefix) ?? '';
	return new Proxy(request, {
		get(target, prop) {
			if (prop === 'pathname') {
				const origPathname: string = target.pathname ?? '/';
				return origPathname === normalizedPrefix ? '/' : origPathname.slice(normalizedPrefix.length);
			}
			if (prop === 'url') {
				const origPathname: string = target.pathname ?? '/';
				const origUrl: string = target.url ?? '';
				const stripped = origPathname === normalizedPrefix ? '/' : origPathname.slice(normalizedPrefix.length);
				return stripped + origUrl.slice(origPathname.length);
			}
			return Reflect.get(target, prop);
		},
	});
}

/**
 * Builds a dispatching chain when sub-routes (urlPath/host) are present.
 *
 * Each sub-route gets its own complete chain. If a sub-route entry declares
 * `after: 'X'`, entry X is pulled in from any route's registry so that the
 * constraint can be satisfied without requiring X to be explicitly registered
 * in the sub-route. This is how auth on the default route propagates into
 * sub-route chains that depend on it.
 *
 * Dispatch priority: host+path > host-only > path-only; longer paths win ties.
 *
 * `requestArgIndex` tells the dispatcher which positional argument carries the request
 * object used for host/path matching. HTTP and upgrade chains pass it at index 0;
 * WebSocket chains pass `(ws, request, chainCompletion)` so request is at index 1.
 * The matched (and prefix-stripped) request is substituted back into the same
 * position before forwarding to the inner chain.
 */
export function buildRoutedChain(
	portEntries: HttpEntry[],
	fallback: Function,
	onCycle?: () => void,
	requestArgIndex: number = 0
): Function {
	// Global name registry across all routes (first registration wins)
	const nameToEntry = new Map<string, HttpEntry>();
	for (const entry of portEntries) {
		if (entry.name && !nameToEntry.has(entry.name)) nameToEntry.set(entry.name, entry);
	}

	// Group entries by (host, normalized urlPath) so that '/api' and '/api/' coalesce.
	type RouteGroup = { host?: string; urlPath?: string; entries: HttpEntry[] };
	const routeGroups: RouteGroup[] = [];
	for (const entry of portEntries) {
		const urlPath = normalizeUrlPath(entry.urlPath);
		const group = routeGroups.find((g) => g.host === entry.host && g.urlPath === urlPath);
		if (group) group.entries.push(entry);
		else routeGroups.push({ host: entry.host, urlPath, entries: [entry] });
	}

	const defaultGroup = routeGroups.find((g) => !g.host && !g.urlPath);
	const subRouteGroups = routeGroups.filter((g) => g.host || g.urlPath);

	const subRouteChains = subRouteGroups.map((group) => {
		const resolved = resolveDeps(group.entries, nameToEntry);
		return { host: group.host, urlPath: group.urlPath, chain: buildLinearChain(topoSort(resolved, onCycle), fallback) };
	});

	subRouteChains.sort((a, b) => {
		const aSpec = (a.host ? 2 : 0) + (a.urlPath ? 1 : 0);
		const bSpec = (b.host ? 2 : 0) + (b.urlPath ? 1 : 0);
		if (aSpec !== bSpec) return bSpec - aSpec;
		return (b.urlPath?.length ?? 0) - (a.urlPath?.length ?? 0);
	});

	const defaultChain = buildLinearChain(topoSort(defaultGroup?.entries ?? [], onCycle), fallback);

	return function dispatch(...args: any[]) {
		const request = args[requestArgIndex];
		for (const route of subRouteChains) {
			if (matchesRoute(request, route)) {
				if (route.urlPath) {
					const newArgs = args.slice();
					newArgs[requestArgIndex] = stripPrefix(request, route.urlPath);
					return route.chain(...newArgs);
				}
				return route.chain(...args);
			}
		}
		return defaultChain(...args);
	};
}

/**
 * Builds the complete middleware chain for a given port from the full responders list.
 * Uses a flat linear chain when no sub-routes are present (fast path),
 * or a route-dispatching chain when any entry has urlPath or host.
 */
export function makeCallbackChain(
	responders: HttpEntry[],
	portNum: number | string,
	fallback: Function,
	onCycle?: () => void,
	requestArgIndex: number = 0
): Function {
	const portEntries = responders.filter(({ port }) => port === portNum || port === 'all');
	if (portEntries.some((e) => e.urlPath || e.host))
		return buildRoutedChain(portEntries, fallback, onCycle, requestArgIndex);
	return buildLinearChain(topoSort(portEntries, onCycle), fallback);
}
