/**
 * Newline-delimited JSON RPC between the orchestrator and a target agent over a child process's
 * stdio (an `ssh host -- node targetAgent.mts`, or the agent spawned directly). Requests go on the
 * agent's stdin, which nothing else writes. Responses come back on its stdout behind FRAME_MARKER;
 * any other stdout line is the agent's log. Non-finite numbers (an uncapped memory.max) survive the
 * trip, which plain JSON would turn into null.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

export const FRAME_MARKER = '\x1eYCSB-RPC ';
/** A frame longer than this is a broken channel, not a payload (folded profiles are a few MB). */
export const MAX_FRAME_BYTES = 256 * 1024 ** 2;

const NUMBER_TAG = '$ycsb-number';

export function encode(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		typeof v === 'number' && !Number.isFinite(v) ? { [NUMBER_TAG]: String(v) } : v
	);
}

export function decode(text: string): unknown {
	return JSON.parse(text, (_key, v) =>
		v && typeof v === 'object' && !Array.isArray(v) && NUMBER_TAG in v && Object.keys(v).length === 1
			? Number(v[NUMBER_TAG])
			: v
	);
}

interface Response {
	id: number;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export function parseLine(line: string): { log?: string; response?: Response } {
	const at = line.indexOf(FRAME_MARKER);
	if (at < 0) return { log: line };
	const response = decode(line.slice(at + FRAME_MARKER.length)) as Response;
	if (typeof response?.id !== 'number' || typeof response.ok !== 'boolean') {
		throw new Error(`malformed RPC frame: ${line.slice(at, at + 200)}`);
	}
	return { log: at > 0 ? line.slice(0, at) : undefined, response };
}

/**
 * The orchestrator's end. A call that times out, or a channel that breaks (the process exits, a frame
 * does not parse), fails every pending and later call: the agent's state is then unknown, and the
 * session must stop rather than carry on against it.
 */
export class RpcClient {
	readonly name: string;
	private child: ChildProcess;
	private nextId = 0;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	private broken?: Error;
	readonly exited: Promise<number | null>;

	constructor(name: string, command: string[], { onLog = (line: string) => console.log(`[${name}] ${line}`) } = {}) {
		this.name = name;
		const [file, ...args] = command;
		this.child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		this.exited = new Promise((resolve) => {
			this.child.once('exit', (code, signal) => {
				this.fail(new Error(`agent ${name} exited (${code ?? signal})`));
				resolve(code);
			});
			this.child.once('error', (error) => {
				this.fail(new Error(`agent ${name} could not start: ${error.message}`));
				resolve(null);
			});
		});
		this.child.stdin!.on('error', (error) => this.fail(new Error(`agent ${name} stdin: ${error.message}`)));
		const lines = (stream: Readable, handle: (line: string) => void) =>
			createInterface({ input: stream, crlfDelay: Infinity }).on('line', handle);
		lines(this.child.stderr!, (line) => onLog(line));
		lines(this.child.stdout!, (line) => {
			if (line.length > MAX_FRAME_BYTES) return this.fail(new Error(`agent ${name} sent a ${line.length}-byte line`));
			let parsed: ReturnType<typeof parseLine>;
			try {
				parsed = parseLine(line);
			} catch (error) {
				return this.fail(new Error(`agent ${name}: ${(error as Error).message}`));
			}
			if (parsed.log) onLog(parsed.log);
			const response = parsed.response;
			if (!response) return;
			const waiter = this.pending.get(response.id);
			if (!waiter) return;
			this.pending.delete(response.id);
			clearTimeout(waiter.timer);
			if (response.ok) waiter.resolve(response.result);
			else waiter.reject(new Error(`${name}: ${response.error}`));
		});
	}

	call<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
		if (this.broken) return Promise.reject(this.broken);
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => this.fail(new Error(`agent ${this.name}: ${method} did not answer within ${timeoutMs} ms`)),
				timeoutMs
			);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			this.child.stdin!.write(encode({ id, method, params }) + '\n');
		});
	}

	private fail(error: Error): void {
		this.broken ??= error;
		for (const [id, waiter] of this.pending) {
			clearTimeout(waiter.timer);
			this.pending.delete(id);
			waiter.reject(this.broken);
		}
	}

	/** Ends the agent's stdin, which makes it stop everything it started, and waits for it to exit. */
	async close(graceMs = 15 * 60_000): Promise<void> {
		this.child.stdin!.end();
		const timer = setTimeout(() => this.child.kill('SIGKILL'), graceMs);
		await this.exited;
		clearTimeout(timer);
	}
}

export type Handler = (params: any) => Promise<unknown> | unknown;

/**
 * The agent's end: one request per stdin line, each answered with one frame through `write` (which
 * must be the only writer of the channel), in completion order.
 */
export function serveRpc(
	handlers: Record<string, Handler>,
	{ input, write, onEnd }: { input: Readable; write: (frame: string) => void; onEnd: () => void }
): void {
	const reply = (response: Response) => write(`\n${FRAME_MARKER}${encode(response)}\n`);
	createInterface({ input, crlfDelay: Infinity })
		.on('line', (line) => {
			if (line.trim() === '') return;
			let request: { id: number; method: string; params?: unknown };
			try {
				request = decode(line) as typeof request;
			} catch {
				process.stderr.write(`unparseable request: ${line.slice(0, 200)}\n`);
				return;
			}
			const handler = Object.hasOwn(handlers, request.method) ? handlers[request.method] : undefined;
			Promise.resolve()
				.then(() => {
					if (!handler) throw new Error(`unknown method ${request.method}`);
					return handler(request.params);
				})
				.then(
					(result) => reply({ id: request.id, ok: true, result: result ?? null }),
					(error) => reply({ id: request.id, ok: false, error: (error as Error)?.stack ?? String(error) })
				);
		})
		.on('close', onEnd);
}
