import { isMainThread, threadId } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { serialize } from 'node:v8';
import type { FullTextContinuationOwnerCommand, FullTextContinuationOwnerResult } from './fullTextContinuationOwner.ts';
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS, ITC_EVENT_TYPES } from '../../utility/hdbTerms.ts';
import { hasThreadExited, onThreadExit, sendToThread } from '../../server/threads/manageThreads.js';
import {
	fullTextContinuationDeadline,
	type FullTextSearchLimits,
	resolveFullTextSearchLimits,
} from './fullTextSearchLimits.ts';
export { fullTextContinuationDeadline } from './fullTextSearchLimits.ts';

export type FullTextCursorClaim = { id: string; expires: bigint; expiresAt: number };
type Claim = FullTextCursorClaim & { owner: number; bytes: number; admissionDeadline?: bigint };
type Command =
	| { operation: 'admit'; bytes: number }
	| { operation: 'release'; id: string }
	| { operation: 'confirm'; id: string }
	| FullTextContinuationOwnerCommand;
type Result = FullTextCursorClaim | FullTextContinuationOwnerResult | undefined;
type Request = { id: string; originator: number; deadline: bigint; command: Command };
type Reply = {
	id: string;
	originator: number;
	value?: Result;
	error?: { status?: number; message: string; code?: string };
};
type Pending = {
	owner: number;
	resolve(value: Result): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
	bytes: number;
};

const claims = new Map<string, Claim>();
const pending = new Map<string, Pending>();
let retainedBytes = 0;
let pendingBytes = 0;
let expiryTimer: NodeJS.Timeout | undefined;

function limits() {
	return resolveFullTextSearchLimits(env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT));
}

export async function reserveFullTextContinuation(bytes: number, deadline: bigint): Promise<FullTextCursorClaim> {
	return (await request({ operation: 'admit', bytes }, deadline)) as FullTextCursorClaim;
}

export async function confirmFullTextContinuation(id: string, deadline: bigint): Promise<void> {
	await request({ operation: 'confirm', id }, deadline);
}

export async function releaseFullTextContinuation(id: string): Promise<void> {
	await request({ operation: 'release', id }, fullTextContinuationDeadline(limits()));
}

export async function requestFullTextContinuationOwner(
	owner: number,
	command: FullTextContinuationOwnerCommand,
	deadline: bigint
): Promise<FullTextContinuationOwnerResult> {
	if (hasThreadExited(owner)) throw new ClientError('Full-text continuation expired; start a new search', 410);
	return (await request(command, deadline, owner)) as FullTextContinuationOwnerResult;
}

async function request(command: Command, deadline: bigint, owner = 0): Promise<Result> {
	const policy = limits();
	millisecondsRemaining(deadline, policy);
	if (!Number.isSafeInteger(owner) || owner < 0 || hasThreadExited(owner)) throw unavailable();
	if (owner === threadId) return execute(command, threadId, deadline, policy);
	const remaining = millisecondsRemaining(deadline, policy);
	const bytes =
		command.operation === 'read'
			? command.responseBytes
			: command.operation === 'seal' || command.operation === 'resume'
				? 32 * 1024
				: 512;
	if (!Number.isSafeInteger(bytes) || bytes < 1) throw unavailable('response reservation is invalid');
	if (pending.size >= policy.maxPendingRequests) throw unavailable('reached storage.fullText.maxPendingRequests');
	if (bytes > policy.maxPendingResponseBytes - pendingBytes)
		throw unavailable('exceeded storage.fullText.maxPendingResponseBytes');
	const id = randomBytes(16).toString('hex');
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			removePending(id);
			reject(unavailable('exceeded its request budget'));
		}, remaining);
		timer.unref();
		pending.set(id, { owner, resolve, reject, timer, bytes });
		pendingBytes += bytes;
		try {
			const sent = sendToThread(owner, {
				type: ITC_EVENT_TYPES.FULL_TEXT_CONTINUATION_REQUEST,
				message: { id, originator: threadId, deadline, command },
			});
			if (!sent) throw unavailable();
		} catch (error) {
			removePending(id);
			reject(error);
		}
	});
}

function removePending(id: string): Pending | undefined {
	const waiting = pending.get(id);
	if (!waiting) return;
	pending.delete(id);
	clearTimeout(waiting.timer);
	pendingBytes -= waiting.bytes;
	return waiting;
}

async function execute(
	command: Command,
	owner: number,
	deadline: bigint,
	policy: FullTextSearchLimits = limits()
): Promise<Result> {
	millisecondsRemaining(deadline, policy);
	if (command?.operation === 'admit' || command?.operation === 'confirm' || command?.operation === 'release') {
		if (!isMainThread) throw unavailable();
		return dispatch(command, owner, deadline, policy);
	}
	const { executeFullTextContinuationOwner } = await import('./fullTextContinuationOwner.ts');
	return executeFullTextContinuationOwner(command, deadline);
}

