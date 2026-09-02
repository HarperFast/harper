'use strict';

// Every isolate holds its own descriptor on the shared log file, so a rename leaves the others
// appending to the archived inode and destroying it loses whatever they write next. No size
// comparison can rule out a write that has not happened yet; an answer from every peer can.
//
// The thread layer injects the transport; harper_logger must never reach manageThreads.

import { statSync } from 'node:fs';

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
const sinksByPath = new Map<string, { identity(): any; close(): void }>();
const pendingByRequest = new Map<
	string,
	{ expected: Set<number>; liveLogPaths: Set<string>; settle: (released: boolean) => void }
>();
let requestCounter = 0;

export function setRotationTransport(newTransport?: RotationTransport) {
	transport = newTransport;
	if (!newTransport) return;
	newTransport.onMessage(LOG_GENERATION_ROTATED, (message) => {
		releaseLocally(message);
		newTransport.sendToThread(message.originator, {
			type: LOG_GENERATION_CLOSED,
			request: message.request,
			threadId: newTransport.threadId,
			// The paths this isolate writes. Components load in the workers, so a component's own log
			// is registered only there, and the thread that runs retention would otherwise see a live
			// file it has never heard of and delete it by age.
			logPaths: message.stale ? [...sinksByPath.keys()] : undefined,
		});
	});
	newTransport.onMessage(LOG_GENERATION_CLOSED, (message) => {
		recordPeerResponse(message.request, message.threadId, message.logPaths);
	});
	newTransport.onThreadExit((threadId) => {
		// An exited thread cannot hold a descriptor, so its exit answers everything it owed.
		for (const request of [...pendingByRequest.keys()]) recordPeerResponse(request, threadId);
	});
}

/**
 * Registered by the file sink, not the size guard: a thread with no guard still holds a descriptor,
 * and its answer has to mean the descriptor is gone.
 */
export function registerLogSink(logPath: string, sink: { identity(): any; close(): void }) {
	sinksByPath.set(logPath, sink);
}

export function unregisterLogSink(logPath: string) {
	sinksByPath.delete(logPath);
}

export function nextGenerationId() {
	return `${process.pid}-${transport?.threadId ?? 0}-${requestCounter++}`;
}

/**
 * Ask every writer of `logPath` to release the descriptors this request names, and resolve to
 * whether they all provably did. `false` means the caller must leave those archives in place — it
 * is never safe to unlink an inode a peer may still be appending to.
 */
function requestRelease(message: any): Promise<{ released: boolean; liveLogPaths: Set<string> }> {
	releaseLocally(message);
	const liveLogPaths = new Set<string>(sinksByPath.keys());
	const expected = new Set<number>(transport ? transport.peerThreadIds() : []);
	if (!transport || expected.size === 0) return Promise.resolve({ released: true, liveLogPaths });
	const request = message.request;
	return new Promise((resolve) => {
		let timer;
		const settle = (released) => {
			clearTimeout(timer);
			pendingByRequest.delete(request);
			resolve({ released, liveLogPaths });
		};
		pendingByRequest.set(request, { expected, liveLogPaths, settle });
		timer = setTimeout(() => settle(false), transport.quiescenceTimeout ?? DEFAULT_QUIESCENCE_TIMEOUT);
		timer.unref?.();
		transport.broadcast({ ...message, originator: transport.threadId });
	});
}

/** One archived generation: release any descriptor still pointing at the inode that was renamed. */
export async function requestGenerationClose(generation: any): Promise<boolean> {
	return (
		await requestRelease({
			type: LOG_GENERATION_ROTATED,
			request: generation.generation,
			logPath: generation.logPath,
			ino: generation.ino,
			dev: generation.dev,
		})
	).released;
}

/**
 * Every generation but the live one, for every log this process writes, in a single round trip.
 * Not scoped to one path: the archive directory holds the archives of every component and external
 * log sharing it, and retention destroys those too.
 */
export function requestStaleDescriptorRelease(): Promise<{ released: boolean; liveLogPaths: Set<string> }> {
	return requestRelease({ type: LOG_GENERATION_ROTATED, request: nextGenerationId(), stale: true });
}

function recordPeerResponse(request: string, threadId: number, logPaths?: string[]) {
	const pending = pendingByRequest.get(request);
	if (!pending) return;
	if (logPaths) for (const logPath of logPaths) pending.liveLogPaths.add(logPath);
	pending.expected.delete(threadId);
	if (pending.expected.size === 0) pending.settle(true);
}

function releaseLocally(message: any) {
	if (message.stale) return releaseStaleDescriptors();
	const sink = sinksByPath.get(message.logPath);
	if (!sink) return;
	const identity = sink.identity();
	// No identity to compare (no descriptor open, or a filesystem that cannot report one) means
	// closing is the only answer that can still be called a release.
	if (!identity || (identity.ino === message.ino && identity.dev === message.dev)) sink.close();
}

/**
 * Release every descriptor this isolate holds that is not on the live generation of its own path.
 * Each sink decides for itself, so nothing has to name the live inode of a log it does not own.
 */
function releaseStaleDescriptors() {
	for (const [logPath, sink] of sinksByPath) {
		const identity = sink.identity();
		if (!identity) continue;
		let live;
		try {
			live = statSync(logPath);
		} catch {
			sink.close();
			continue;
		}
		// `ino === 0` (some Windows filesystems) proves nothing, and answering "released" without
		// releasing is what destroys an archive under a peer.
		if (!identity.ino || !live.ino || identity.ino !== live.ino || identity.dev !== live.dev) sink.close();
	}
}
