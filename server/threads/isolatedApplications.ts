/**
 * Isolated applications: an application whose root-config entry carries `isolated: true` runs in a
 * worker thread of its own that loads no other application (harper#642, tier 2).
 *
 * The invariant every helper here serves: an isolated application is loaded by exactly one thread,
 * and that thread loads nothing else. The dedicated worker is an ordinary `http` worker by type --
 * so restarts, overlap rules and shutdown treat it as one -- distinguished only by
 * `workerData.isolatedApplication`. It binds none of the public ports (the kernel would hand it
 * connections for every other application) and is reachable only through its own UDS mirror, whose
 * metadata names the application and its hosts for the fronting proxy to route by.
 */
import { isMainThread, workerData } from 'node:worker_threads';
import { getWorkerIndex } from './manageThreads.js';
import { getConfigObj, getConfigPath } from '../../config/configUtils.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import { isDomainSocketPathTooLong } from '../../utility/domainSocket.ts';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

export const DEFAULT_MAX_ISOLATED_APPLICATIONS = 8;

/** The application this thread is dedicated to, if it is a dedicated worker. */
export function thisThreadsIsolatedApplication(): string | undefined {
	return (workerData as any)?.isolatedApplication;
}

export function isIsolatedApplication(
	appName: string,
	config: Record<string, any> | undefined = getConfigObj()
): boolean {
	const entry = config?.[appName];
	return typeof entry === 'object' && entry !== null && entry.isolated === true;
}

/** Every application the root config marks isolated, in config order. */
export function isolatedApplicationNames(config: Record<string, any> | undefined = getConfigObj()): string[] {
	if (!config) return [];
	return Object.keys(config).filter((name) => isIsolatedApplication(name, config));
}

export function presentIsolatedApplicationNames(
	config: Record<string, any> | undefined = getConfigObj(),
	componentsRoot: string = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT) as string,
	installedRoot: string = join(env.get(CONFIG_PARAMS.ROOTPATH), 'components'),
	runApplicationPath: string | undefined = process.env.RUN_HDB_APP
): string[] {
	return isolatedApplicationNames(config).filter(
		(application) =>
			existsSync(join(componentsRoot, application)) ||
			existsSync(join(installedRoot, application)) ||
			(runApplicationPath && basename(runApplicationPath) === application)
	);
}

export function maxIsolatedApplications(): number {
	const configured = Number(env.get(CONFIG_PARAMS.THREADS_MAXISOLATED));
	return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_MAX_ISOLATED_APPLICATIONS;
}

/** Why `appName` cannot claim a place in the dedicated-worker budget, if the budget is full. */
export function isolatedApplicationCapacityRefusal(
	appName: string,
	runningApplications: Iterable<string>,
	max = maxIsolatedApplications()
): string | undefined {
	const running = new Set(runningApplications);
	if (running.has(appName) || running.size < max) return undefined;
	return `the instance already runs ${max} isolated application(s) (threads.maxIsolated)`;
}

/**
 * Whether the calling thread is the one that loads the application `appName` (an application: a
 * directory under componentsRoot, or a root-config entry with `package`). A dedicated worker loads
 * only its own application; every other thread -- pool workers and the main thread alike -- loads only
 * the applications that are not isolated. Decided before any of the application's modules are
 * imported, so a skipped application has no side effects on the thread that skipped it.
 */
export function shouldLoadApplicationHere(
	appName: string,
	owner: string | undefined = thisThreadsIsolatedApplication(),
	config: Record<string, any> | undefined = getConfigObj()
): boolean {
	if (owner !== undefined) return appName === owner;
	return !isIsolatedApplication(appName, config);
}

/**
 * Whether a dedicated worker can be reached at all: it binds only UDS mirrors of the secure port, so
 * without `tls.unixDomainSockets` and a secure port an isolated application would load and answer
 * nothing, silently. Refused at admission instead. Returns the reason, or undefined when reachable.
 */
export function isolatedApplicationsUnreachableReason(platform = process.platform): string | undefined {
	if (platform === 'win32') return 'Windows does not support per-application UDS mirrors';
	// the main thread standing in as the only worker (threads.count: 0) has no thread to give
	if (isMainThread && getWorkerIndex() === 0) return 'threads.count is 0, so there is no worker thread to dedicate';
	if (!env.get(CONFIG_PARAMS.HTTP_SECUREPORT)) return 'no http.securePort is configured';
	if (!env.get(CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS)) return 'tls.unixDomainSockets is not enabled';
	return undefined;
}

/** Why `appName` cannot get a dedicated worker on this instance, or undefined when it can. */
export function isolatedApplicationRefusal(appName: string): string | undefined {
	const unreachable = isolatedApplicationsUnreachableReason();
	if (unreachable) return `its worker would be unreachable: ${unreachable}`;
	const socketPath = join(
		env.getHdbBasePath(),
		'sockets',
		`${applicationSocketName(appName, env.get(CONFIG_PARAMS.HTTP_SECUREPORT))}.sock`
	);
	if (isDomainSocketPathTooLong(socketPath)) return `its UDS mirror path ${socketPath} exceeds the platform limit`;
	return undefined;
}

/**
 * The filesystem name of an isolated worker's UDS mirror for `port`: every UTF-8 byte outside
 * `[A-Za-z0-9._-]` becomes a fixed-width `%XX`, which is injective (two application names never share
 * a socket), and the `app-` prefix keeps it apart from the pool's `<workerIndex>-<port>` names.
 */
export function applicationSocketName(appName: string, port: number | string): string {
	let encoded = '';
	for (const byte of Buffer.from(appName, 'utf8')) {
		const c = String.fromCharCode(byte);
		encoded += byte < 0x80 && /[A-Za-z0-9._-]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
	}
	return `app-${encoded}-${port}`;
}

/** What a dedicated worker publishes in its mirror metadata for the proxy to route by. */
export function isolatedApplicationRoute(
	appName: string | undefined = thisThreadsIsolatedApplication(),
	config: Record<string, any> | undefined = getConfigObj()
): { application: string; hosts: string[] } | undefined {
	if (!appName) return undefined;
	const host = config?.[appName]?.host; // a string, as the mount parser requires
	return { application: appName, hosts: typeof host === 'string' && host ? [host] : [] };
}
