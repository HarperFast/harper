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
 * Dependencies (debug config + live worker count) are injected so the tool is
 * unit-testable without booting a server.
 */

import WebSocket from 'ws';
import type { AgentTool, AgentToolContext } from '../types.ts';

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
	send(method: string, params?: object): Promise<any>;
	on(event: string, cb: (params: any) => void): void;
	close(): void;
	title?: string;
}

// One live CDP connection per worker debug port, reused across tool calls.
const sessions = new Map<number, CdpSession>();

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
	if (!Number.isInteger(workerIndex)) throw new Error('workerIndex must be an integer');
	if (workerIndex < 0) {
		throw new Error('cannot attach to the main thread (the agent runs there); specify a worker index >= 0');
	}
	const count = deps.getWorkerCount();
	if (workerIndex >= count) throw new Error(`no worker at index ${workerIndex} (worker count is ${count})`);
	return deps.startingPort + workerIndex;
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

function openCdp(wsUrl: string, onClose: () => void): Promise<CdpSession> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		let nextId = 1;
		const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
		const listeners = new Map<string, Set<(params: any) => void>>();

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
		ws.on('error', (err: Error) => reject(err));
		ws.on('close', () => {
			for (const p of pending.values()) p.reject(new Error('CDP connection closed'));
			pending.clear();
			onClose();
		});
		ws.on('open', () =>
			resolve({
				send(method, params) {
					return new Promise((res, rej) => {
						const id = nextId++;
						pending.set(id, { resolve: res, reject: rej });
						ws.send(JSON.stringify({ id, method, params: params ?? {} }));
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
			})
		);
	});
}

async function sessionFor(port: number, host: string, signal?: AbortSignal): Promise<CdpSession> {
	const existing = sessions.get(port);
	if (existing) return existing;
	const { wsUrl, title } = await fetchWebSocketUrl(host, port, signal);
	const session = await openCdp(wsUrl, () => sessions.delete(port));
	session.title = title;
	sessions.set(port, session);
	return session;
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
			const workerIndex = Number(args.workerIndex);
			const port = resolvePort(deps, workerIndex);
			const session = await sessionFor(port, deps.host, ctx.signal);
			await session.send('Runtime.enable');
			await session.send('Debugger.enable');
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
			const port = resolvePort(deps, Number(args.workerIndex));
			const session = await sessionFor(port, deps.host, ctx.signal);
			await session.send('Runtime.enable');
			const res = await session.send('Runtime.evaluate', {
				expression: String(args.expression),
				returnByValue: true,
				awaitPromise: !!args.awaitPromise,
			});
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
				'Set a breakpoint by script URL + line in a worker. lineNumber is 0-based (CDP). A hit PAUSES the worker until resumed, so use sparingly on live nodes.',
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
		destructive: true, // can pause a live worker
		handler: async (args: any, ctx: AgentToolContext) => {
			const port = resolvePort(deps, Number(args.workerIndex));
			const session = await sessionFor(port, deps.host, ctx.signal);
			await session.send('Debugger.enable');
			const res = await session.send('Debugger.setBreakpointByUrl', {
				url: String(args.url),
				lineNumber: Number(args.lineNumber),
				...(args.columnNumber != null ? { columnNumber: Number(args.columnNumber) } : {}),
				...(args.condition ? { condition: String(args.condition) } : {}),
			});
			return { breakpointId: res.breakpointId, locations: res.locations };
		},
	};

	const setLogpoint: AgentTool = {
		def: {
			name: 'inspector_set_logpoint',
			description:
				'Set a non-pausing logpoint: logs an expression each time the line is hit, without stopping the worker. lineNumber is 0-based.',
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
		handler: async (args: any, ctx: AgentToolContext) => {
			const port = resolvePort(deps, Number(args.workerIndex));
			const session = await sessionFor(port, deps.host, ctx.signal);
			await session.send('Debugger.enable');
			// A logpoint is a breakpoint whose condition logs and evaluates to false, so it never pauses.
			const condition = `(function(){try{console.log('[agent logpoint]',${String(args.logExpression)});}catch(e){}return false;})()`;
			const res = await session.send('Debugger.setBreakpointByUrl', {
				url: String(args.url),
				lineNumber: Number(args.lineNumber),
				condition,
			});
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
			const port = resolvePort(deps, Number(args.workerIndex));
			const duration = Math.min(Math.max(Number(args.durationMs), 100), 60000);
			const session = await sessionFor(port, deps.host, ctx.signal);
			await session.send('Profiler.enable');
			await session.send('Profiler.start');
			let stopped: any;
			try {
				await sleep(duration, ctx.signal);
			} finally {
				// Always stop the profiler even if aborted, so we don't leave it running on the worker.
				stopped = await session.send('Profiler.stop').catch(() => undefined);
			}
			if (!stopped?.profile) throw new Error('profiling produced no profile');
			return summarizeProfile(stopped.profile, args.topN ? Number(args.topN) : 15);
		},
	};

	return [attach, evaluate, setBreakpoint, setLogpoint, profileCpu];
}

/** Close all live inspector connections (agent shutdown / test teardown). */
export function _closeInspectorSessions(): void {
	for (const session of sessions.values()) session.close();
	sessions.clear();
}
