import Joi from 'joi';
import { InvalidBaseURLPathError, resolveBaseURLPath } from './resolveBaseURLPath.ts';
import harperLogger from '../utility/logging/harper_logger.ts';

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
 * mount point an operator has chosen. The mount reaches every plugin scope loaded for that
 * application (and, transitively, plugins the application itself declares).
 *
 * The mount is applied at exactly one place: the routing boundary, where `Scope`'s `server`
 * proxy registers a handler. The router strips it before the handler runs, so everything
 * inside the application — entry URL paths, and the resource paths `graphqlSchema` and
 * `jsResource` derive from them — stays mount-relative. Only code that emits an absolute URL
 * back to the client (`Scope.externalBasePath`) or bypasses the routed chain (legacy fastify
 * routes) needs to know the mount exists.
 */
export interface ScopeMount {
	host?: string;
	urlPath?: string;
}

export class InvalidMountPathError extends Error {
	constructor(urlPath: string) {
		super(`An application mount urlPath must be an absolute path without '.' or '..' segments. Received: '${urlPath}'`);
	}
}

export class InvalidMountHostError extends Error {
	constructor(host: string) {
		super(
			`An application mount host must be a bare hostname or IPv6 literal, with no scheme, port, or path. Received: '${host}'`
		);
	}
}

// Compiled once and reused, mirroring operationsValidation.js's deploy_component 'host' schema:
// a routing host is either a DNS hostname or a bare IPv6 literal.
const HOSTNAME_SCHEMA = Joi.string().hostname();
const IPV6_SCHEMA = Joi.string().ip({ version: 'ipv6' });

/**
 * Normalizes a mount prefix to a leading-slash, no-trailing-slash form ('/v1'), or
 * undefined when it constrains nothing ('', '/', undefined) — matching
 * `middlewareChain.normalizeUrlPath`, so a mount that means "the root" composes to
 * exactly the plugin's own path rather than rewriting it.
 *
 * Dot segments are rejected rather than resolved. A plugin's `urlPath` may be plugin-name
 * relative ('./x'), but a mount has no such base, and WHATWG clients strip '.' segments
 * before sending the request — a '/.'-prefixed route would simply be unreachable.
 */
export function normalizeMountPath(urlPath: string | undefined): string | undefined {
	if (!urlPath) return undefined;
	if (urlPath.includes('..')) throw new InvalidBaseURLPathError(urlPath);
	let normalized = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
	normalized = normalized.replace(/\/+$/, '');
	if (normalized.split('/').includes('.')) throw new InvalidMountPathError(urlPath);
	return normalized.length <= 1 ? undefined : normalized;
}

/**
 * Hostnames are case-insensitive (RFC 4343) and clients send them lowercased, so a mount is
 * held lowercased and compared that way. The bracket form of an IPv6 literal is unwrapped to
 * match what the router extracts from the Host header.
 *
 * Validated against the same grammar as the `deploy_component` operation's `host` field (a bare
 * DNS hostname or IPv6 literal) — the root config is hand-edited YAML with no equivalent gate,
 * so a value that would never match a Host header (a port, a scheme, a path suffix, malformed
 * IDN) must be rejected here rather than silently mounting the application unreachably.
 */
export function normalizeMountHost(host: string | undefined): string | undefined {
	if (!host) return undefined;
	const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	const normalized = unbracketed.toLowerCase();
	if (HOSTNAME_SCHEMA.validate(normalized).error && IPV6_SCHEMA.validate(normalized).error) {
		throw new InvalidMountHostError(host);
	}
	return normalized;
}

/**
 * Reads a mount off a root-config entry, or undefined when the entry declares no routing at
 * all — so an unmounted application takes exactly the code path it did before mounts existed.
 *
 * `host`/`urlPath` present but not a string (e.g. `host: 9926`, a likely typo for a quoted
 * value) is rejected rather than silently treated as absent: this fail-closed behavior only
 * works if a wrong-typed value fails the same way a wrong-format one does (review finding) —
 * `null`/`undefined` are still "not declared", since that's how YAML represents an omitted key.
 */
export function toScopeMount(config: unknown): ScopeMount | undefined {
	if (!config || typeof config !== 'object') return undefined;
	const { host, urlPath } = config as ScopeMount;
	if (host !== undefined && host !== null && typeof host !== 'string') throw new InvalidMountHostError(String(host));
	if (urlPath !== undefined && urlPath !== null && typeof urlPath !== 'string')
		throw new InvalidMountPathError(String(urlPath));
	const mountHost = normalizeMountHost(typeof host === 'string' ? host : undefined);
	const mountPath = normalizeMountPath(typeof urlPath === 'string' ? urlPath : undefined);
	if (!mountHost && !mountPath) return undefined;
	return { host: mountHost, urlPath: mountPath };
}

/**
 * Composes an application mount with a plugin's own `urlPath`.
 *
 * The plugin part is resolved first (`resolveBaseURLPath` semantics: `'.'`/`'./x'` namespace
 * under the plugin name) and the mount is then prefixed, so app-internal structure survives
 * relocation: mount `/v1` + `static: { urlPath: assets }` → `/v1/assets/`. Composing rather
 * than replacing matters because a plugin's `urlPath` doubles as its app-internal base path;
 * replacing it would silently relocate app-internal URLs and collapse distinct plugins onto
 * one path. The result is already absolute and slash-terminated, making it a fixed point of
 * `resolveBaseURLPath` — a consumer that resolves it again cannot compound the prefix.
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
 * Nests a child component's own mount inside the mount its parent application was given.
 *
 * The parent keeps hostname authority — a child cannot escape the host it is served on — while
 * paths compose, so a parent at `/v1` containing a child mounted at `/child` puts the child at
 * `/v1/child`. Returns whichever side is defined when only one is. A child `host` that differs
 * from the parent's is silently discarded by that authority rule; logged so the operator who
 * wrote it isn't left guessing why it had no effect.
 */
export function nestScopeMount(parent: ScopeMount | undefined, child: ScopeMount | undefined): ScopeMount | undefined {
	if (!parent) return child;
	if (!child) return parent;
	if (parent.host && child.host && parent.host !== child.host) {
		harperLogger.warn(
			`Component mount host '${child.host}' is ignored because it is nested under an application mounted on host '${parent.host}' — a child's host cannot override its parent's.`
		);
	}
	const urlPath = child.urlPath ? `${parent.urlPath ?? ''}${child.urlPath}` : parent.urlPath;
	return { host: parent.host ?? child.host, urlPath: urlPath || undefined };
}
