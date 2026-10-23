/** Why a shared worker answers 503 for an isolated application's host: server/DESIGN.md. */
import { getConfigObj } from '../config/configUtils.ts';
import { existingSharedRootConfigWatcher } from '../config/RootConfigWatcher.ts';
import { isolatedApplicationNames, thisThreadsIsolatedApplication } from './threads/isolatedApplications.ts';
import { hostnameFromHeader, requestAuthority } from './middlewareChain.ts';

const RETRY_AFTER_SECONDS = '5';

let isolatedHosts: Set<string> | undefined;

/**
 * The hosts the root config gives isolated applications, lowercased as the router compares them. From the config
 * alone, not the components on disk: a package installed after a worker's first request changes no config to signal
 * it. A configured host carries no port, and may be a bare IPv6 literal, so it is not parsed as a Host header.
 */
export function isolatedApplicationHosts(config: Record<string, any> | undefined = getConfigObj()): Set<string> {
	const hosts = new Set<string>();
	for (const application of isolatedApplicationNames(config)) {
		const host = config?.[application]?.host;
		if (typeof host === 'string' && host) hosts.add(host.toLowerCase().replace(/\.$/, ''));
	}
	return hosts;
}

/**
 * Cached from the logger's root-config watcher, which every worker starts with its root components and which follows
 * the file as it changes: once a new isolated application starts only its own worker, nothing restarts the pool to
 * tell it. Without that watcher, as in a process that never loaded root components, it reads the config each time.
 */
function currentIsolatedHosts(): Set<string> {
	if (isolatedHosts) return isolatedHosts;
	const watcher = existingSharedRootConfigWatcher();
	if (!watcher) return isolatedApplicationHosts();
	watcher.on('change', (config) => {
		isolatedHosts = isolatedApplicationHosts(config);
	});
	isolatedHosts = isolatedApplicationHosts(watcher.config ?? getConfigObj());
	return isolatedHosts;
}

export function isolatedApplicationUnavailable(
	request: any,
	isOperationsServer = false,
	owner: string | undefined = thisThreadsIsolatedApplication(),
	hosts?: Set<string>
): { status: number; headers: Headers; body: string } | undefined {
	if (owner !== undefined || isOperationsServer) return undefined;
	const known = hosts ?? currentIsolatedHosts();
	if (known.size === 0) return undefined;
	const host = hostnameFromHeader(requestAuthority(request));
	if (!known.has(host)) return undefined;
	return {
		status: 503,
		headers: new Headers([
			['Retry-After', RETRY_AFTER_SECONDS],
			['Cache-Control', 'no-store'],
		]),
		body: `Service unavailable: ${host} is served by an isolated application whose worker is not running`,
	};
}
