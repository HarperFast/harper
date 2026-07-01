import { transaction } from './transaction.ts';
import logger from '../utility/logging/harper_logger.ts';
import { ServerError } from '../utility/errors/hdbError.ts';
import { server } from '../server/Server.ts';

export interface ResourceEntry {
	Resource: any;
	path: string;
	exportTypes: any;
	hasSubPaths: boolean;
	relativeURL: string;
	/**
	 * Bound parameters extracted from a parameterised path (e.g. `:id`/`*rest` segments). Only set when the entry was
	 * matched via a parameterised route; reset on every match so it is never stale.
	 */
	params?: { [key: string]: string };
}

export type RouteSegment =
	| { type: 'static'; value: string }
	| { type: 'param'; value: string }
	| { type: 'wildcard'; value: string };

export interface CompiledRoute {
	/** Normalized pattern (leading/trailing slashes stripped) — used as the identity key for the route. */
	pattern: string;
	segments: RouteSegment[];
	entry: ResourceEntry;
}

/** Per-segment specificity used to order routes: a static segment beats a param, which beats a wildcard. */
const SEGMENT_SPECIFICITY: { [K in RouteSegment['type']]: number } = { static: 3, param: 2, wildcard: 1 };

/**
 * A path is parameterised if any of its segments begins with `:` (named parameter) or `*` (wildcard/catch-all).
 */
function pathHasParams(path: string): boolean {
	return path.split('/').some((segment) => segment.charAt(0) === ':' || segment.charAt(0) === '*');
}

function compileRouteSegments(path: string): RouteSegment[] {
	return path.split('/').map((segment): RouteSegment => {
		if (segment.charAt(0) === ':') return { type: 'param', value: segment.slice(1) };
		// a bare `*` binds under the name `wildcard` so the key is a valid URI-template / OpenAPI variable name
		if (segment.charAt(0) === '*') return { type: 'wildcard', value: segment.slice(1) || 'wildcard' };
		return { type: 'static', value: segment };
	});
}

/**
 * Convert a parameterised route's segments into a URI template: `:id`/`*rest` segments become `{id}`/`{rest}`.
 * Returns the templated path (no leading slash) and the ordered parameters with their kind. Shared by the OpenAPI
 * and MCP enumerators so a route renders the same way everywhere.
 */
export function routePatternToTemplate(segments: RouteSegment[]): {
	template: string;
	params: Array<{ name: string; wildcard: boolean }>;
} {
	const params: Array<{ name: string; wildcard: boolean }> = [];
	const template = segments
		.map((segment) => {
			if (segment.type === 'static') return segment.value;
			params.push({ name: segment.value, wildcard: segment.type === 'wildcard' });
			return `{${segment.value}}`;
		})
		.join('/');
	return { template, params };
}

function decode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		// malformed percent-encoding: fall back to the raw segment rather than throwing during routing
		return value;
	}
}

/**
 * Attempt to match a request's path segments against a compiled route's segments. Returns the extracted parameters
 * on a successful match, or undefined if the route does not match.
 */
function matchSegments(routeSegments: RouteSegment[], urlSegments: string[]): { [key: string]: string } | undefined {
	const params: { [key: string]: string } = {};
	for (let i = 0; i < routeSegments.length; i++) {
		const segment = routeSegments[i];
		if (segment.type === 'wildcard') {
			// a wildcard captures the remainder of the path (zero or more segments) and is always the final segment
			params[segment.value] = urlSegments.slice(i).map(decode).join('/');
			return params;
		}
		if (i >= urlSegments.length) return undefined; // not enough segments to satisfy this route
		if (segment.type === 'static') {
			if (segment.value !== urlSegments[i]) return undefined;
		} else {
			params[segment.value] = decode(urlSegments[i]);
		}
	}
	// every route segment was consumed; reject if the URL has extra trailing segments
	if (urlSegments.length !== routeSegments.length) return undefined;
	return params;
}

/**
 * This is the global set of all resources that have been registered on this server.
 */
export class Resources extends Map<string, ResourceEntry> {
	isWorker = true;
	loginPath?: (request: any) => string;

	allTypes: Map<any, any> = new Map();

	/**
	 * Parameterised routes (paths containing `:param` or `*wildcard` segments). These are kept out of the base Map so
	 * the exact/prefix matching fast path is untouched; they are only consulted by {@link getMatch} when no static
	 * resource matches.
	 */
	paramRoutes: CompiledRoute[] = [];

