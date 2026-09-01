/** Route MCP resource-subscription commands to the worker owning the GET-SSE stream. */
import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { ITC_EVENT_TYPES } from '../../utility/hdbTerms.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { loadSession, patchSession, type McpSessionRecord } from './session.ts';
import { getRegisteredSession } from './sessionRegistry.ts';
import { addResourceSubscription, removeResourceSubscription } from './subscriptions.ts';
import type { AuthedUser } from './toolRegistry.ts';

const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const MAX_PENDING = 100;
const MAX_PENDING_PER_SESSION = 25;

export type SubscriptionRouteResult = 'success' | 'not-subscribable' | 'no-live-stream' | 'timeout' | 'internal-error';
type Operation = 'subscribe' | 'unsubscribe';

interface Command {
	requestId: string;
	originator: number;
	sessionId: string;
	streamToken: string;
	operation: Operation;
	uri: string;
	user?: AuthedUser;
}

interface Response {
	requestId: string;
	originator: number;
	result: SubscriptionRouteResult;
}

function isCommand(value: unknown): value is Command {
	if (!value || typeof value !== 'object') return false;
	const command = value as Partial<Command>;
	return (
		typeof command.requestId === 'string' &&
		typeof command.originator === 'number' &&
		typeof command.sessionId === 'string' &&
		typeof command.streamToken === 'string' &&
		(command.operation === 'subscribe' || command.operation === 'unsubscribe') &&
		typeof command.uri === 'string' &&
		(command.user === undefined || (command.user !== null && typeof command.user === 'object'))
	);
}

interface ItcBridge {
	available?: boolean;
	sendToThread(threadId: number, event: { type: string; message: unknown }): boolean;
	onMessageByType(type: string, listener: (event: { message?: unknown }) => void): void;
}

// manageThreads assigns this connected-port array as the package-global `threads` export. Its
// direct-send helper lives on that array, while typed listener registration is a module export.
declare const threads: { sendToThread(threadId: number, event: { type: string; message: unknown }): boolean };

interface Pending {
	sessionId: string;
	targetThreadId: number;
	resolve: (result: SubscriptionRouteResult) => void;
	timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
const operationChains = new Map<string, Promise<unknown>>();
let wired = false;
let bridgeOverride: ItcBridge | undefined;
let currentThreadId = (): number => threadId;
let responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS;

function bridge(): ItcBridge {
	if (bridgeOverride) return bridgeOverride;
	try {
		const { onMessageByType } = require('../../server/threads/manageThreads.js');
		if (typeof threads !== 'undefined' && typeof threads.sendToThread === 'function') {
			return { available: true, sendToThread: threads.sendToThread.bind(threads), onMessageByType };
		}
	} catch (error) {
		harperLogger.trace(`MCP subscription routing is unavailable: ${(error as Error).message}`);
		return { available: false, sendToThread: () => false, onMessageByType: () => {} };
	}
	harperLogger.trace('MCP subscription routing is unavailable: thread bridge is not initialized');
	return { available: false, sendToThread: () => false, onMessageByType: () => {} };
}

export function _setSubscriptionItcForTest(fake: ItcBridge | undefined): void {
	bridgeOverride = fake;
	wired = false;
}

export function _setSubscriptionThreadIdForTest(value: number | undefined): void {
	currentThreadId = value === undefined ? () => threadId : () => value;
}

export function _setSubscriptionTimeoutForTest(value: number | undefined): void {
	responseTimeoutMs = value ?? DEFAULT_RESPONSE_TIMEOUT_MS;
}

export function _resetSubscriptionRoutingForTest(): void {
	for (const entry of pending.values()) clearTimeout(entry.timer);
	pending.clear();
	operationChains.clear();
	wired = false;
	currentThreadId = () => threadId;
	responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS;
}

export function _pendingSubscriptionRouteCount(): number {
	return pending.size;
}

function ensureWired(): void {
	if (wired) return;
	const itc = bridge();
	if (itc.available === false) return;
	itc.onMessageByType(ITC_EVENT_TYPES.MCP_SUBSCRIPTION_COMMAND, (event) => {
		const command = event.message;
		if (!isCommand(command)) {
			harperLogger.warn('Ignoring malformed MCP subscription command');
			return;
		}
		void handleCommand(command).catch((error) => {
			harperLogger.error('MCP subscription command failed', error);
			sendResponse(command, 'internal-error');
		});
	});
	itc.onMessageByType(ITC_EVENT_TYPES.MCP_SUBSCRIPTION_RESPONSE, (event) => {
		const response = event.message as Response;
		const entry = pending.get(response?.requestId);
		if (!entry || response.originator !== entry.targetThreadId) return;
		if (!['success', 'not-subscribable', 'no-live-stream', 'timeout', 'internal-error'].includes(response.result))
			return;
		clearTimeout(entry.timer);
		pending.delete(response.requestId);
		entry.resolve(response.result);
	});
	wired = true;
}

export async function claimSubscriptionOwner(sessionId: string, streamToken: string): Promise<void> {
	ensureWired();
	await patchSession(sessionId, { streamOwner: { threadId: currentThreadId(), token: streamToken } });
}

function countPendingForSession(sessionId: string): number {
	let count = 0;
	for (const entry of pending.values()) if (entry.sessionId === sessionId) count++;
	return count;
}

function subscriptionUser(user: AuthedUser): AuthedUser {
	return {
		...(user.username !== undefined ? { username: user.username } : {}),
		...(user.authExpiresAt !== undefined ? { authExpiresAt: user.authExpiresAt } : {}),
		...(user._scopedToken ? { _scopedToken: true } : {}),
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

function routeRemote(
	owner: NonNullable<McpSessionRecord['streamOwner']>,
	command: Omit<Command, 'requestId' | 'originator' | 'streamToken'>
): Promise<SubscriptionRouteResult> {
	ensureWired();
	if (pending.size >= MAX_PENDING || countPendingForSession(command.sessionId) >= MAX_PENDING_PER_SESSION) {
		return Promise.resolve('internal-error');
	}
	const requestId = randomUUID();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(requestId);
			resolve('timeout');
		}, responseTimeoutMs);
		timer.unref();
		pending.set(requestId, { sessionId: command.sessionId, targetThreadId: owner.threadId, resolve, timer });
		let sent = false;
		try {
			sent = bridge().sendToThread(owner.threadId, {
				type: ITC_EVENT_TYPES.MCP_SUBSCRIPTION_COMMAND,
				message: { ...command, requestId, originator: currentThreadId(), streamToken: owner.token },
			});
		} catch (error) {
			harperLogger.error('Unable to route MCP subscription command', error);
		}
		if (!sent) {
			clearTimeout(timer);
			pending.delete(requestId);
			resolve('no-live-stream');
		}
	});
}

