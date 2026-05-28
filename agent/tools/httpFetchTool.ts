/**
 * `http_fetch` for the built-in agent (#626). Wraps the platform `fetch`
 * with a size cap, an inactivity timeout, and a metadata/loopback blocklist
 * so the agent can probe its own deployed components and pull lightweight
 * web pages for context without becoming an SSRF vector against cloud
 * instance-metadata endpoints or unrelated internal services.
 */

import { isIP } from 'node:net';
import type { AgentTool, AgentToolContext } from '../types.ts';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB cap on response bodies
const DEFAULT_TIMEOUT_MS = 30_000;
// Hard-blocked literal hosts. Cloud-metadata services live on these IPs and exposing them
// to a prompt-controlled fetch is a credential-leak vector. Loopback to the local Harper
// instance is allowed via `localhost`/`127.0.0.1` for self-testing — those are NOT blocked.
const BLOCKED_HOSTS = new Set([
	'169.254.169.254', // AWS / GCP / Azure IMDS
	'fd00:ec2::254', // AWS IMDSv2 IPv6
	'metadata.google.internal',
	'metadata.goog',
]);

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
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`http_fetch could not parse URL: ${url}`);
		}
		const host = parsed.hostname.toLowerCase();
		if (BLOCKED_HOSTS.has(host)) {
			throw new Error(`http_fetch blocked by metadata-host policy: ${host}`);
		}
		// IPv4 link-local (169.254.0.0/16) covers IMDS variants beyond the canonical 169.254.169.254.
		if (isIP(host) === 4 && host.startsWith('169.254.')) {
			throw new Error(`http_fetch blocked by link-local policy: ${host}`);
		}
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
	// `AbortSignal.any` (Node 20+) manages listener cleanup internally; the manual
	// `addEventListener` approach leaked listeners on `ctx.signal` for the lifetime of the agent
	// run when a fetch completed normally.
	return AbortSignal.any(present);
}