	// @ts-expect-error override with different signature
	set(path: string, resource: any, exportTypes?: { [key: string]: boolean }, force?: boolean): void {
		if (!resource) throw new Error('Must provide a resource');
		if (path.startsWith('/')) path = path.replace(/^\/+/, '');
		const entry = {
			Resource: resource,
			path,
			exportTypes,
			hasSubPaths: false,
			relativeURL: '', // reset after each match
		};
		if (pathHasParams(path)) {
			this.setParamRoute(path, entry, resource, force);
			return;
		}
		const existingEntry = super.get(path);
		if (
			existingEntry &&
			(existingEntry.Resource.databaseName !== resource.databaseName ||
				existingEntry.Resource.tableName !== resource.tableName) &&
			!force
		) {
			// there was a conflict in endpoint paths. We don't want this to be ignored, so we log it
			// and create an error resource to make sure it is reported in any attempt to access this path.
			// it was be a 500 error; clearly a server error (not client error), unfortunate that the 5xx errors
			// don't provide anything more descriptive.
			const error = new ServerError(`Conflicting paths for ${path}`);
			logger.error(error);
			const { ErrorResource } = require('./ErrorResource');
			entry.Resource = new ErrorResource(error);
		}
		super.set(path, entry);
		// now mark any entries that have sub paths so we can efficiently route forward
		for (const [path] of this) {
			let slashIndex = 2;
			while ((slashIndex = path.indexOf('/', slashIndex)) > -1) {
				const parentEntry = this.get(path.slice(0, slashIndex));
				if (parentEntry) parentEntry.hasSubPaths = true;
				slashIndex += 2;
			}
		}
	}

	// Parameterised routes live in a side array rather than the base Map, so the Map-mutation methods below must keep
	// it in sync — otherwise a removed/cleared route would keep matching against an unloaded Resource class.
	delete(path: string): boolean {
		if (path.startsWith('/')) path = path.replace(/^\/+/, '');
		const mapDeleted = super.delete(path);
		const pattern = path.endsWith('/') ? path.replace(/\/+$/, '') : path; // patterns are stored trailing-slash-free
		const before = this.paramRoutes.length;
		this.paramRoutes = this.paramRoutes.filter((route) => route.pattern !== pattern);
		return mapDeleted || this.paramRoutes.length < before;
	}

	clear(): void {
		super.clear();
		this.paramRoutes = [];
	}

	/**
	 * Register (or replace) a parameterised route. Routes are kept sorted most-specific-first so the first match wins:
	 * segment kinds are compared left-to-right (static beats param beats wildcard) and, when one route is a prefix of
	 * another, the longer pattern wins.
	 */
	private setParamRoute(path: string, entry: ResourceEntry, resource: any, force?: boolean): void {
		// a trailing slash adds an empty final segment that can never match (incoming URLs are normalized first)
		if (path.endsWith('/')) {
			path = path.replace(/\/+$/, '');
			entry.path = path;
		}
		const segments = compileRouteSegments(path);
		// a wildcard captures the remainder of the path, so anything after it is unreachable — reject it outright
		const wildcardIndex = segments.findIndex((segment) => segment.type === 'wildcard');
		if (wildcardIndex > -1 && wildcardIndex !== segments.length - 1) {
			throw new Error(`Wildcard segment must be the last segment in a route path: ${path}`);
		}
		const compiled: CompiledRoute = { pattern: path, segments, entry };
		const existingIndex = this.paramRoutes.findIndex((route) => route.pattern === path);
		if (existingIndex > -1) {
			const existing = this.paramRoutes[existingIndex];
			if (
				!force &&
				(existing.entry.Resource.databaseName !== resource.databaseName ||
					existing.entry.Resource.tableName !== resource.tableName)
			) {
				// conflicting registrations for the same parameterised path; surface it like the static-path conflict
				const error = new ServerError(`Conflicting paths for ${path}`);
				logger.error(error);
				const { ErrorResource } = require('./ErrorResource');
				compiled.entry.Resource = new ErrorResource(error);
			}
			this.paramRoutes[existingIndex] = compiled;
		} else {
			this.paramRoutes.push(compiled);
		}
		this.paramRoutes.sort((a, b) => {
			const shared = Math.min(a.segments.length, b.segments.length);
			for (let i = 0; i < shared; i++) {
				const weightA = SEGMENT_SPECIFICITY[a.segments[i].type];
				const weightB = SEGMENT_SPECIFICITY[b.segments[i].type];
				if (weightA !== weightB) return weightB - weightA;
			}
			return b.segments.length - a.segments.length;
		});
	}

