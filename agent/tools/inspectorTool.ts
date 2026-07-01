/**
 * V8 inspector (CDP) tools for the built-in agent (#626).
 *
 * The agent runs on the main thread; these tools attach over the Chrome
 * DevTools Protocol to *worker* thread inspector ports so it can evaluate,
 * set breakpoints/logpoints, and CPU-profile a worker without stalling the
 * thread it runs on. A worker's debug port is `threads_debug_startingPort +
 * workerIndex` (see `server/threads/threadServer.js`); attaching therefore
 * requires `threads_debug: true` and a configured `threads_debug_startingPort`.
 *
 * Attaching to the main thread (`workerIndex < 0`) is rejected — that's the
 * agent's own thread, and a self-attach + breakpoint would deadlock. This is
 * the operator-only counterpart to the app-developer agent, which runs on a
 * worker and must never inspector-attach to itself.
 *
 * Safety against wedging a live worker: every connection registers a
 * `Debugger.paused` handler that logs a stack snapshot and immediately resumes,
 * so a breakpoint hit is observable (via the Harper log) but never leaves the
 * worker paused. CDP calls carry a per-call abort signal + timeout so an
 * unresponsive worker can't hang the agent loop.
 *
 * Dependencies (debug config + live worker count) are injected so the tool is
 * unit-testable without booting a server.
 */

import WebSocket from 'ws';
import harperLogger from '../../utility/logging/harper_logger.ts';
import type { AgentTool, AgentToolContext } from '../types.ts';

const log = harperLogger.loggerWithTag('agent');

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_TCP_PORT = 65535;

export interface InspectorDeps {
	/** Whether `threads_debug` is enabled. */
	debugEnabled: boolean;
	/** `threads_debug_startingPort`, or undefined when not configured. */
	startingPort: number | undefined;
	/** Inspector host (`threads_debug_host`), defaulting to 127.0.0.1. */
	host: string;
	/** Live worker-slot count, for range-checking `workerIndex`. */
	getWorkerCount: () => number;
}

interface CdpSession {
	send(method: string, params?: object, signal?: AbortSignal): Promise<any>;
	on(event: string, cb: (params: any) => void): void;
	close(): void;
	title?: string;
}

// One live CDP connection per worker debug port, reused across tool calls. Keyed by port and
// storing the *promise* so concurrent opens dedupe onto a single connection.
const sessions = new Map<number, Promise<CdpSession>>();

/** Strictly parse a worker index — reject `""`/`null`/`false`/`[]`, which `Number()` would coerce to 0. */
function toWorkerIndex(raw: unknown): number {
	if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
	if (typeof raw === 'string' && raw.trim() !== '' && Number.isInteger(Number(raw))) return Number(raw);
	throw new Error('workerIndex must be an integer');
}

/**
 * Resolve the worker's inspector port, enforcing the safety envelope:
 * debug enabled, a starting port configured, and an in-range worker index that
 * is NOT the main thread (`< 0`).
 */
function resolvePort(deps: InspectorDeps, workerIndex: number): number {
	if (!deps.debugEnabled) {
		throw new Error('threads_debug is not enabled; set threads_debug: true to allow inspector attach');
	}
	if (deps.startingPort == null) {
		throw new Error('threads_debug_startingPort is not configured; per-worker inspector ports are unavailable');
	}
	if (workerIndex < 0) {
		throw new Error('cannot attach to the main thread (the agent runs there); specify a worker index >= 0');
	}
	const count = deps.getWorkerCount();
	if (workerIndex >= count) throw new Error(`no worker at index ${workerIndex} (worker count is ${count})`);
	const port = deps.startingPort + workerIndex;
	if (port > MAX_TCP_PORT) throw new Error(`resolved inspector port ${port} exceeds ${MAX_TCP_PORT}`);
	return port;
}

async function fetchWebSocketUrl(
	host: string,
	port: number,
	signal?: AbortSignal
): Promise<{ wsUrl: string; title?: string }> {
	const res = await fetch(`http://${host}:${port}/json/list`, { signal });
	if (!res.ok) throw new Error(`inspector /json/list on ${host}:${port} returned ${res.status}`);
	const targets = (await res.json()) as Array<{ webSocketDebuggerUrl?: string; title?: string }>;
	const target = Array.isArray(targets) ? targets.find((t) => t.webSocketDebuggerUrl) : undefined;
	if (!target?.webSocketDebuggerUrl) {
		throw new Error(`no debuggable target at ${host}:${port} (is the worker inspector open?)`);
	}
	return { wsUrl: target.webSocketDebuggerUrl, title: target.title };
}

