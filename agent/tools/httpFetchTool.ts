/**
 * `http_fetch` for the built-in agent (#626). Wraps the platform `fetch`
 * with a size cap, an inactivity timeout, and a metadata/link-local blocklist
 * so the agent can probe its own deployed components and pull lightweight
 * web pages for context without becoming an SSRF vector against cloud
 * instance-metadata endpoints.
 *
 * The operator bounds it further with the boot-time `agent.httpFetch` policy
 * (#2974): `false` removes the tool, `{ allow: [...] }` limits it to named
 * hosts. Every target — the first request and each redirect hop — is checked
 * before it is sent, so redirects are followed here rather than by `fetch`.
 */

import { BlockList, isIP } from 'node:net';
import type { AgentTool, AgentToolContext, HttpFetchConfig } from '../types.ts';

export const HTTP_FETCH_TOOL_NAME = 'http_fetch';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB cap on response bodies
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 20; // fetch's own limit
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// What fetch removes from a redirected request: credentials on an origin change, and the body
// headers when the redirect turns the request into a body-less GET.
const CROSS_ORIGIN_REDIRECT_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'host'];
const REQUEST_BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];

// Cloud-metadata services, exposed to a prompt-controlled fetch, are a credential-leak vector.
// Loopback to the local Harper instance stays reachable for self-testing.
const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);
const METADATA_ADDRESSES = new BlockList();
METADATA_ADDRESSES.addAddress('169.254.169.254', 'ipv4'); // AWS / GCP / Azure IMDS
METADATA_ADDRESSES.addAddress('fd00:ec2::254', 'ipv6'); // AWS IMDS IPv6
// Covers IMDS variants beyond the canonical address.
const LINK_LOCAL_ADDRESSES = new BlockList();
LINK_LOCAL_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');

const ALLOW_ENTRY = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::(\d{1,5}))?$/;

export interface HostRule {
	/** Canonical host; for a wildcard, the domain its subdomains must end in. */
	host: string;
	wildcard: boolean;
	/** When absent, any port matches. */
	port?: number;
}

/**
 * Validate and normalize the raw `agent.httpFetch` config value. An empty allow-list reaches
 * nothing, so it resolves to `false` (no tool) rather than a tool that refuses every call.
 */
export function resolveHttpFetchConfig(raw: unknown): HttpFetchConfig {
	if (raw === undefined || raw === true) return true;
	if (raw === false) return false;
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error(`agent.httpFetch must be true, false, or { allow: [...] }; got ${JSON.stringify(raw)}`);
	}
	const unknownKeys = Object.keys(raw).filter((key) => key !== 'allow');
	if (unknownKeys.length > 0) {
		throw new Error(`agent.httpFetch has unknown key(s): ${unknownKeys.join(', ')}`);
	}
	const allow = (raw as { allow?: unknown }).allow;
	if (!Array.isArray(allow)) {
		throw new Error(`agent.httpFetch.allow must be a list of hosts; got ${JSON.stringify(allow)}`);
	}
	compileAllowList(allow);
	return allow.length === 0 ? false : { allow: [...allow] };
}

export function compileAllowList(entries: readonly unknown[]): HostRule[] {
	return entries.map(parseAllowEntry);
}

function parseAllowEntry(entry: unknown): HostRule {
	const invalid = (reason: string) =>
		new Error(`agent.httpFetch.allow entry ${JSON.stringify(entry)} is invalid: ${reason}`);
	if (typeof entry !== 'string') throw invalid('expected a string');
	const match = /[\s/?#@\\]/.test(entry) ? null : ALLOW_ENTRY.exec(entry);
	if (!match) throw invalid('expected host, host:port, *.domain, or [ipv6], without a scheme or path');
	const [, ipv6, name, portText] = match;
	const port = portText === undefined ? undefined : Number(portText);
	if (port !== undefined && (port < 1 || port > 65535)) throw invalid('port must be 1-65535');
	if (ipv6 !== undefined) {
		// `isIP` accepts a zone ID (`fe80::1%eth0`) that `URL` cannot parse.
		const parsed = isIP(ipv6) === 6 ? URL.parse(`http://[${ipv6}]`) : null;
		if (!parsed) throw invalid('bracketed host is not an IPv6 address');
		return { host: parsed.hostname, wildcard: false, port };
	}
	const wildcard = name.startsWith('*.');
	const domain = wildcard ? name.slice(2) : name;
	if (!domain || domain.includes('*')) throw invalid('"*" is only allowed as a leading "*." label');
	let host: string;
	try {
		host = canonicalHost(new URL(`http://${domain}`).hostname);
	} catch {
		throw invalid('not a valid host name');
	}
	if (wildcard && isIP(host)) throw invalid('a wildcard cannot apply to an IP address');
	return { host, wildcard, port };
}

/**
 * Throws unless `url` may be requested: http(s) only, never a metadata or link-local address, and,
 * with an allow-list, only a matching host. The metadata checks run first, so listing a metadata
 * host does not admit it.
 */
export function checkHttpFetchTarget(url: URL, allow?: readonly HostRule[]): void {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`http_fetch requires an http(s) URL; got ${url.protocol}`);
	}
	const host = canonicalHost(url.hostname);
	const address = host.startsWith('[') ? host.slice(1, -1) : host;
	const family = isIP(address);
	const addressType = family === 6 ? 'ipv6' : 'ipv4';
	if (METADATA_HOSTNAMES.has(host) || (family && METADATA_ADDRESSES.check(address, addressType))) {
		throw new Error(`http_fetch blocked by metadata-host policy: ${host}`);
	}
	if (family && LINK_LOCAL_ADDRESSES.check(address, addressType)) {
		throw new Error(`http_fetch blocked by link-local policy: ${host}`);
	}
	if (allow && !allow.some((rule) => hostRuleMatches(rule, host, effectivePort(url)))) {
		throw new Error(`http_fetch refused by policy: ${url.host} is not in agent.httpFetch.allow`);
	}
}

