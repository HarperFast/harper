import { createHash, randomUUID } from 'node:crypto';
import { processIncarnation } from '../../server/threads/processIncarnation.ts';
import { contextStorage } from '../../resources/transaction.ts';
import { AccessViolation } from '../../utility/errors/hdbError.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import {
	ensureSessionTable,
	loadSession,
	patchSession,
	withSessionSubscriptionLock,
	type McpSessionRecord,
} from './session.ts';
import { getRegisteredSession } from './sessionRegistry.ts';
import { addResourceSubscription, dropSessionSubscriptions, removeResourceSubscription } from './subscriptions.ts';
import type { AuthedUser } from './toolRegistry.ts';

const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const MAX_PENDING = 100;
const MAX_PENDING_PER_SESSION = 25;
const pendingBySession = new Map<string, number>();
let responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS;
let pending = 0;
const localPrincipals = new Map<string, AuthedUser>();

type SubscriptionRouteResult =
	| 'success'
	| 'not-subscribable'
	| 'permission-denied'
	| 'no-live-stream'
	| 'session-gone'
	| 'timeout'
	| 'internal-error';
type Rejected = NonNullable<McpSessionRecord['subscriptionAck']>['rejected'];
type Watcher = { end(): void; on?: (event: string, listener: () => void) => void };

export function _setSubscriptionTimeoutForTest(value: number | undefined): void {
	responseTimeoutMs = value ?? DEFAULT_RESPONSE_TIMEOUT_MS;
}

export function _pendingSubscriptionRouteCount(): number {
	return pending;
}

async function watchSession(
	id: string,
	listener: (session: McpSessionRecord | null) => void,
	failed: () => void
): Promise<Watcher> {
	const subscription = await contextStorage.exit(() =>
		(ensureSessionTable() as any).subscribe({
			id,
			omitCurrent: true,
			listener(event: any) {
				if (event instanceof Error) {
					failed();
					return;
				}
				if (event?.type === 'reload') {
					void loadSession(id).then(listener, failed);
				} else listener(event?.value ?? null);
				event?.acknowledge?.();
			},
		})
	);
	subscription.on?.('close', failed);
	return subscription;
}

function retainedPrincipals(
	principals: Record<string, AuthedUser> | undefined,
	ids: Record<string, string>
): Record<string, AuthedUser> {
	const retained = new Set(Object.values(ids));
	return Object.fromEntries(Object.entries(principals ?? {}).filter(([id]) => retained.has(id)));
}

function subscriptionUser(user: AuthedUser): AuthedUser {
	return {
		...(user.username !== undefined ? { username: user.username } : {}),
		...(user.authExpiresAt !== undefined ? { authExpiresAt: user.authExpiresAt } : {}),
		_scopedToken: true,
		...(user.role
			? {
					role: {
						...(user.role.role !== undefined ? { role: user.role.role } : {}),
						...(user.role.permission ? { permission: user.role.permission } : {}),
					},
				}
			: {}),
	};
}

function restorePrincipal(principal: AuthedUser | undefined, owner: AuthedUser): AuthedUser | undefined {
	if (!principal || principal._scopedToken === true) return principal;
	return (principal.authExpiresAt ?? Infinity) < (owner.authExpiresAt ?? Infinity)
		? { ...owner, authExpiresAt: principal.authExpiresAt }
		: owner;
}

function subscriptionScope(user: AuthedUser): string {
	return JSON.stringify({ ...subscriptionUser(user), authExpiresAt: undefined });
}

