import { InvalidBaseURLPathError, resolveBaseURLPath } from './resolveBaseURLPath.ts';

/**
 * The routing an operator declared for an application in the *root* config, e.g.
 *
 * ```yaml
 * my-app:
 *   package: '@my/app'
 *   host: api.example.com
 *   urlPath: /v1
 * ```
 *
 * Where an application is served is a deployment concern, not an application concern, so
 * the root config is authoritative: a checked-in `config.yaml` cannot pin the hostname or
 * mount point an operator has chosen. The mount is applied to every plugin scope loaded
 * for that application (and, transitively, to plugins the application itself declares).
 */
export interface ScopeMount {
	host?: string;
	urlPath?: string;
}

/**
 * Normalizes a mount prefix to a leading-slash, no-trailing-slash form ('/v1'), or
 * undefined when it constrains nothing ('', '/', undefined) — matching
 * `middlewareChain.normalizeUrlPath`, so a mount that means "the root" composes to
 * exactly the plugin's own path rather than rewriting it.
 */
export function normalizeMountPath(urlPath: string | undefined): string | undefined {
	if (!urlPath) return undefined;
	if (urlPath.includes('..')) throw new InvalidBaseURLPathError(urlPath);
	let normalized = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
	normalized = normalized.replace(/\/+$/, '');
	return normalized.length <= 1 ? undefined : normalized;
}

/**
 * Returns the mount, or undefined when it declares no routing at all — so callers can
 * skip the overlay entirely and leave existing (unmounted) config objects untouched.
 */
export function toScopeMount(config: unknown): ScopeMount | undefined {
	if (!config || typeof config !== 'object') return undefined;
	const { host, urlPath } = config as ScopeMount;
	const mountHost = typeof host === 'string' && host ? host : undefined;
	const mountPath = normalizeMountPath(typeof urlPath === 'string' ? urlPath : undefined);
	if (!mountHost && !mountPath) return undefined;
	return { host: mountHost, urlPath: mountPath };
}

/**
 * Composes an application mount with a plugin's own `urlPath`.
 *
 * The plugin part is resolved first (`resolveBaseURLPath` semantics: `'.'`/`'./x'` namespace
 * under the plugin name) and the mount is then prefixed, so app-internal structure survives
 * relocation: mount `/v1` + `static: { urlPath: assets }` → `/v1/assets/`. The result is
 * already absolute and slash-terminated, which makes it a fixed point of
 * `resolveBaseURLPath` — downstream consumers (the `server` proxy, `EntryHandler`,
 * `static`, `fastifyRoutes`) can keep resolving it without compounding the prefix.
 */
export function composeMountedUrlPath(
	mountPath: string | undefined,
	pluginName: string,
	pluginUrlPath: string | undefined
): string | undefined {
	if (!mountPath) return pluginUrlPath;
	return `${mountPath}${resolveBaseURLPath(pluginName, pluginUrlPath)}`;
}

/**
 * Overlays an application mount onto one plugin's config section.
 *
 * `host` is replaced outright — an operator remapping an app's hostname must win over a
 * value the app shipped, which is the whole point of moving routing to the root config.
 * `urlPath` is composed rather than replaced, because a plugin's `urlPath` doubles as its
 * app-internal base path (static's asset root, fastify's route prefix); replacing it would
 * silently relocate app-internal URLs and collapse distinct plugins onto one path.
 *
 * Returns `section` unchanged when there is no mount, so unmounted applications keep both
 * their exact config values and object identity.
 */
export function applyScopeMount<T>(section: T, pluginName: string, mount?: ScopeMount): T {
	if (!mount || section === undefined || section === null) return section;
	// A plugin enabled with a bare `true` (e.g. `rest: true`) still needs to carry the mount,
	// so promote it to an object rather than dropping the routing on the floor.
	const base: Record<string, unknown> = typeof section === 'object' ? { ...(section as object) } : {};
	if (mount.host) base.host = mount.host;
	const composed = composeMountedUrlPath(mount.urlPath, pluginName, base.urlPath as string | undefined);
	if (composed !== undefined) base.urlPath = composed;
	return base as T;
}