export function fullTextContinuationResponse(event: { message?: Reply }, sender: number): void {
	const reply = event.message;
	if (!reply || reply.originator !== sender) return;
	const waiting = pending.get(reply.id);
	if (!waiting || waiting.owner !== sender) return;
	removePending(reply.id);
	if (serialize(reply).byteLength > waiting.bytes) {
		waiting.reject(unavailable());
		return;
	}
	if (reply.error) {
		const error =
			reply.error.status === undefined
				? new Error(reply.error.message)
				: reply.error.status >= 500
					? new ServerError(reply.error.message, reply.error.status)
					: new ClientError(reply.error.message, reply.error.status);
		if (reply.error.code) Object.assign(error, { code: reply.error.code });
		waiting.reject(error);
	} else waiting.resolve(reply.value);
}

export async function fullTextContinuationRequest(event: { message?: Request }, sender: number): Promise<void> {
	const message = event.message;
	if (!message || message.originator !== sender || typeof message.id !== 'string' || message.id.length !== 32) return;
	let reply: Reply;
	try {
		reply = { id: message.id, originator: threadId, value: await execute(message.command, sender, message.deadline) };
	} catch (error) {
		reply = {
			id: message.id,
			originator: threadId,
			error: {
				status: error.statusCode,
				message: error.message,
				code: typeof error.code === 'string' ? error.code : undefined,
			},
		};
	}
	try {
		if (
			!sendToThread(sender, { type: ITC_EVENT_TYPES.FULL_TEXT_CONTINUATION_RESPONSE, message: reply }) &&
			message.command.operation === 'admit' &&
			reply.value
		)
			release((reply.value as FullTextCursorClaim).id, sender);
	} catch {
		if (message.command.operation === 'admit' && reply.value) release((reply.value as FullTextCursorClaim).id, sender);
	}
}

function dispatch(
	command: Command,
	owner: number,
	deadline: bigint,
	policy: FullTextSearchLimits
): FullTextCursorClaim | undefined {
	millisecondsRemaining(deadline, policy);
	if (hasThreadExited(owner)) throw unavailable();
	if (command?.operation === 'confirm') {
		prune();
		const claim = claims.get(command.id);
		if (!claim || claim.owner !== owner) throw new ClientError('Full-text continuation admission expired', 410);
		delete claim.admissionDeadline;
		armExpiry();
		return;
	}
	if (command?.operation === 'release') {
		const claim = claims.get(command.id);
		if (claim && claim.owner !== owner) throw unavailable('cannot release a claim owned by another worker');
		release(command.id, owner);
		return;
	}
	if (command?.operation !== 'admit' || !Number.isSafeInteger(command.bytes) || command.bytes < 1) throw unavailable();
	prune();
	if (claims.size >= policy.maxCursors) throw unavailable('reached storage.fullText.maxCursors');
	if (command.bytes > policy.maxRetainedQueryBytes - retainedBytes)
		throw unavailable('exceeded storage.fullText.maxRetainedQueryBytes');
	const claim: Claim = {
		id: randomBytes(16).toString('hex'),
		owner,
		bytes: command.bytes,
		admissionDeadline: process.hrtime.bigint() + BigInt(millisecondsRemaining(deadline, policy)) * 1_000_000n,
		expires: process.hrtime.bigint() + BigInt(policy.cursorTtlMilliseconds) * 1_000_000n,
		expiresAt: Date.now() + policy.cursorTtlMilliseconds,
	};
	claims.set(claim.id, claim);
	retainedBytes += claim.bytes;
	armExpiry();
	return { id: claim.id, expires: claim.expires, expiresAt: claim.expiresAt };
}

function release(id: string, owner: number): void {
	const claim = claims.get(id);
	if (claim?.owner !== owner) return;
	claims.delete(id);
	retainedBytes -= claim.bytes;
	armExpiry();
}

function prune(): void {
	const now = process.hrtime.bigint();
	for (const [id, claim] of claims) {
		if (
			claim.expires <= now ||
			(claim.admissionDeadline !== undefined && claim.admissionDeadline <= now) ||
			hasThreadExited(claim.owner)
		) {
			claims.delete(id);
			retainedBytes -= claim.bytes;
		}
	}
}

function armExpiry(): void {
	clearTimeout(expiryTimer);
	expiryTimer = undefined;
	let earliest: bigint | undefined;
	for (const claim of claims.values()) {
		const expires =
			claim.admissionDeadline === undefined || claim.expires < claim.admissionDeadline
				? claim.expires
				: claim.admissionDeadline;
		if (earliest === undefined || expires < earliest) earliest = expires;
	}
	if (earliest === undefined) return;
	const delay = Math.max(1, Number((earliest - process.hrtime.bigint()) / 1_000_000n));
	expiryTimer = setTimeout(() => {
		prune();
		armExpiry();
	}, delay);
	expiryTimer.unref();
}

function millisecondsRemaining(deadline: bigint, policy: FullTextSearchLimits): number {
	if (typeof deadline !== 'bigint') throw unavailable();
	const remaining = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
	if (remaining < 1) throw unavailable('exceeded its request budget');
	return Math.min(remaining, policy.requestBudgetMilliseconds, 0x7fffffff);
}

function unavailable(reason = 'capacity is unavailable'): ServerError {
	return new ServerError(`Full-text continuation ${reason}; retry this search`, 503);
}

onThreadExit((owner: number) => {
	for (const [id, waiting] of pending) {
		if (waiting.owner !== owner) continue;
		removePending(id);
		waiting.reject(new ClientError('Full-text continuation expired; start a new search', 410));
	}
	if (isMainThread) {
		prune();
		armExpiry();
	}
});