export async function claimSubscriptionOwner(sessionId: string, streamToken: string): Promise<boolean> {
	const record = getRegisteredSession(sessionId);
	if (!record || record.streamToken !== streamToken) return false;
	let stopped = false;
	let claimed = false;
	let initializing = true;
	let dirty = false;
	let running: Promise<void> | undefined;
	let seenRevision = -1;
	let watcher: Watcher | undefined;
	const installed = new Map<string, string>();
	const rejected: Rejected = Object.create(null);
	const reconnectScope = record.user._scopedToken ? subscriptionScope(record.user) : undefined;
	const restoredScopes = new Map<string, string>();
	const close = () => {
		if (stopped) return;
		stopped = true;
		watcher?.end();
		dropSessionSubscriptions(sessionId);
		void withSessionSubscriptionLock(sessionId, async (session) => {
			if (session?.streamToken === streamToken) await patchSession(sessionId, { streamToken: undefined });
		}).catch((error) => harperLogger.trace('MCP stream close could not clear its token', error));
	};
	record.queue.once('close', close);
	const fail = () => record.queue.close();
	const current = () => !stopped && getRegisteredSession(sessionId) === record;
	async function install(uri: string, user: AuthedUser): Promise<boolean> {
		let onClose!: () => void;
		const closed = new Promise<boolean>((resolve) => {
			onClose = () => resolve(false);
			record.queue.once('close', onClose);
		});
		const timer = setTimeout(fail, responseTimeoutMs);
		try {
			return await Promise.race([addResourceSubscription(sessionId, uri, user), closed]);
		} finally {
			clearTimeout(timer);
			record.queue.off('close', onClose);
		}
	}
	const schedule = () => {
		if (!current()) return;
		dirty = true;
		if (!running) {
			running = reconcile()
				.catch((error) => {
					harperLogger.trace('MCP subscription reconciliation failed', error);
					fail();
				})
				.finally(() => {
					running = undefined;
					if (dirty && current()) schedule();
				});
		}
	};
	async function reconcile(): Promise<void> {
		while (dirty && current()) {
			dirty = false;
			const session = await loadSession(sessionId);
			if (!current()) return;
			if (!session || session.streamToken !== streamToken) {
				fail();
				return;
			}
			const revision = session.subscriptionRevision ?? 0;
			if (
				revision === seenRevision &&
				session.subscriptionAck?.token === streamToken &&
				session.subscriptionAck.revision === revision
			)
				continue;
			seenRevision = revision;
			const uris = new Set(session.subscriptions ?? []);
			if (revision === 0 && uris.size === 0) continue;
			const generationOf = (uri: string) => session.subscriptionGenerations?.[uri] ?? '';
			for (const uri of installed.keys()) {
				if (!uris.has(uri)) {
					removeResourceSubscription(sessionId, uri);
					installed.delete(uri);
				}
			}
			for (const uri of Object.keys(rejected)) {
				if (
					!uris.has(uri) ||
					rejected[uri].generation !== generationOf(uri) ||
					rejected[uri].result === 'internal-error'
				)
					delete rejected[uri];
			}
			for (const uri of uris) {
				const generation = generationOf(uri);
				if (installed.get(uri) === generation || rejected[uri]) continue;
				const principalId = session.subscriptionPrincipalIds?.[uri];
				const user =
					localPrincipals.get(generation) ??
					(principalId ? restorePrincipal(session.subscriptionPrincipals?.[principalId], record.user) : record.user);
				try {
					let differentScopedGrant = false;
					if (initializing && reconnectScope !== undefined && user) {
						let scope =
							user === record.user ? reconnectScope : principalId ? restoredScopes.get(principalId) : undefined;
						if (scope === undefined) {
							scope = subscriptionScope(user);
							if (principalId) restoredScopes.set(principalId, scope);
						}
						differentScopedGrant = scope !== reconnectScope;
					}
					if (
						!user ||
						differentScopedGrant ||
						(user.authExpiresAt !== undefined && Date.now() >= user.authExpiresAt * 1000)
					) {
						rejected[uri] = { generation, result: 'permission-denied' };
					} else if (await install(uri, user)) installed.set(uri, generation);
					else rejected[uri] = { generation, result: 'not-subscribable' };
				} catch (error) {
					rejected[uri] = {
						generation,
						result: error instanceof AccessViolation ? 'permission-denied' : 'internal-error',
					};
					if (initializing && rejected[uri].result === 'internal-error') {
						fail();
						return;
					}
				}
				if (!current()) return;
				const latest = await loadSession(sessionId);
				if (!current()) return;
				if (!latest || latest.streamToken !== streamToken) {
					fail();
					return;
				}
				if ((latest.subscriptionRevision ?? 0) !== revision) {
					dirty = true;
					break;
				}
			}
			if (dirty || !current()) continue;
			await withSessionSubscriptionLock(sessionId, async (latest) => {
				if (!current() || latest?.streamToken !== streamToken) return;
				if ((latest.subscriptionRevision ?? 0) !== revision) {
					dirty = true;
					return;
				}
				const terminal = new Set(Object.keys(rejected).filter((uri) => rejected[uri].result !== 'internal-error'));
				const generations: Record<string, string> = Object.assign(Object.create(null), latest.subscriptionGenerations);
				const principalIds: Record<string, string> = Object.assign(
					Object.create(null),
					latest.subscriptionPrincipalIds
				);
				for (const uri of terminal) {
					removeResourceSubscription(sessionId, uri);
					installed.delete(uri);
					delete generations[uri];
					delete principalIds[uri];
				}
				const appliedRevision = terminal.size ? revision + 1 : revision;
				seenRevision = appliedRevision;
				await patchSession(sessionId, {
					...(terminal.size
						? {
								subscriptions: latest.subscriptions?.filter((uri) => !terminal.has(uri)),
								subscriptionGenerations: generations,
								subscriptionPrincipalIds: principalIds,
								subscriptionPrincipals: retainedPrincipals(latest.subscriptionPrincipals, principalIds),
								subscriptionRevision: appliedRevision,
							}
						: {}),
					subscriptionAck: { token: streamToken, revision: appliedRevision, rejected: { ...rejected } },
				});
			});
		}
	}
	try {
		watcher = await watchSession(
			sessionId,
			(session) => {
				if (!claimed || !current()) return;
				if (!session || session.streamToken !== streamToken || (session.subscriptionRevision ?? 0) !== seenRevision)
					schedule();
			},
			fail
		);
		if (!current()) {
			watcher.end();
			return false;
		}
		const present = await withSessionSubscriptionLock(sessionId, async (session) => {
			if (!session || !current()) return false;
			await patchSession(sessionId, { streamToken });
			return true;
		});
		if (!present || !current()) {
			fail();
			return false;
		}
		claimed = true;
		schedule();
		await running;
		initializing = false;
		restoredScopes.clear();
		return current();
	} catch (error) {
		fail();
		harperLogger.trace('MCP subscription watcher could not open', error);
		return false;
	}
}

