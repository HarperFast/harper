'use strict';

// Rotation-only coordination between the isolates that write the same log file. Every isolate keeps
// its own descriptor on the active log (harper_logger's per-thread `fileLoggers`), so a rename by
// one of them leaves the others appending to the archived inode until their CLOSE_LOG_FD_TIMEOUT
// fires. Compression then unlinks that inode, and anything written after gzip reached EOF is gone.
// This module makes the archived generation's quiescence provable instead of timing-dependent: the
// rotating isolate announces the generation, peers close any descriptor on it and answer, and the
// plain archive is only ever destroyed once every peer has answered or exited.
//
// Dependency-pure by construction: the thread layer injects its transport (see
// server/threads/logRotationTransport.ts), because harper_logger must never reach manageThreads.

export const LOG_GENERATION_ROTATED = 'log_generation_rotated';
export const LOG_GENERATION_CLOSED = 'log_generation_closed';

// Under manageThreads' 30s ITC default, so an unanswered generation is decided here (retain the
// plain archive) rather than by a transport backstop that cannot express "unproven".
const DEFAULT_QUIESCENCE_TIMEOUT = 15000;

interface RotationTransport {
	broadcast(message: any): void;
	sendToThread(threadId: number, message: any): void;
	onMessage(type: string, handler: (message: any) => void): void;
	onThreadExit(handler: (threadId: number) => void): void;
	peerThreadIds(): Iterable<number>;
	threadId: number;
	quiescenceTimeout?: number;
}

let transport: RotationTransport | undefined;
const sinksByPath = new Map<string, (ino: number, dev: number) => void>();
const pendingByGeneration = new Map<string, { expected: Set<number>; settle: (proven: boolean) => void }>();
let generationCounter = 0;

export function setRotationTransport(newTransport: RotationTransport) {
	transport = newTransport;
	newTransport.onMessage(LOG_GENERATION_ROTATED, (message) => {
		closeLocalDescriptorsOn(message);
		newTransport.sendToThread(message.originator, {
			type: LOG_GENERATION_CLOSED,
			generation: message.generation,
			threadId: newTransport.threadId,
		});
	});
	newTransport.onMessage(LOG_GENERATION_CLOSED, (message) => {
		recordPeerResponse(message.generation, message.threadId);
	});
	newTransport.onThreadExit((threadId) => {
		// An exited thread cannot hold a descriptor, so its exit answers every generation it owed.
		for (const generation of [...pendingByGeneration.keys()]) recordPeerResponse(generation, threadId);
	});
}

export function registerLogSink(logPath: string, closeIfInodeMatches: (ino: number, dev: number) => void) {
	sinksByPath.set(logPath, closeIfInodeMatches);
}

export function unregisterLogSink(logPath: string) {
	sinksByPath.delete(logPath);
}

export function nextGenerationId() {
	return `${process.pid}-${transport?.threadId ?? 0}-${generationCounter++}`;
}

/**
 * Tell every writer to release an archived generation, without waiting. Worth doing even when the
 * archive will never be destroyed: a peer still holding the moved inode keeps appending to it.
 */
export function announceGeneration(generation: any) {
	closeLocalDescriptorsOn(generation);
	transport?.broadcast({
		type: LOG_GENERATION_ROTATED,
		logPath: generation.logPath,
		generation: generation.generation,
		ino: generation.ino,
		dev: generation.dev,
		originator: transport.threadId,
	});
}

/**
 * Announce an archived generation and resolve to whether every peer has provably released it.
 * `false` means the caller must leave the plain archive in place — it is never safe to unlink an
 * inode a peer may still be appending to.
 */
export function requestGenerationClose(generation: any): Promise<boolean> {
	const expected = new Set<number>(transport ? transport.peerThreadIds() : []);
	if (!transport || expected.size === 0) {
		announceGeneration(generation);
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		let timer;
		const settle = (proven) => {
			clearTimeout(timer);
			pendingByGeneration.delete(generation.generation);
			resolve(proven);
		};
		pendingByGeneration.set(generation.generation, { expected, settle });
		timer = setTimeout(() => settle(false), transport.quiescenceTimeout ?? DEFAULT_QUIESCENCE_TIMEOUT);
		timer.unref?.();
		announceGeneration(generation);
	});
}

function recordPeerResponse(generationId: string, threadId: number) {
	const pending = pendingByGeneration.get(generationId);
	if (!pending) return;
	pending.expected.delete(threadId);
	if (pending.expected.size === 0) pending.settle(true);
}

function closeLocalDescriptorsOn(generation: any) {
	sinksByPath.get(generation.logPath)?.(generation.ino, generation.dev);
}
