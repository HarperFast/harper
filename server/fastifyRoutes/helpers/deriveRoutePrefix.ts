import { resolveBaseURLPath } from '../../../components/resolveBaseURLPath.ts';

/**
 * Derives the Fastify autoload route prefix for a component's routes from its app name and the
 * component's `urlPath` (or deprecated `path`) config, honoring the documented contract: no config
 * serves routes at the root, `urlPath: .` namespaces them under the app name (`/app-name/...`), and
 * an explicit `urlPath` uses that path. This mirrors `resolveBaseURLPath` (used for REST/static
 * routing) so fastifyRoutes stays consistent, but with the leading/trailing slashes stripped since
 * Fastify's autoload `prefix` is later re-prefixed with a single slash.
 */
export function deriveRoutePrefix(appName: string, urlPath: string | undefined): string {
	return resolveBaseURLPath(appName, urlPath).replace(/^\/+|\/+$/g, '');
}