async function waitForApplied(
	id: string,
	revision: number,
	uri: string,
	generation: string | undefined
): Promise<SubscriptionRouteResult> {
	let watcher: Watcher | undefined;
	let settled = false;
	let resolveResult!: (result: SubscriptionRouteResult) => void;
	const result = new Promise<SubscriptionRouteResult>((resolve) => (resolveResult = resolve));
	const finish = (value: SubscriptionRouteResult) => {
		if (settled) return;
		settled = true;
		resolveResult(value);
	};
	const inspect = (session: McpSessionRecord | null) => {
		if (!session) return finish('session-gone');
		if (!session.streamToken) {
			if (generation === undefined) finish('success');
			return;
		}
		const ack = session.subscriptionAck;
		// A coalesced reconcile may apply several revisions at once; only the current token can acknowledge them.
		if (!ack || ack.token !== session.streamToken || ack.revision < revision) return;
		if (generation !== undefined) {
			const rejection = ack.rejected[uri];
			if (rejection?.generation === generation) return finish(rejection.result);
			if (session.subscriptionGenerations?.[uri] !== generation) return finish('internal-error');
		}
		finish('success');
	};
	const timer = setTimeout(() => finish('timeout'), responseTimeoutMs);
	try {
		watcher = await watchSession(id, inspect, () => finish('internal-error'));
		inspect(await loadSession(id));
		return await result;
	} finally {
		settled = true;
		clearTimeout(timer);
		watcher?.end();
	}
}

