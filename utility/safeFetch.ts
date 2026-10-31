'use strict';

import { createHash, type Hash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { Agent, request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { ClientError } from './errors/hdbError.ts';
import { loggerWithTag } from './logging/harper_logger.ts';

/**
 * Fetches an operator-supplied `https:` URL to a file, for pull sources that a server-side job
 * downloads on the operator's behalf. The URL is untrusted in two ways: its target may be an internal
 * address the operator could not otherwise reach (SSRF), and its query string may be a bearer
 * credential (a presigned URL). So every hop is resolved once and the connection pinned to the
 * address that passed the policy, and only `redactUrl(url)` ever leaves this module.
 */

const logger = loggerWithTag('safeFetch');

const MAX_REDIRECTS = 5;
const MAX_RESUMES = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Test-only transport overrides, keyed by a Symbol so no JSON operation body can carry them. No
 * operation passes this key; it exists so unit tests can reach a local TLS server on loopback.
 */
export const SAFE_FETCH_TEST_TRANSPORT = Symbol('safeFetch test transport');

interface TestTransport {
	trustedAddresses?: string[];
	ca?: string | Buffer;
}

export interface SafeFetchOptions {
	totalTimeoutMs: number;
	idleTimeoutMs: number;
	maxBytes?: number;
	sha256?: string;
	onBytes?: (bytes: number) => void;
	/** Fails the transfer with the signal's reason, e.g. when the bytes it is writing no longer fit. */
	signal?: AbortSignal;
	allowPrivateNetworks?: boolean;
	resume?: boolean;
	[SAFE_FETCH_TEST_TRANSPORT]?: TestTransport;
}

export interface SafeFetchResult {
	bytes: number;
	sha256: string;
	redactedUrl: string;
	etag?: string;
	lastModified?: string;
}

const alwaysDenied = new BlockList();
alwaysDenied.addSubnet('0.0.0.0', 8, 'ipv4');
alwaysDenied.addSubnet('127.0.0.0', 8, 'ipv4');
alwaysDenied.addSubnet('169.254.0.0', 16, 'ipv4');
alwaysDenied.addSubnet('224.0.0.0', 4, 'ipv4');
alwaysDenied.addSubnet('240.0.0.0', 4, 'ipv4');
alwaysDenied.addAddress('::', 'ipv6');
alwaysDenied.addAddress('::1', 'ipv6');
alwaysDenied.addSubnet('fe80::', 10, 'ipv6');
alwaysDenied.addSubnet('ff00::', 8, 'ipv6');
alwaysDenied.addAddress('fd00:ec2::254', 'ipv6');

const privateRanges = new BlockList();
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
privateRanges.addSubnet('100.64.0.0', 10, 'ipv4');
privateRanges.addSubnet('fc00::', 7, 'ipv6');
privateRanges.addSubnet('fec0::', 10, 'ipv6');

/** The eight 16-bit groups of an IPv6 address; the URL parser canonicalizes any embedded dotted quad to hex. */
function parseIPv6(address: string): number[] | undefined {
	let canonical: string;
	try {
		canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
	} catch {
		return undefined;
	}
	const [head, tail] = canonical.split('::');
	const toGroups = (part: string | undefined) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
	const high = toGroups(head);
	const low = toGroups(tail);
	const groups = tail === undefined ? high : [...high, ...new Array(8 - high.length - low.length).fill(0), ...low];
	return groups.length === 8 ? groups : undefined;
}

/** The IPv4 address an IPv6 address carries in its low 32 bits (mapped, compatible or NAT64 well-known prefix), if any. */
function embeddedIPv4(groups: number[]): string | undefined {
	const highZero = groups.slice(0, 5).every((group) => group === 0);
	const mapped = highZero && groups[5] === 0xffff;
	const compatible = highZero && groups[5] === 0 && (groups[6] !== 0 || groups[7] > 1);
	const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
	if (!mapped && !compatible && !nat64) return undefined;
	return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
}

/**
 * Whether a resolved address is one a pull source must not connect to. Loopback, link-local, cloud
 * metadata, unspecified, multicast and reserved/broadcast addresses are always denied, including when
 * written as an IPv6 form that embeds a denied IPv4 address; private ranges (RFC 1918, CGNAT, ULA)
 * are denied only with `allowPrivateNetworks: false`. Anything that is not an IP address is denied.
 */
export function isDeniedAddress(address: string, { allowPrivateNetworks = true } = {}): boolean {
	const zoneless = address.split('%')[0];
	const family = isIP(zoneless);
	if (family === 4) {
		return alwaysDenied.check(zoneless, 'ipv4') || (!allowPrivateNetworks && privateRanges.check(zoneless, 'ipv4'));
	}
	if (family !== 6) return true;
	const groups = parseIPv6(zoneless);
	if (!groups) return true;
	const v4 = embeddedIPv4(groups);
	if (v4 && isDeniedAddress(v4, { allowPrivateNetworks })) return true;
	const canonical = groups.map((group) => group.toString(16)).join(':');
	return alwaysDenied.check(canonical, 'ipv6') || (!allowPrivateNetworks && privateRanges.check(canonical, 'ipv6'));
}

/** Origin and path only: no userinfo, query or fragment, since a presigned URL's query is a credential. */
export function redactUrl(url: string | URL): string {
	let parsed: URL;
	try {
		parsed = new URL(String(url));
	} catch {
		return '<invalid URL>';
	}
	if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.origin + parsed.pathname;
	return `${parsed.protocol}//${parsed.host}`;
}

function refusal(message: string): ClientError {
	return new ClientError(message, 400);
}

function upstreamFailure(message: string, cause?: unknown): ClientError {
	const error = new ClientError(message, 502);
	if (cause !== undefined) error.cause = cause;
	return error;
}

function timeout(message: string): ClientError {
	return new ClientError(message, 504);
}

function parseHttpsUrl(url: string | URL): URL {
	let parsed: URL;
	try {
		parsed = new URL(String(url));
	} catch {
		throw refusal('Fetch URL is not a valid URL');
	}
	if (parsed.protocol !== 'https:') {
		throw refusal(`Fetch URL must use https: (got ${parsed.protocol} for ${redactUrl(parsed)})`);
	}
	if (parsed.username || parsed.password) {
		throw refusal(`Fetch URL must not carry credentials in its userinfo: ${redactUrl(parsed)}`);
	}
	return parsed;
}

interface Validated {
	hostname: string;
	addresses: { address: string; family: number }[];
}

/** One transfer's shared failure state: the first timeout or fatal error wins and tears down the live request. */
class Transfer {
	failure: Error | undefined;
	activeRequest: ClientRequest | undefined;
	redacted: string;
	idleTimeoutMs: number;
	failed: Promise<never>;
	private idleTimer: NodeJS.Timeout | undefined;
	private totalTimer: NodeJS.Timeout;
	private rejectFailed!: (error: Error) => void;

	constructor(redacted: string, idleTimeoutMs: number, totalTimeoutMs: number) {
		this.redacted = redacted;
		this.idleTimeoutMs = idleTimeoutMs;
		this.failed = new Promise<never>((_resolve, reject) => {
			this.rejectFailed = reject;
		});
		this.failed.catch(() => {});
		this.totalTimer = setTimeout(
			() => this.fail(timeout(`Fetch of ${redacted} did not complete within ${totalTimeoutMs} ms`)),
			totalTimeoutMs
		);
	}

	fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		this.rejectFailed(error);
		this.activeRequest?.destroy(error);
	}

	touch(): void {
		clearTimeout(this.idleTimer);
		if (this.failure) return;
		this.idleTimer = setTimeout(
			() => this.fail(timeout(`Fetch of ${this.redacted} received no data for ${this.idleTimeoutMs} ms`)),
			this.idleTimeoutMs
		);
	}

	pauseIdle(): void {
		clearTimeout(this.idleTimer);
	}

	race<T>(promise: Promise<T>): Promise<T> {
		return Promise.race([promise, this.failed]);
	}

	throwIfFailed(): void {
		if (this.failure) throw this.failure;
	}

	dispose(): void {
		clearTimeout(this.idleTimer);
		clearTimeout(this.totalTimer);
	}
}

async function resolveHop(url: URL, transfer: Transfer, options: SafeFetchOptions): Promise<Validated> {
	const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
	let addresses: { address: string; family: number }[];
	try {
		addresses = await transfer.race(dnsLookup(hostname, { all: true, order: 'verbatim' }));
	} catch (error) {
		transfer.throwIfFailed();
		throw upstreamFailure(`Could not resolve the host of ${redactUrl(url)}`, error);
	}
	const trusted = options[SAFE_FETCH_TEST_TRANSPORT]?.trustedAddresses ?? [];
	const allowPrivateNetworks = options.allowPrivateNetworks ?? true;
	for (const { address } of addresses) {
		if (!trusted.includes(address) && isDeniedAddress(address, { allowPrivateNetworks })) {
			throw refusal(`Fetch of ${redactUrl(url)} refused: its host resolves to a denied address (${address})`);
		}
	}
	if (addresses.length === 0) throw upstreamFailure(`Could not resolve the host of ${redactUrl(url)}`);
	return { hostname, addresses };
}

function sendRequest(
	url: URL,
	validated: Validated,
	headers: Record<string, string>,
	transfer: Transfer,
	options: SafeFetchOptions
): Promise<IncomingMessage> {
	const agent = new Agent({ keepAlive: false, ca: options[SAFE_FETCH_TEST_TRANSPORT]?.ca });
	const pinnedLookup = (_host: string, lookupOptions: any, callback: (...args: any[]) => void) => {
		const [first] = validated.addresses;
		if (lookupOptions?.all) callback(null, validated.addresses);
		else callback(null, first.address, first.family);
	};
	const req = request({
		agent,
		host: validated.hostname,
		port: url.port || 443,
		path: url.pathname + url.search,
		method: 'GET',
		headers: { 'accept-encoding': 'identity', 'user-agent': 'Harper', ...headers },
		servername: isIP(validated.hostname) ? undefined : validated.hostname,
		lookup: pinnedLookup as any,
	});
	transfer.activeRequest = req;
	req.once('close', () => agent.destroy());
	transfer.touch();
	return transfer
		.race(
			new Promise<IncomingMessage>((resolve, reject) => {
				req.once('response', resolve);
				req.on('error', reject);
				req.end();
			})
		)
		.catch((error) => {
			transfer.throwIfFailed();
			throw upstreamFailure(`Fetch of ${redactUrl(url)} failed: ${error?.code ?? error?.message ?? error}`, error);
		});
}

/** Sends a GET, following up to MAX_REDIRECTS redirects, each re-validated as if it were the original URL. */
async function openFollowingRedirects(
	url: URL,
	headers: Record<string, string>,
	transfer: Transfer,
	options: SafeFetchOptions
): Promise<IncomingMessage> {
	let current = url;
	for (let hop = 0; ; hop++) {
		const validated = await resolveHop(current, transfer, options);
		transfer.throwIfFailed();
		logger.trace?.(`GET ${redactUrl(current)} via ${validated.addresses.map(({ address }) => address).join(', ')}`);
		const response = await sendRequest(current, validated, headers, transfer, options);
		if (!REDIRECT_STATUSES.has(response.statusCode)) return response;
		response.resume();
		response.destroy();
		const location = response.headers.location;
		if (!location) {
			throw upstreamFailure(`Fetch of ${redactUrl(current)} answered ${response.statusCode} without a Location`);
		}
		if (hop >= MAX_REDIRECTS) {
			throw refusal(`Fetch of ${redactUrl(url)} refused: more than ${MAX_REDIRECTS} redirects`);
		}
		let next: URL;
		try {
			next = new URL(location, current);
		} catch {
			throw upstreamFailure(`Fetch of ${redactUrl(current)} redirected to an invalid URL`);
		}
		try {
			current = parseHttpsUrl(next);
		} catch (error) {
			throw refusal(`Fetch of ${redactUrl(url)} refused a redirect: ${(error as Error).message}`);
		}
	}
}

/** Content-Range `bytes <start>-<end>/<total>`; undefined when absent or malformed. */
function parseContentRange(header: string | undefined): { start: number; end: number; total: number } | undefined {
	const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header?.trim() ?? '');
	if (!match) return undefined;
	const [start, end, total] = match.slice(1).map(Number);
	return end >= start && total > end ? { start, end, total } : undefined;
}

