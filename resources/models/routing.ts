/**
 * Pluggable model routing (#1326).
 *
 * The `Models` facade resolves every call through a `ModelRouter`, which returns
 * the ordered candidate backends for that call. The facade uses the first
 * candidate and falls through to the next on backend failure (fallback), so
 * both capability-aware selection and fallback are expressed by one mechanism.
 *
 * The default router (below) is name-lookup + capability filter over a logical
 * name's group: it expands the logical name to `[name, ...configured fallback]`,
 * resolves each via `getBackend`, and keeps those whose `capabilities()` satisfy
 * the request's `requires`. `registerRouter(...)` replaces it wholesale for
 * cost/latency/tenant policies. Module-scope state — one router per process,
 * mirroring `backendRegistry`.
 */
import type { Capability, ModelBackend, ModelRouter, RouteRequest } from './types.ts';
import { getBackend } from './backendRegistry.ts';

type ModelKind = RouteRequest['kind'];

// `${kind}:${logicalName}` → ordered fallback logical names (from config `fallback:`).
const fallbackGroups: Map<string, string[]> = new Map();
let override: ModelRouter | null = null;

const groupKey = (kind: ModelKind, logicalName: string): string => `${kind}:${logicalName}`;

/**
 * Register the ordered fallback group for a logical name (boot wiring, from the
 * config `fallback:` field). The group members are additional logical names
 * tried, in order, after the primary.
 */
export function setFallbackGroup(kind: ModelKind, logicalName: string, fallbackNames: string[]): void {
	if (fallbackNames?.length) fallbackGroups.set(groupKey(kind, logicalName), [...fallbackNames]);
}

/** Replace the default selection policy with a custom router (#1326). */
export function registerRouter(router: ModelRouter): void {
	override = router;
}

/** Reset router override + fallback groups. Test-only hygiene. */
export function clearRouting(): void {
	override = null;
	fallbackGroups.clear();
}

/**
 * Clear only the config-derived fallback groups (a registered router override is
 * left intact). Called at (re)bootstrap so a removed or changed `fallback:` — or a
 * removed `models:` block — does not leave stale routing behind on a config reload.
 */
export function clearFallbackGroups(): void {
	fallbackGroups.clear();
}

/** The active router — a registered override, or the default name-lookup router. */
export function getRouter(): ModelRouter {
	return override ?? defaultRouter;
}

function satisfies(backend: ModelBackend, requires: Capability[]): boolean {
	if (requires.length === 0) return true;
	// Guard against a custom backend returning nullish from capabilities() — treat
	// "no capabilities object" as "satisfies nothing" rather than throwing here.
	const caps = backend.capabilities();
	return !!caps && requires.every((capability) => caps[capability]);
}

const defaultRouter: ModelRouter = {
	route(req: RouteRequest): ModelBackend[] {
		const names = [req.logicalName, ...(fallbackGroups.get(groupKey(req.kind, req.logicalName)) ?? [])];
		const seen = new Set<string>();
		const candidates: ModelBackend[] = [];
		for (const name of names) {
			if (seen.has(name)) continue;
			seen.add(name);
			const backend = getBackend(req.kind, name);
			if (backend && satisfies(backend, req.requires)) candidates.push(backend);
		}
		return candidates;
	},
};