export async function updateResourceSubscription(args: {
	session: McpSessionRecord;
	operation: 'subscribe' | 'unsubscribe';
	uri: string;
	user?: AuthedUser;
}): Promise<SubscriptionRouteResult> {
	const { session, operation, uri, user } = args;
	const sessionPending = pendingBySession.get(session.id) ?? 0;
	if (pending >= MAX_PENDING || sessionPending >= MAX_PENDING_PER_SESSION) return 'internal-error';
	pending++;
	pendingBySession.set(session.id, sessionPending + 1);
	const generation = operation === 'subscribe' ? randomUUID() : undefined;
	let outcome: SubscriptionRouteResult = 'internal-error';
	if (generation && user) localPrincipals.set(generation, user);
	try {
		const changed = await withSessionSubscriptionLock(session.id, async (latest) => {
			if (!latest) return { result: 'session-gone' as const };
			const live = !!processIncarnation && latest.streamToken?.startsWith(`${processIncarnation}:`) === true;
			if (operation === 'subscribe' && (!live || !user)) return { result: 'no-live-stream' as const };
			if (operation === 'subscribe' && !URL.canParse(uri)) return { result: 'not-subscribable' as const };
			const subscriptions = (latest.subscriptions ?? []).filter((value) => value !== uri);
			const generations: Record<string, string> = Object.assign(Object.create(null), latest.subscriptionGenerations);
			const principalIds: Record<string, string> = Object.assign(Object.create(null), latest.subscriptionPrincipalIds);
			const principals = { ...latest.subscriptionPrincipals };
			delete generations[uri];
			delete principalIds[uri];
			if (generation) {
				subscriptions.push(uri);
				generations[uri] = generation;
				if (user?._scopedToken || user?.authExpiresAt !== undefined) {
					const principal = user._scopedToken ? subscriptionUser(user) : { authExpiresAt: user.authExpiresAt };
					const id = createHash('sha256').update(JSON.stringify(principal)).digest('hex');
					principalIds[uri] = id;
					principals[id] = principal;
				}
			}
			const revision = (latest.subscriptionRevision ?? 0) + 1;
			await patchSession(session.id, {
				subscriptions,
				subscriptionGenerations: generations,
				subscriptionPrincipalIds: principalIds,
				subscriptionPrincipals: retainedPrincipals(principals, principalIds),
				subscriptionRevision: revision,
			});
			return { revision, live };
		});
		outcome =
			'result' in changed
				? changed.result
				: !changed.live
					? 'success'
					: await waitForApplied(session.id, changed.revision, uri, generation);
	} catch (error) {
		harperLogger.trace('MCP subscription state update failed', error);
	} finally {
		if (generation && outcome !== 'success') {
			try {
				await withSessionSubscriptionLock(session.id, async (latest) => {
					if (latest?.subscriptionGenerations?.[uri] !== generation) return;
					const generations: Record<string, string> = Object.assign(
						Object.create(null),
						latest.subscriptionGenerations
					);
					const principalIds: Record<string, string> = Object.assign(
						Object.create(null),
						latest.subscriptionPrincipalIds
					);
					delete generations[uri];
					delete principalIds[uri];
					await patchSession(session.id, {
						subscriptions: latest.subscriptions?.filter((value) => value !== uri),
						subscriptionGenerations: generations,
						subscriptionPrincipalIds: principalIds,
						subscriptionPrincipals: retainedPrincipals(latest.subscriptionPrincipals, principalIds),
						subscriptionRevision: (latest.subscriptionRevision ?? 0) + 1,
					});
				});
			} catch (error) {
				harperLogger.trace('MCP failed subscription cleanup failed', error);
			}
		}
		if (generation) localPrincipals.delete(generation);
		pending--;
		const remaining = pendingBySession.get(session.id)! - 1;
		if (remaining) pendingBySession.set(session.id, remaining);
		else pendingBySession.delete(session.id);
	}
	return outcome;
}