function openCdp(wsUrl: string, opts: { signal?: AbortSignal; onClose: () => void }): Promise<CdpSession> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		let opened = false;
		let nextId = 1;
		const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
		const listeners = new Map<string, Set<(params: any) => void>>();

		const failPending = (err: Error) => {
			for (const p of pending.values()) p.reject(err);
			pending.clear();
		};
		// The connect signal guards ONLY the handshake — once open, per-call signals take over, so
		// aborting the first caller must not tear down the shared connection.
		const onConnectAbort = () => {
			try {
				ws.terminate();
			} catch {
				/* already gone */
			}
		};
		if (opts.signal) {
			if (opts.signal.aborted) {
				onConnectAbort();
				return reject(new Error('aborted'));
			}
			opts.signal.addEventListener('abort', onConnectAbort, { once: true });
		}

		ws.on('message', (data: WebSocket.RawData) => {
			let msg: any;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (msg.id != null && pending.has(msg.id)) {
				const p = pending.get(msg.id)!;
				pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'));
				else p.resolve(msg.result);
			} else if (msg.method) {
				for (const cb of listeners.get(msg.method) ?? []) cb(msg.params);
			}
		});
		ws.on('error', (err: Error) => {
			if (!opened) reject(err);
			failPending(err instanceof Error ? err : new Error(String(err)));
		});
		ws.on('close', () => {
			opts.signal?.removeEventListener('abort', onConnectAbort);
			if (!opened) reject(new Error('CDP connection closed before it opened'));
			failPending(new Error('CDP connection closed'));
			opts.onClose();
		});
		ws.on('open', () => {
			opened = true;
			opts.signal?.removeEventListener('abort', onConnectAbort);
			const session: CdpSession = {
				send(method, params, signal) {
					return new Promise((res, rej) => {
						if (signal?.aborted) return rej(new Error('aborted'));
						const id = nextId++;
						const timer = setTimeout(() => {
							if (pending.delete(id)) rej(new Error(`CDP ${method} timed out after ${DEFAULT_CALL_TIMEOUT_MS}ms`));
						}, DEFAULT_CALL_TIMEOUT_MS);
						const onAbort = () => {
							if (pending.delete(id)) {
								clearTimeout(timer);
								rej(new Error('aborted'));
							}
						};
						signal?.addEventListener('abort', onAbort, { once: true });
						pending.set(id, {
							resolve: (v) => {
								clearTimeout(timer);
								signal?.removeEventListener('abort', onAbort);
								res(v);
							},
							reject: (e) => {
								clearTimeout(timer);
								signal?.removeEventListener('abort', onAbort);
								rej(e);
							},
						});
						try {
							ws.send(JSON.stringify({ id, method, params: params ?? {} }));
						} catch (e) {
							if (pending.delete(id)) {
								clearTimeout(timer);
								rej(e as Error);
							}
						}
					});
				},
				on(event, cb) {
					let set = listeners.get(event);
					if (!set) listeners.set(event, (set = new Set()));
					set.add(cb);
				},
				close() {
					try {
						ws.close();
					} catch {
						/* already closing */
					}
				},
			};
			// A breakpoint hit pauses the worker; log a stack snapshot and resume immediately so the
			// worker is never left wedged. Fires only when Debugger is enabled (i.e. a breakpoint was set).
			session.on('Debugger.paused', (params: any) => {
				const frames = (params?.callFrames ?? [])
					.slice(0, 5)
					.map((f: any) => `${f.functionName || '(anonymous)'}@${f.url}:${f.location?.lineNumber}`);
				log.info?.(`[agent breakpoint hit] reason=${params?.reason} ${frames.join(' <- ')}`);
				session.send('Debugger.resume').catch(() => {});
			});
			resolve(session);
		});
	});
}

function sessionFor(port: number, host: string, signal?: AbortSignal): Promise<CdpSession> {
	const existing = sessions.get(port);
	if (existing) return existing;
	const promise = (async () => {
		const { wsUrl, title } = await fetchWebSocketUrl(host, port, signal);
		const session = await openCdp(wsUrl, {
			signal,
			// Evict only if this exact promise is still the cached one — a stale close from a replaced
			// connection must not drop a newer active session.
			onClose: () => {
				if (sessions.get(port) === promise) sessions.delete(port);
			},
		});
		session.title = title;
		return session;
	})();
	// Drop a failed connect from the cache so the next call retries instead of re-awaiting a rejection.
	promise.catch(() => {
		if (sessions.get(port) === promise) sessions.delete(port);
	});
	sessions.set(port, promise);
	return promise;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error('aborted'));
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(new Error('aborted'));
			},
			{ once: true }
		);
	});
}

