/**
 * `http_fetch` for the built-in agent (#626). Wraps the platform `fetch`
 * with a size cap and an inactivity timeout so the agent can probe its own
 * deployed components and pull lightweight web pages for context without
 * letting a single tool call hang the loop or exhaust memory.
 */

import type { AgentTool, AgentToolContext } from '../types.ts';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB cap on response bodies
const DEFAULT_TIMEOUT_MS = 30_000;

export const httpFetchTool: AgentTool = {
	def: {
		name: 'http_fetch',
		description:
			"Issue an HTTP request from the Harper server. Useful for hitting the agent's own components on localhost and pulling reference pages.",
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'Absolute URL.' },
				method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
				headers: { type: 'object', additionalProperties: { type: 'string' } },
				body: { type: 'string', description: 'Request body as a string (JSON or form-encoded).' },
				timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
			},
			required: ['url'],
		},
	},
	handler: async (args: any, ctx: AgentToolContext) => {
		const url = String(args.url ?? '');
		if (!/^https?:\/\//i.test(url)) throw new Error('http_fetch requires an http(s) URL');
		const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000);
		const localAbort = new AbortController();
		const timer = setTimeout(() => localAbort.abort(new Error(`http_fetch timed out after ${timeoutMs}ms`)), timeoutMs);
		const signal = combineSignals(ctx.signal, localAbort.signal);
		try {
			const response = await fetch(url, {
				method: args.method ?? 'GET',
				headers: args.headers,
				body: args.body,
				signal,
			});
			const buffer = await readCapped(response, MAX_BYTES);
			return {
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
				body: buffer.toString('utf8'),
				truncated: buffer.length === MAX_BYTES,
			};
		} finally {
			clearTimeout(timer);
		}
	},
};

async function readCapped(response: Response, cap: number): Promise<Buffer> {
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const chunks: Buffer[] = [];
	let total = 0;
	while (total < cap) {
		const { value, done } = await reader.read();
		if (done) break;
		const chunk = Buffer.from(value);
		const room = cap - total;
		if (chunk.length > room) {
			chunks.push(chunk.subarray(0, room));
			total += room;
			await reader.cancel().catch(() => {});
			break;
		}
		chunks.push(chunk);
		total += chunk.length;
	}
	return Buffer.concat(chunks, total);
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const present = signals.filter((s): s is AbortSignal => Boolean(s));
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0];
	const controller = new AbortController();
	for (const s of present) {
		if (s.aborted) {
			controller.abort(s.reason);
			return controller.signal;
		}
		s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
	}
	return controller.signal;
}