	/**
	 * Match a URL against the registered parameterised routes. On a match, the route's entry is returned with
	 * `relativeURL` (the trailing query string, if any) and `params` populated. Returns undefined if nothing matches.
	 */
	private matchParamRoute(url: string, exportType?: string): ResourceEntry | undefined {
		const queryIndex = url.indexOf('?');
		const pathPart = queryIndex > -1 ? url.slice(0, queryIndex) : url;
		const search = queryIndex > -1 ? url.slice(queryIndex) : '';
		let normalized = pathPart;
		if (normalized.charAt(0) === '/') normalized = normalized.slice(1);
		if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
		const urlSegments = normalized === '' ? [] : normalized.split('/');
		for (const route of this.paramRoutes) {
			if (exportType && route.entry.exportTypes?.[exportType] === false) continue;
			const params = matchSegments(route.segments, urlSegments);
			if (params) {
				route.entry.relativeURL = search;
				route.entry.params = params;
				return route.entry;
			}
		}
		return undefined;
	}

	/**
	 * Find the best (longest) match resource path that matches the (beginning of the) provided path, in order to find
	 * the correct Resource to handle this URL path.
	 * @param path The URL Path
	 * @param exportType Optional request content or protocol type, allows control of which protocols can access a resource
	 * and future layering of resources (for defining HTML handlers
	 * that can further transform data from the main structured object resources).
	 * @return The matched Resource class. Note that the remaining path is "returned" by setting the relativeURL property
	 */
	getMatch(url: string, exportType?: string): ResourceEntry | undefined {
		let slashIndex = 2;
		let prevSlashIndex = 0;
		let foundEntry: ResourceEntry;

		const urlLength = url.length;

		while (slashIndex < urlLength) {
			prevSlashIndex = slashIndex;
			slashIndex = url.indexOf('/', slashIndex);

			if (slashIndex === -1) {
				slashIndex = urlLength;
			}

			const resourcePath = slashIndex === urlLength ? url : url.slice(0, slashIndex);
			let entry = this.get(resourcePath);
			let queryIndex = -1;
			if (!entry && slashIndex === urlLength) {
				// try to match the first part of the path if there's a query
				queryIndex = resourcePath.indexOf('?', prevSlashIndex);
				if (queryIndex !== -1) {
					const pathPart = resourcePath.slice(0, queryIndex);
					entry = this.get(pathPart);
				}
			}
			if (entry && (!exportType || entry.exportTypes?.[exportType] !== false)) {
				entry.relativeURL = url.slice(queryIndex !== -1 ? queryIndex : slashIndex);
				if (!entry.hasSubPaths) {
					return entry;
				}
				foundEntry = entry;
			}

			slashIndex += 2;
		}

		if (foundEntry) return foundEntry;

		// try the exact path
		const searchIndex = url.indexOf('?');
		const path = searchIndex > -1 ? url.slice(0, searchIndex) : url;
		foundEntry = this.get(path);
		if (!foundEntry && path.indexOf('.') > -1) {
			foundEntry = this.get(path.split('.')[0]);
		}
		if (foundEntry && (!exportType || foundEntry.exportTypes?.[exportType] !== false)) {
			foundEntry.relativeURL = searchIndex > -1 ? url.slice(searchIndex) : '';
		} else if (!foundEntry) {
			// no static resource matched; try parameterised routes before falling back to an explicit root resource
			if (this.paramRoutes.length) {
				const paramMatch = this.matchParamRoute(url, exportType);
				if (paramMatch) return paramMatch;
			}
			// still not found, see if there is an explicit root path
			foundEntry = this.get('');
			if (foundEntry && (!exportType || foundEntry.exportTypes?.[exportType] !== false)) {
				if (url.charAt(0) !== '/') url = '/' + url;
				foundEntry.relativeURL = url;
			}
		}
		return foundEntry;
	}

	getResource(path: string, resourceInfo) {
		const entry = this.getMatch(path);
		if (entry) {
			path = entry.relativeURL;
			return entry.Resource.getResource((this as any).pathToId(path, entry.Resource), resourceInfo);
		}
	}
	call(path: string, request, callback: Function) {
		return transaction(request, async () => {
			const entry = this.getMatch(path);
			if (entry) {
				path = entry.relativeURL;
				return callback(entry.Resource, entry.path, path);
			}
		});
	}
	// eslint-disable-next-line no-unused-vars
	setRepresentation(path, type, representation) {}
}
export let resources: Resources;
export function resetResources() {
	resources = new Resources();
	server.resources = resources;
	return resources;
}

export function keyArrayToString(key) {
	if (Array.isArray(key)) {
		if (key[key.length - 1] === null) return key.slice(0, -1).join('/') + '/';
		else return key.join('/');
	}
	return key;
}
