import { isMainThread, threadId } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS, ITC_EVENT_TYPES } from '../../utility/hdbTerms.ts';
import { hasThreadExited, onThreadExit, sendToThread } from '../../server/threads/manageThreads.js';
import { resolveFullTextSearchLimits } from './fullTextSearchLimits.ts';

export type FullTextCursorClaim = { id: string; expires: bigint; expiresAt: number };
type Claim = FullTextCursorClaim & { owner: number; bytes: number; admissionDeadline?: bigint };
type Command =
	{ operation: 'admit'; bytes: number } | { operation: 'release'; id: string } | { operation: 'confirm'; id: string };
type Request = { id: string; originator: number; deadline: bigint; command: Command };
type Reply = {
	id: string;
	originator: number;
	value?: FullTextCursorClaim;
	error?: { status: number; message: string };
};
type Pending = {
	owner: number;
	resolve(value?: FullTextCursorClaim): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
};

const claims = new Map<string, Claim>();
const pending = new Map<string, Pending>();
let retainedBytes = 0;
let expiryTimer: NodeJS.Timeout | undefined;

function limits() {
	return resolveFullTextSearchLimits(env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT));
}

export function fullTextContinuationDeadline(): bigint {
	return process.hrtime.bigint() + BigInt(limits().requestBudgetMilliseconds) * 1_000_000n;
}

export async function reserveFullTextContinuation(bytes: number, deadline: bigint): Promise<FullTextCursorClaim> {
	return (await request({ operation: 'admit', bytes }, deadline))!;
}

export async function confirmFullTextContinuation(id: string, deadline: bigint): Promise<void> {
	await request({ operation: 'confirm', id }, deadline);
}

export async function releaseFullTextContinuation(id: string): Promise<void> {
	await request({ operation: 'release', id }, fullTextContinuationDeadline());
}

async function request(command: Command, deadline: bigint): Promise<FullTextCursorClaim | undefined> {
	if (isMainThread) return dispatch(command, threadId, deadline);
	if (hasThreadExited(0)) throw unavailable();
	const remaining = millisecondsRemaining(deadline);
	// Quota replies contain only a fixed-size ID and timestamps.
	const policy = limits();
	if (pending.size >= policy.maxPendingRequests || (pending.size + 1) * 512 > policy.maxPendingResponseBytes)
		throw unavailable();
	const id = randomBytes(16).toString('hex');
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(unavailable());
		}, remaining);
		timer.unref();
		pending.set(id, { owner: 0, resolve, reject, timer });
		try {
			const sent = sendToThread(0, {
				type: ITC_EVENT_TYPES.FULL_TEXT_CONTINUATION_REQUEST,
				message: { id, originator: threadId, deadline, command },
			});
			if (!sent) throw unavailable();
		} catch (error) {
			clearTimeout(timer);
			pending.delete(id);
			reject(error);
		}
	});
}

export function fullTextContinuationResponse(event: { message?: Reply }, sender: number): void {
	const reply = event.message;
	if (!reply || reply.originator !== sender) return;
	const waiting = pending.get(reply.id);
	if (!waiting || waiting.owner !== sender) return;
	clearTimeout(waiting.timer);
	pending.delete(reply.id);
	if (reply.error) waiting.reject(new ClientError(reply.error.message, reply.error.status));
	else waiting.resolve(reply.value);
}

export function fullTextContinuationRequest(event: { message?: Request }, sender: number): void {
	const message = event.message;
	if (
		!isMainThread ||
		!message ||
		message.originator !== sender ||
		typeof message.id !== 'string' ||
		message.id.length !== 32
	)
		return;
	let reply: Reply;
	try {
		reply = { id: message.id, originator: threadId, value: dispatch(message.command, sender, message.deadline) };
	} catch (error) {
		reply = {
			id: message.id,
			originator: threadId,
			error: { status: error.statusCode ?? 503, message: error.message },
		};
	}
	try {
		if (!sendToThread(sender, { type: ITC_EVENT_TYPES.FULL_TEXT_CONTINUATION_RESPONSE, message: reply }) && reply.value)
			release(reply.value.id, sender);
	} catch {
		if (reply.value) release(reply.value.id, sender);
	}
}

function dispatch(command: Command, owner: number, deadline: bigint): FullTextCursorClaim | undefined {
	millisecondsRemaining(deadline);
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
		release(command.id, owner);
		return;
	}
	if (command?.operation !== 'admit' || !Number.isSafeInteger(command.bytes) || command.bytes < 1) throw unavailable();
	prune();
	const policy = limits();
	if (claims.size >= policy.maxCursors || command.bytes > policy.maxRetainedQueryBytes - retainedBytes)
		throw unavailable();
	const claim: Claim = {
		id: randomBytes(16).toString('hex'),
		owner,
		bytes: command.bytes,
		admissionDeadline: process.hrtime.bigint() + BigInt(millisecondsRemaining(deadline)) * 1_000_000n,
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

function millisecondsRemaining(deadline: bigint): number {
	if (typeof deadline !== 'bigint') throw unavailable();
	const remaining = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
	if (remaining < 1) throw unavailable();
	return Math.min(remaining, limits().requestBudgetMilliseconds, 0x7fffffff);
}

function unavailable(): ServerError {
	return new ServerError('Full-text continuation capacity is unavailable; retry this search', 503);
}

onThreadExit((owner: number) => {
	for (const [id, waiting] of pending) {
		if (waiting.owner !== owner) continue;
		pending.delete(id);
		clearTimeout(waiting.timer);
		waiting.reject(unavailable());
	}
	if (isMainThread) {
		prune();
		armExpiry();
	}
});
