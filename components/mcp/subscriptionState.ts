import { randomUUID } from 'node:crypto';
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
let responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS;
let pending = 0;
const localPrincipals = new Map<string, AuthedUser>();

export type SubscriptionRouteResult =
	'success' | 'not-subscribable' | 'permission-denied' | 'no-live-stream' | 'timeout' | 'internal-error';
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

export function subscriptionUser(user: AuthedUser): AuthedUser {
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

export async function claimSubscriptionOwner(sessionId: string, streamToken: string): Promise<boolean> {
	const record = getRegisteredSession(sessionId);
	if (!record || record.streamToken !== streamToken) return false;
	let stopped = false;
	let claimed = false;
	let dirty = false;
	let running: Promise<void> | undefined;
	let seenRevision = -1;
	let watcher: Watcher | undefined;
	const installed = new Map<string, string>();
	const rejected: Rejected = {};
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
	const fail = () => record.queue.emit('close');
	const current = () => !stopped && getRegisteredSession(sessionId) === record;
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
			const generationOf = (uri: string) => session.subscriptionGenerations?.[uri] ?? '';
			for (const [uri, generation] of installed) {
				if (!uris.has(uri) || generationOf(uri) !== generation) {
					removeResourceSubscription(sessionId, uri);
					installed.delete(uri);
				}
			}
			for (const uri of Object.keys(rejected)) {
				if (!uris.has(uri) || rejected[uri].generation !== generationOf(uri)) delete rejected[uri];
			}
			for (const uri of uris) {
				const generation = generationOf(uri);
				if (installed.has(uri) || rejected[uri]) continue;
				const user = localPrincipals.get(generation) ?? session.subscriptionPrincipals?.[uri] ?? record.user;
				try {
					if (user.authExpiresAt !== undefined && Date.now() >= user.authExpiresAt * 1000) {
						rejected[uri] = { generation, result: 'permission-denied' };
					} else if (await addResourceSubscription(sessionId, uri, user)) installed.set(uri, generation);
					else rejected[uri] = { generation, result: 'not-subscribable' };
				} catch (error) {
					rejected[uri] = {
						generation,
						result: error instanceof AccessViolation ? 'permission-denied' : 'internal-error',
					};
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
				const generations = { ...latest.subscriptionGenerations };
				const principals = { ...latest.subscriptionPrincipals };
				for (const uri of terminal) {
					delete generations[uri];
					delete principals[uri];
				}
				const appliedRevision = terminal.size ? revision + 1 : revision;
				seenRevision = appliedRevision;
				await patchSession(sessionId, {
					...(terminal.size
						? {
								subscriptions: latest.subscriptions?.filter((uri) => !terminal.has(uri)),
								subscriptionGenerations: generations,
								subscriptionPrincipals: principals,
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
		return current();
	} catch (error) {
		fail();
		throw error;
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
		if (!session) return finish('no-live-stream');
		if (!session.streamToken) return;
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
	if (pending >= MAX_PENDING) return 'internal-error';
	pending++;
	const { session, operation, uri, user } = args;
	const generation = operation === 'subscribe' ? randomUUID() : undefined;
	let outcome: SubscriptionRouteResult = 'internal-error';
	if (generation && user) localPrincipals.set(generation, user);
	try {
		const changed = await withSessionSubscriptionLock(session.id, async (latest) => {
			if (!latest) return { result: 'no-live-stream' as const };
			if (operation === 'subscribe' && (!latest.streamToken || !user)) return { result: 'no-live-stream' as const };
			const subscriptions = (latest.subscriptions ?? []).filter((value) => value !== uri);
			const generations = { ...latest.subscriptionGenerations };
			const principals = { ...latest.subscriptionPrincipals };
			delete generations[uri];
			delete principals[uri];
			if (generation) {
				subscriptions.push(uri);
				generations[uri] = generation;
				if (user?._scopedToken) principals[uri] = subscriptionUser(user);
			}
			const revision = (latest.subscriptionRevision ?? 0) + 1;
			await patchSession(session.id, {
				subscriptions,
				subscriptionGenerations: generations,
				subscriptionPrincipals: principals,
				subscriptionRevision: revision,
			});
			return { revision, live: !!latest.streamToken };
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
					const generations = { ...latest.subscriptionGenerations };
					const principals = { ...latest.subscriptionPrincipals };
					delete generations[uri];
					delete principals[uri];
					await patchSession(session.id, {
						subscriptions: latest.subscriptions?.filter((value) => value !== uri),
						subscriptionGenerations: generations,
						subscriptionPrincipals: principals,
						subscriptionRevision: (latest.subscriptionRevision ?? 0) + 1,
					});
				});
			} catch (error) {
				harperLogger.trace('MCP failed subscription cleanup failed', error);
			}
		}
		if (generation) localPrincipals.delete(generation);
		pending--;
	}
	return outcome;
}