/** Reduce a CDP CPU profile to the hottest functions by self time — the raw profile is megabytes. */
export function summarizeProfile(profile: any, topN: number): object {
	const nodes: any[] = profile?.nodes ?? [];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const samples: number[] = profile?.samples ?? [];
	const deltas: number[] = profile?.timeDeltas ?? [];
	const selfUs = new Map<number, number>();
	for (let i = 0; i < samples.length; i++) {
		const id = samples[i];
		selfUs.set(id, (selfUs.get(id) ?? 0) + (deltas[i] ?? 0));
	}
	const topFunctions = [...selfUs.entries()]
		.map(([id, us]) => {
			const cf = byId.get(id)?.callFrame ?? {};
			return {
				function: cf.functionName || '(anonymous)',
				url: cf.url,
				line: cf.lineNumber,
				selfMs: +(us / 1000).toFixed(1),
			};
		})
		.sort((a, b) => b.selfMs - a.selfMs)
		.slice(0, topN);
	const totalMs = deltas.reduce((a, b) => a + b, 0) / 1000;
	return { totalMs: +totalMs.toFixed(1), sampleCount: samples.length, topFunctions };
}

const workerIndexProp = { type: 'integer', minimum: 0, description: '0-based worker thread index' };

export function buildInspectorTools(deps: InspectorDeps): AgentTool[] {
	const attach: AgentTool = {
		def: {
			name: 'inspector_attach',
			description:
				'Attach the V8 inspector to a worker thread so it can be evaluated, breakpointed, or CPU-profiled. Requires threads_debug + threads_debug_startingPort. Rejects the main thread.',
			parameters: { type: 'object', properties: { workerIndex: workerIndexProp }, required: ['workerIndex'] },
		},
		handler: async (args: any, ctx: AgentToolContext) => {
			const workerIndex = toWorkerIndex(args.workerIndex);
			const port = resolvePort(deps, workerIndex);
			const session = await sessionFor(port, deps.host, ctx.signal);
			await session.send('Runtime.enable', {}, ctx.signal);
			await session.send('Debugger.enable', {}, ctx.signal);
			return { attached: true, workerIndex, port, target: session.title };
		},
	};

	const evaluate: AgentTool = {
		def: {
			name: 'inspector_evaluate',
			description:
				'Evaluate a JavaScript expression in a worker thread and return the result. Runs arbitrary code in the worker.',
			parameters: {
				type: 'object',
				properties: {
					workerIndex: workerIndexProp,
					expression: { type: 'string' },
					awaitPromise: { type: 'boolean', description: 'Await the result if it is a promise.' },
				},
				required: ['workerIndex', 'expression'],
			},
		},
		destructive: true, // arbitrary in-worker code execution
		handler: async (args: any, ctx: AgentToolContext) => {
			const port = resolvePort(deps, toWorkerIndex(args.workerIndex));
			const session = await sessionFor(port, deps.host, ctx.signal);
			await session.send('Runtime.enable', {}, ctx.signal);
			const res = await session.send(
				'Runtime.evaluate',
				{ expression: String(args.expression), returnByValue: true, awaitPromise: !!args.awaitPromise },
				ctx.signal
			);
			if (res.exceptionDetails) {
				throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'evaluation threw');
			}
			return { value: res.result?.value, type: res.result?.type };
		},
	};

	const setBreakpoint: AgentTool = {
		def: {
			name: 'inspector_set_breakpoint',
			description:
				'Set a breakpoint by script URL + line in a worker. lineNumber is 0-based (CDP). On hit, a stack snapshot is written to the Harper log and the worker is auto-resumed (it is NOT left paused).',
			parameters: {
				type: 'object',
				properties: {
					workerIndex: workerIndexProp,
					url: { type: 'string', description: 'Exact script URL (usually file:///…) to break in.' },
					lineNumber: { type: 'integer', minimum: 0, description: '0-based line number.' },
					columnNumber: { type: 'integer', minimum: 0 },
					condition: { type: 'string', description: 'Optional JS condition; breaks only when it is truthy.' },
				},
				required: ['workerIndex', 'url', 'lineNumber'],
			},
		},
		destructive: true, // runs a condition in the worker; a hit briefly pauses it before auto-resume
		handler: async (args: any, ctx: AgentToolContext) => {
			const port = resolvePort(deps, toWorkerIndex(args.workerIndex));
			const session = await sessionFor(port, deps.host, ctx.signal);
			await session.send('Debugger.enable', {}, ctx.signal);
			const res = await session.send(
				'Debugger.setBreakpointByUrl',
				{
					url: String(args.url),
					lineNumber: Number(args.lineNumber),
					...(args.columnNumber != null ? { columnNumber: Number(args.columnNumber) } : {}),
					...(args.condition ? { condition: String(args.condition) } : {}),
				},
				ctx.signal
			);
			return { breakpointId: res.breakpointId, locations: res.locations };
		},
	};

	const setLogpoint: AgentTool = {
		def: {
			name: 'inspector_set_logpoint',
			description:
				'Set a non-pausing logpoint: logs an expression each time the line is hit, without stopping the worker. lineNumber is 0-based. Runs the expression in the worker.',
			parameters: {
				type: 'object',
				properties: {
					workerIndex: workerIndexProp,
					url: { type: 'string', description: 'Exact script URL (usually file:///…).' },
					lineNumber: { type: 'integer', minimum: 0, description: '0-based line number.' },
					logExpression: { type: 'string', description: 'JS expression whose value is logged on each hit.' },
				},
				required: ['workerIndex', 'url', 'lineNumber', 'logExpression'],
			},
		},
		destructive: true, // runs an arbitrary expression in the worker on every hit
		handler: async (args: any, ctx: AgentToolContext) => {
			const port = resolvePort(deps, toWorkerIndex(args.workerIndex));
			const session = await sessionFor(port, deps.host, ctx.signal);
			await session.send('Debugger.enable', {}, ctx.signal);
			// A logpoint is a breakpoint whose condition logs and returns false, so it never pauses. The
			// expression is JSON-encoded into a string and eval'd (not spliced as raw code), so it can't
			// break out of the wrapper to force a pause; a stray pause would auto-resume anyway (see
			// openCdp). Direct eval keeps the paused frame's locals in scope.
			const condition = `(function(){try{console.log('[agent logpoint]',eval(${JSON.stringify(
				String(args.logExpression)
			)}));}catch(e){}return false;})()`;
			const res = await session.send(
				'Debugger.setBreakpointByUrl',
				{ url: String(args.url), lineNumber: Number(args.lineNumber), condition },
				ctx.signal
			);
			return { breakpointId: res.breakpointId, locations: res.locations };
		},
	};

	const profileCpu: AgentTool = {
		def: {
			name: 'inspector_profile_cpu',
			description: 'Record a CPU profile of a worker for durationMs and return the hottest functions by self time.',
			parameters: {
				type: 'object',
				properties: {
					workerIndex: workerIndexProp,
					durationMs: { type: 'integer', minimum: 100, maximum: 60000 },
					topN: {
						type: 'integer',
						minimum: 1,
						maximum: 50,
						description: 'How many hot functions to return (default 15).',
					},
				},
				required: ['workerIndex', 'durationMs'],
			},
		},
		handler: async (args: any, ctx: AgentToolContext) => {
			const port = resolvePort(deps, toWorkerIndex(args.workerIndex));
			const duration = Math.min(Math.max(Number(args.durationMs), 100), 60000);
			const session = await sessionFor(port, deps.host, ctx.signal);
			await session.send('Profiler.enable', {}, ctx.signal);
			await session.send('Profiler.start', {}, ctx.signal);
			let stopped: any;
			try {
				await sleep(duration, ctx.signal);
			} finally {
				// Always stop + disable the profiler even if aborted, so we don't leave it running on the worker.
				stopped = await session.send('Profiler.stop').catch(() => undefined);
				await session.send('Profiler.disable').catch(() => {});
			}
			if (!stopped?.profile) throw new Error('profiling produced no profile');
			return summarizeProfile(stopped.profile, args.topN ? Number(args.topN) : 15);
		},
	};

	return [attach, evaluate, setBreakpoint, setLogpoint, profileCpu];
}

/** Close all live inspector connections (agent shutdown / test teardown). Handles in-flight opens. */
export function _closeInspectorSessions(): void {
	for (const promise of sessions.values()) promise.then((s) => s.close()).catch(() => {});
	sessions.clear();
}