function hostRuleMatches(rule: HostRule, host: string, port: number): boolean {
	if (rule.port !== undefined && rule.port !== port) return false;
	return rule.wildcard ? host.endsWith(`.${rule.host}`) : host === rule.host;
}

// `URL` keeps a fully-qualified name's trailing dot; `localhost.` and `localhost` are the same host.
function canonicalHost(hostname: string): string {
	return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

function effectivePort(url: URL): number {
	if (url.port) return Number(url.port);
	return url.protocol === 'https:' ? 443 : 80;
}

export function buildHttpFetchTool(config: HttpFetchConfig = true): AgentTool | undefined {
	if (config === false) return undefined;
	const allowEntries = config === true ? undefined : config.allow;
	if (allowEntries?.length === 0) return undefined;
	const allow = allowEntries && compileAllowList(allowEntries);
	const description = allowEntries
		? `Issue an HTTP request from the Harper server. Operator policy limits it to these hosts: ${allowEntries.join(', ')} (a "*." entry covers subdomains; an entry without a port covers any port). Requests to any other host, including redirects to one, are refused.`
		: "Issue an HTTP request from the Harper server. Useful for hitting the agent's own components on localhost and pulling reference pages.";
	return {
		def: {
			name: HTTP_FETCH_TOOL_NAME,
			description,
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
		handler: (args: any, ctx: AgentToolContext) => httpFetch(args, ctx, allow),
	};
}

async function httpFetch(args: any, ctx: AgentToolContext, allow: readonly HostRule[] | undefined) {
	const url = String(args.url ?? '');
	if (!/^https?:\/\//i.test(url)) throw new Error('http_fetch requires an http(s) URL');
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`http_fetch could not parse URL: ${url}`);
	}
	checkHttpFetchTarget(parsed, allow);
	const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000);
	const localAbort = new AbortController();
	const timer = setTimeout(() => localAbort.abort(new Error(`http_fetch timed out after ${timeoutMs}ms`)), timeoutMs);
	const signal = combineSignals(ctx.signal, localAbort.signal);
	try {
		const response = await fetchCheckingRedirects(
			parsed,
			{
				method: String(args.method ?? 'GET').toUpperCase(),
				headers: new Headers(args.headers),
				body: args.body,
				signal,
			},
			allow
		);
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
}

interface HopRequest {
	method: string;
	headers: Headers;
	body?: string;
	signal?: AbortSignal;
}

/**
 * Follow redirects one hop at a time so each target passes `checkHttpFetchTarget` before it is
 * requested. Method, body and header handling mirror fetch's own redirect step.
 */
async function fetchCheckingRedirects(
	initial: URL,
	request: HopRequest,
	allow: readonly HostRule[] | undefined
): Promise<Response> {
	let url = initial;
	let { method, body } = request;
	const { headers, signal } = request;
	for (let redirects = 0; ; redirects++) {
		const response = await fetch(url, { method, headers, body, signal, redirect: 'manual' });
		const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
		if (location === null) return response;
		await response.body?.cancel().catch(() => {});
		if (redirects === MAX_REDIRECTS) throw new Error(`http_fetch stopped after ${MAX_REDIRECTS} redirects`);
		let next: URL;
		try {
			next = new URL(location, url);
		} catch {
			throw new Error(`http_fetch could not parse redirect Location: ${location}`);
		}
		checkHttpFetchTarget(next, allow);
		if (
			((response.status === 301 || response.status === 302) && method === 'POST') ||
			(response.status === 303 && method !== 'GET' && method !== 'HEAD')
		) {
			method = 'GET';
			body = undefined;
			for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
		}
		if (next.origin !== url.origin) {
			for (const name of CROSS_ORIGIN_REDIRECT_HEADERS) headers.delete(name);
		}
		url = next;
	}
}

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