function contentLength(response: IncomingMessage): number | undefined {
	const header = response.headers['content-length'];
	if (header === undefined || !/^\d+$/.test(header)) return undefined;
	return Number(header);
}

interface Identity {
	etag?: string;
	lastModified?: string;
	total?: number;
}

/** Writes the response body to `out`, metering and hashing it. Resolves true when the body ended, false when it broke. */
async function receiveBody(
	response: IncomingMessage,
	out: WriteStream,
	state: { bytes: number; hash: Hash },
	transfer: Transfer,
	options: SafeFetchOptions
): Promise<boolean> {
	try {
		for await (const chunk of response) {
			transfer.touch();
			if (options.maxBytes !== undefined && state.bytes + chunk.length > options.maxBytes) {
				transfer.fail(new ClientError(`Fetch of ${transfer.redacted} exceeds ${options.maxBytes} bytes`, 413));
				throw transfer.failure;
			}
			state.hash.update(chunk);
			state.bytes += chunk.length;
			options.onBytes?.(chunk.length);
			if (!out.write(chunk)) {
				transfer.pauseIdle();
				await transfer.race(once(out, 'drain'));
				transfer.touch();
			}
		}
		return true;
	} catch (error) {
		transfer.throwIfFailed();
		logger.trace?.(`Fetch of ${transfer.redacted} broke after ${state.bytes} bytes: ${(error as any)?.code ?? error}`);
		return false;
	}
}

