// Rows reach peers through system-table replication, so these operations do not call replicateOperation.

import { AsyncLocalStorage } from 'node:async_hooks';
import { BlockList, SocketAddress, isIP } from 'node:net';
import Joi from 'joi';
import { getDatabases, onUpdatedTable } from '../resources/databases.ts';
import { contextStorage } from '../resources/transaction.ts';
import * as terms from '../utility/hdbTerms.ts';
import { ClientError, hdbErrors } from '../utility/errors/hdbError.ts';
import { validateBySchema } from '../validation/validationWrapper.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';
import * as env from '../utility/environment/environmentManager.ts';

const { HTTP_STATUS_CODES } = hdbErrors;
const NETWORK_ACCESS_TABLE = terms.SYSTEM_TABLE_NAMES.NETWORK_ACCESS_TABLE_NAME;
const logger = loggerWithTag('network-access');

const NETWORK_ACCESS_SCOPES = ['operations'] as const;
export type NetworkAccessScope = (typeof NETWORK_ACCESS_SCOPES)[number];
const MAX_ALLOW_ENTRIES = 1000;
const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;
const SUBSCRIPTION_RETRY_MS = 1000;
let reconcileIntervalMs = 60_000;

/**
 * `<ip>` or `<ip>/<prefix>`, returned as `<canonical ip>/<prefix>` (a bare IP is a /32 or /128). Host
 * bits are kept, as the consuming proxy's parser keeps them. An IPv4-mapped IPv6 network is stored as the
 * IPv4 network it covers: the proxy matches by family, after unmapping a mapped peer.
 */
export function normalizeCidr(entry: unknown): string {
	if (typeof entry !== 'string') throw new ClientError(`Network access entry ${JSON.stringify(entry)} is not a string`);
	const slash = entry.indexOf('/');
	const address = slash === -1 ? entry : entry.slice(0, slash);
	const prefixText = slash === -1 ? undefined : entry.slice(slash + 1);
	const family = address.includes('%') ? 0 : isIP(address);
	if (family === 0) throw new ClientError(`'${entry}' is not an IPv4 or IPv6 address or CIDR`);
	const maxPrefix = family === 4 ? 32 : 128;
	let prefix = maxPrefix;
	if (prefixText !== undefined) {
		prefix = /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
		if (!(prefix <= maxPrefix)) {
			throw new ClientError(`'${entry}' has an invalid prefix length; expected 0-${maxPrefix}`);
		}
	}
	const canonical = new SocketAddress({ address, family: family === 4 ? 'ipv4' : 'ipv6' }).address;
	const mapped = MAPPED_IPV4.exec(canonical);
	if (mapped && prefix >= 96) return `${mapped[1]}/${prefix - 96}`;
	return `${canonical}/${prefix}`;
}

export function normalizeAllowList(allow: unknown[]): string[] {
	return [...new Set(allow.map(normalizeCidr))];
}

/**
 * Matches only entries of the address's own family, after unmapping an IPv4-mapped address, as the proxy
 * does. `BlockList` alone would also admit an IPv4 address to an IPv6 rule such as `::/0`.
 */
export function addressIsAllowed(address: string, allow: string[]): boolean {
	let family = isIP(address);
	if (family === 0) return false;
	if (family === 6) {
		const mapped = MAPPED_IPV4.exec(new SocketAddress({ address, family: 'ipv6' }).address);
		if (mapped) {
			address = mapped[1];
			family = 4;
		}
	}
	const type = family === 4 ? 'ipv4' : 'ipv6';
	const blockList = new BlockList();
	for (const cidr of allow) {
		const [network, prefix] = cidr.split('/');
		if (isIP(network) === family) blockList.addSubnet(network, Number(prefix), type);
	}
	return blockList.check(address, type);
}

function requireSuperUser(req: any): void {
	if (!req?.hdb_user?.role?.permission?.super_user) {
		throw new ClientError(
			`Operation '${req?.operation}' is restricted to super_user roles`,
			HTTP_STATUS_CODES.FORBIDDEN
		);
	}
}

function networkAccessTable() {
	const table = getDatabases().system?.[NETWORK_ACCESS_TABLE];
	if (!table) {
		throw new ClientError(
			`Network access is not initialized on this node (system.${NETWORK_ACCESS_TABLE} missing). ` +
				`Run upgrade or restart the server to provision the table.`
		);
	}
	return table;
}

