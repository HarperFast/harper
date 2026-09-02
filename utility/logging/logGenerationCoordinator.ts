'use strict';

// Every isolate holds its own descriptor on the shared log file, so a rename by one of them leaves
// the others appending to the archived inode. Destroying that inode — compression's unlink, or
// retention's — loses whatever they write next, and no size comparison can rule out a write that has
// not happened yet. This makes the release provable: peers close matching descriptors and answer,
// and an archive is destroyed only once every peer has answered or exited.
//
// The thread layer injects the transport (server/threads/logRotationTransport.ts); harper_logger
// must never reach manageThreads.

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
const pendingByRequest = new Map<string, { expected: Set<number>; settle: (proven: boolean) => void }>();
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
		});
	});
	newTransport.onMessage(LOG_GENERATION_CLOSED, (message) => {
		recordPeerResponse(message.request, message.threadId);
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

/** Whether this path is a log some isolate is writing, rather than something left in the directory. */
export function isRegisteredLogPath(logPath: string) {
	return sinksByPath.has(logPath);
}

export function nextGenerationId() {
	return `${process.pid}-${transport?.threadId ?? 0}-${requestCounter++}`;
}

/**
 * Ask every writer of `logPath` to release the descriptors this request names, and resolve to
 * whether they all provably did. `false` means the caller must leave those archives in place — it
 * is never safe to unlink an inode a peer may still be appending to.
 */
function requestRelease(message: any): Promise<boolean> {
	releaseLocally(message);
	const expected = new Set<number>(transport ? transport.peerThreadIds() : []);
	if (!transport || expected.size === 0) return Promise.resolve(true);
	const request = message.request;
	return new Promise((resolve) => {
		let timer;
		const settle = (proven) => {
			clearTimeout(timer);
			pendingByRequest.delete(request);
			resolve(proven);
		};
		pendingByRequest.set(request, { expected, settle });
		timer = setTimeout(() => settle(false), transport.quiescenceTimeout ?? DEFAULT_QUIESCENCE_TIMEOUT);
		timer.unref?.();
		transport.broadcast({ ...message, originator: transport.threadId });
	});
}

/** One archived generation: release any descriptor still pointing at the inode that was renamed. */
export function requestGenerationClose(generation: any): Promise<boolean> {
	return requestRelease({
		type: LOG_GENERATION_ROTATED,
		request: generation.generation,
		logPath: generation.logPath,
		ino: generation.ino,
		dev: generation.dev,
	});
}

/**
 * Every generation but the live one, in a single round trip. Retention deletes archives this
 * process may not have rotated — a worker's unproven archive is invisible to the main thread's own
 * bookkeeping — so it proves the whole set at once rather than asking per archive.
 */
export function requestStaleDescriptorRelease(logPath: string, active: any): Promise<boolean> {
	return requestRelease({
		type: LOG_GENERATION_ROTATED,
		request: nextGenerationId(),
		logPath,
		stale: true,
		keepIno: active?.ino,
		keepDev: active?.dev,
	});
}

function recordPeerResponse(request: string, threadId: number) {
	const pending = pendingByRequest.get(request);
	if (!pending) return;
	pending.expected.delete(threadId);
	if (pending.expected.size === 0) pending.settle(true);
}

function releaseLocally(message: any) {
	const sink = sinksByPath.get(message.logPath);
	if (!sink) return;
	const identity = sink.identity();
	// No identity to compare (no descriptor open, or a filesystem that cannot report one) means
	// closing is the only answer that can still be called a release. `stale` inverts the test: keep
	// only the live generation, and when there is no live generation to name, keep nothing.
	if (message.stale) {
		// Keep only a descriptor provably on the live generation. `ino === 0` — some Windows
		// filesystems — cannot prove that, and answering "released" without releasing is what would
		// let the archive be destroyed under a peer, so an indistinguishable descriptor is closed.
		const onLiveGeneration =
			identity &&
			identity.ino &&
			message.keepIno &&
			identity.ino === message.keepIno &&
			identity.dev === message.keepDev;
		if (!onLiveGeneration) sink.close();
		return;
	}
	if (!identity || (identity.ino === message.ino && identity.dev === message.dev)) sink.close();
}