export function withSessionSubscriptionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
	const previous = operationChains.get(sessionId) ?? Promise.resolve();
	const current = previous.then(operation, operation);
	const tail = current
		.then(
			() => undefined,
			() => undefined
		)
		.finally(() => {
			if (operationChains.get(sessionId) === tail) operationChains.delete(sessionId);
		});
	operationChains.set(sessionId, tail);
	return current;
}

async function executeLocal(command: Command): Promise<SubscriptionRouteResult> {
	const registered = getRegisteredSession(command.sessionId);
	if (!registered || registered.streamToken !== command.streamToken) return 'no-live-stream';
	return withSessionSubscriptionLock(command.sessionId, async () => {
		if (command.operation === 'subscribe') {
			if (!command.user) return 'internal-error';
			const added = await addResourceSubscription(command.sessionId, command.uri, command.user);
			if (!added) return 'not-subscribable';
			try {
				const session = await loadSession(command.sessionId);
				if (!session) {
					removeResourceSubscription(command.sessionId, command.uri);
					return 'no-live-stream';
				}
				if (!session.subscriptions?.includes(command.uri)) {
					await patchSession(command.sessionId, {
						subscriptions: [...(session.subscriptions ?? []), command.uri],
					});
				}
				return 'success';
			} catch (error) {
				removeResourceSubscription(command.sessionId, command.uri);
				throw error;
			}
		}
		const session = await loadSession(command.sessionId);
		if (session?.subscriptions?.includes(command.uri)) {
			await patchSession(command.sessionId, {
				subscriptions: session.subscriptions.filter((uri) => uri !== command.uri),
			});
		}
		removeResourceSubscription(command.sessionId, command.uri);
		return 'success';
	});
}

async function handleCommand(command: Command): Promise<void> {
	let result: SubscriptionRouteResult;
	try {
		result = await executeLocal(command);
	} catch (error) {
		harperLogger.error('MCP subscription owner failed to execute command', error);
		result = 'internal-error';
	}
	sendResponse(command, result);
}

function sendResponse(command: Command, result: SubscriptionRouteResult): void {
	try {
		bridge().sendToThread(command.originator, {
			type: ITC_EVENT_TYPES.MCP_SUBSCRIPTION_RESPONSE,
			message: { requestId: command.requestId, originator: currentThreadId(), result } satisfies Response,
		});
	} catch (error) {
		harperLogger.trace(`Unable to return MCP subscription response: ${(error as Error).message}`);
	}
}

export async function routeResourceSubscription(args: {
	session: McpSessionRecord;
	operation: Operation;
	uri: string;
	user?: AuthedUser;
}): Promise<SubscriptionRouteResult> {
	const owner = args.session.streamOwner;
	if (!owner) return 'no-live-stream';
	const command = {
		sessionId: args.session.id,
		operation: args.operation,
		uri: args.uri,
		...(args.user ? { user: subscriptionUser(args.user) } : {}),
	};
	if (owner.threadId === currentThreadId()) {
		return executeLocal({ ...command, requestId: '', originator: currentThreadId(), streamToken: owner.token });
	}
	return routeRemote(owner, command);
}