const SCOPE = Joi.string()
	.valid(...NETWORK_ACCESS_SCOPES)
	.messages({ 'any.only': `'scope' must be one of: ${NETWORK_ACCESS_SCOPES.join(', ')}` });

function validate(validation: any): void {
	if (validation) throw new ClientError(validation.message);
}

// Async context, not the operation body, which is untrusted (server/DESIGN.md, "Operations authorization
// boundary").
const callerAddressStorage = new AsyncLocalStorage<{ address: string | null | undefined }>();

/**
 * Runs an operations API request with its source address, as `clientAddressOf` in serverHandlers.js
 * derives it: a string; undefined for the local operations domain socket, which no proxy fronts; or null
 * when a network request's address is unknown.
 */
export function runWithCallerAddress<T>(address: string | null | undefined, callback: () => T): T {
	return callerAddressStorage.run({ address }, callback);
}

/**
 * The lockout check skips a local or in-process caller (no address): that is the recovery path. An
 * unknown network address needs `force`.
 */
export async function setNetworkAccess(req: any) {
	requireSuperUser(req);
	validate(
		validateBySchema(
			req,
			Joi.object({
				scope: SCOPE.required(),
				allow: Joi.array().max(MAX_ALLOW_ENTRIES).required(),
				// strict: validateBySchema discards Joi's coerced value, so `"false"` would otherwise pass
				force: Joi.boolean().strict(),
			}).unknown(true)
		)
	);
	const scope: NetworkAccessScope = req.scope;
	const allow = normalizeAllowList(req.allow);
	const callerAddress = callerAddressStorage.getStore()?.address;
	if (allow.length > 0 && req.force !== true && callerAddress === null) {
		throw new ClientError(
			`This request's source address is unknown, so the new '${scope}' allowlist may block this connection. ` +
				`Pass force: true to set it anyway.`,
			HTTP_STATUS_CODES.CONFLICT
		);
	}
	if (
		allow.length > 0 &&
		req.force !== true &&
		typeof callerAddress === 'string' &&
		callerAddress !== '' &&
		!addressIsAllowed(callerAddress, allow)
	) {
		throw new ClientError(
			`The new '${scope}' allowlist does not include this request's source address ${callerAddress}, so it would ` +
				`block this connection. Add the address, or pass force: true to set it anyway.`,
			HTTP_STATUS_CODES.CONFLICT
		);
	}
	const table = networkAccessTable();
	if (allow.length === 0) {
		await table.delete(scope);
		return { message: `Removed the '${scope}' network access restriction`, scope, allow };
	}
	await table.put(scope, { scope, allow, updatedBy: req.hdb_user?.username ?? null, updatedAt: Date.now() });
	const result: Record<string, unknown> = { message: `Set the '${scope}' network access allowlist`, scope, allow };
	if (!env.get(terms.CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS)) {
		result.warning =
			'This node publishes no socket metadata (tls.unixDomainSockets is off), so nothing here enforces the list; ' +
			'it is stored and replicated to nodes that do.';
	}
	return result;
}

function viewOf(scope: string, row: any) {
	return {
		scope,
		allow: Array.isArray(row?.allow) ? [...row.allow] : [],
		updatedBy: row?.updatedBy ?? null,
		updatedAt: row?.updatedAt ?? null,
	};
}

export async function getNetworkAccess(req: any) {
	requireSuperUser(req);
	validate(validateBySchema(req, Joi.object({ scope: SCOPE }).unknown(true)));
	const table = networkAccessTable();
	if (req.scope) return viewOf(req.scope, await table.get(req.scope));
	const views = [];
	for (const scope of NETWORK_ACCESS_SCOPES) views.push(viewOf(scope, await table.get(scope)));
	return views;
}

/** Returns whether its output now reflects `allowedSourcesFor(scope)`. */
type Publisher = () => boolean;

interface ScopeWatch {
	scope: NetworkAccessScope;
	/** undefined until the first successful read */
	allow?: string[];
	/** what each publisher last published successfully, as a key of `allow` */
	publishers: Map<Publisher, string | undefined>;
	reading: boolean;
	dirty: boolean;
	subscribedTable?: any;
	subscription?: Promise<any>;
	timer?: ReturnType<typeof setInterval>;
}

const watches = new Map<NetworkAccessScope, ScopeWatch>();
let tableListener: { remove(): void } | undefined;

/**
 * This thread's current list for the scope (`[]` = unrestricted), or undefined until it has been read.
 * A publisher must not publish while it is undefined: that would advertise no restriction for a scope
 * that may have one.
 */