async function closeOutput(out: WriteStream, transfer: Transfer): Promise<void> {
	out.end();
	await transfer.race(finished(out));
}

/**
 * Downloads `url` to `destPath` under the pull-source policy. A transfer that breaks mid-body is
 * resumed with `Range` bound to the first response's identity (`If-Range`), or restarted from zero
 * when identity cannot be established or the server answers with a different object. On any failure
 * the partial file is removed.
 */
export async function safeFetchToFile(
	url: string,
	destPath: string,
	options: SafeFetchOptions
): Promise<SafeFetchResult> {
	const target = parseHttpsUrl(url);
	const redacted = redactUrl(target);
	const transfer = new Transfer(redacted, options.idleTimeoutMs, options.totalTimeoutMs);
	const abort = () =>
		transfer.fail(
			options.signal!.reason instanceof Error ? options.signal!.reason : new Error(String(options.signal!.reason))
		);
	if (options.signal?.aborted) abort();
	else options.signal?.addEventListener('abort', abort, { once: true });
	const resume = options.resume ?? true;
	const state = { bytes: 0, hash: createHash('sha256') };
	let identity: Identity = {};
	let out: WriteStream | undefined;
	try {
		for (let attempt = 0; ; attempt++) {
			const validator = identity.etag ?? identity.lastModified;
			const ranged = state.bytes > 0 && validator !== undefined && identity.total !== undefined;
			const headers: Record<string, string> = ranged ? { 'range': `bytes=${state.bytes}-`, 'if-range': validator } : {};
			const response = await openFollowingRedirects(target, headers, transfer, options);
			const status = response.statusCode;
			const restart = status === 200;
			if (status === 206 && ranged) {
				const range = parseContentRange(response.headers['content-range']);
				if (!range || range.start !== state.bytes || range.total !== identity.total) {
					logger.trace?.(`Fetch of ${redacted}: Content-Range does not continue the transfer; restarting from zero`);
					response.destroy();
					state.bytes = 0;
					state.hash = createHash('sha256');
					identity = {};
					if (attempt >= MAX_RESUMES) throw upstreamFailure(`Fetch of ${redacted} could not be resumed`);
					continue;
				}
			} else if (status !== 200) {
				response.resume();
				throw upstreamFailure(`Fetch of ${redacted} answered HTTP ${status}`);
			}
			if (restart) {
				const etag = response.headers.etag;
				identity = {
					etag: etag && !etag.startsWith('W/') ? etag : undefined,
					lastModified: response.headers['last-modified'],
					total: contentLength(response),
				};
				if (options.maxBytes !== undefined && identity.total !== undefined && identity.total > options.maxBytes) {
					response.destroy();
					throw new ClientError(`Fetch of ${redacted} is ${identity.total} bytes, over ${options.maxBytes}`, 413);
				}
				if (state.bytes > 0) logger.trace?.(`Fetch of ${redacted}: server sent the whole object; restarting from zero`);
				state.bytes = 0;
				state.hash = createHash('sha256');
			}
			out = createWriteStream(destPath, { flags: restart ? 'w' : 'a' });
			out.on('error', (error) => transfer.fail(error));
			const ended = await receiveBody(response, out, state, transfer, options);
			await closeOutput(out, transfer);
			out = undefined;
			const complete = ended && (identity.total === undefined || state.bytes === identity.total);
			if (complete) break;
			if (!resume || attempt >= MAX_RESUMES) {
				throw upstreamFailure(`Fetch of ${redacted} was interrupted after ${state.bytes} bytes`);
			}
			logger.trace?.(`Fetch of ${redacted}: resuming at ${state.bytes} bytes`);
		}
		transfer.throwIfFailed();
		const sha256 = state.hash.digest('hex');
		if (options.sha256 !== undefined && options.sha256.toLowerCase() !== sha256) {
			throw upstreamFailure(`Fetch of ${redacted} does not match the expected sha256 (got ${sha256})`);
		}
		const result: SafeFetchResult = { bytes: state.bytes, sha256, redactedUrl: redacted };
		if (identity.etag) result.etag = identity.etag;
		if (identity.lastModified) result.lastModified = identity.lastModified;
		return result;
	} catch (error) {
		transfer.fail(error as Error);
		out?.destroy();
		if (out) await finished(out).catch(() => {});
		await rm(destPath, { force: true });
		throw error;
	} finally {
		transfer.dispose();
	}
}