export function allowedSourcesFor(scope: NetworkAccessScope): string[] | undefined {
	return watches.get(scope)?.allow;
}

/**
 * Calls `publish` once the scope's list is known and again whenever it changes, from this node or a
 * replicated write. A publish that reports failure is retried on the periodic re-read, which also
 * covers a change notification that never arrived.
 */
export function watchNetworkAccess(scope: NetworkAccessScope, publish: Publisher): void {
	let watch = watches.get(scope);
	if (!watch) {
		watch = { scope, publishers: new Map(), reading: false, dirty: false };
		watches.set(scope, watch);
		const started = watch;
		watch.timer = setInterval(() => reconcile(started), reconcileIntervalMs).unref();
		tableListener ??= onUpdatedTable((table: any) => {
			if (table.databaseName === terms.SYSTEM_SCHEMA_NAME && table.tableName === NETWORK_ACCESS_TABLE) {
				for (const each of watches.values()) reconcile(each);
			}
		});
	}
	watch.publishers.set(publish, undefined);
	if (watch.allow) publishAll(watch);
	else reconcile(watch);
}

function reconcile(watch: ScopeWatch): void {
	if (watches.get(watch.scope) !== watch) return;
	if (watch.reading) {
		watch.dirty = true;
		return;
	}
	watch.reading = true;
	watch.dirty = false;
	let table: any;
	// outside any request context, whose transaction snapshot the read would otherwise use; async, so a
	// synchronous throw (a closing database) reaches the rejection handler instead of wedging `reading`
	contextStorage
		.exit(async () => {
			table = getDatabases().system?.[NETWORK_ACCESS_TABLE];
			if (!table) return undefined;
			subscribe(watch, table);
			return await table.get(watch.scope);
		})
		.then(
			(row: any) => {
				watch.reading = false;
				if (watches.get(watch.scope) !== watch) return;
				// a read from a replaced table object may predate the replacement's contents
				if (getDatabases().system?.[NETWORK_ACCESS_TABLE] !== table) watch.dirty = true;
				else {
					watch.allow = Array.isArray(row?.allow) ? row.allow.filter((entry) => typeof entry === 'string') : [];
					publishAll(watch);
				}
				if (watch.dirty) reconcile(watch);
			},
			(error: Error) => {
				watch.reading = false;
				logger.warn?.(`Could not read system.${NETWORK_ACCESS_TABLE} '${watch.scope}'; keeping the last list`, error);
				if (watch.dirty && watches.get(watch.scope) === watch) reconcile(watch);
			}
		);
}

function publishAll(watch: ScopeWatch): void {
	const key = JSON.stringify(watch.allow);
	for (const [publish, published] of watch.publishers) {
		if (published === key) continue;
		let ok = false;
		try {
			ok = publish();
		} catch (error) {
			logger.warn?.(`Publishing the '${watch.scope}' network access list failed`, error);
		}
		if (ok) watch.publishers.set(publish, key);
	}
}

function subscribe(watch: ScopeWatch, table: any): void {
	if (watch.subscribedTable === table) return;
	const previous = watch.subscription;
	watch.subscribedTable = table;
	const subscription = (async () =>
		table.subscribe({ id: watch.scope, omitCurrent: true, listener: () => reconcile(watch) }))();
	watch.subscription = subscription;
	const lost = () => {
		if (watch.subscription === subscription) watch.subscribedTable = undefined;
	};
	// the re-read resubscribes; delayed so a subscription that closes as soon as it opens cannot spin
	const closed = () => {
		lost();
		setTimeout(() => reconcile(watch), SUBSCRIPTION_RETRY_MS).unref();
	};
	subscription.then(
		(opened: any) => {
			if (opened?.closed) closed();
			else opened?.on?.('close', closed);
		},
		(error: Error) => {
			lost();
			logger.warn?.(`Could not subscribe to system.${NETWORK_ACCESS_TABLE}; relying on periodic re-reads`, error);
		}
	);
	previous?.then(
		(opened: any) => opened?.end?.(),
		() => {}
	);
}

export function resetNetworkAccessWatches(intervalMs = 60_000): void {
	for (const watch of watches.values()) {
		clearInterval(watch.timer);
		watch.subscription?.then(
			(opened: any) => opened?.end?.(),
			() => {}
		);
	}
	watches.clear();
	tableListener?.remove();
	tableListener = undefined;
	reconcileIntervalMs = intervalMs;
}
