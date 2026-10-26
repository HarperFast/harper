/**
 * After `harper preview deploy`, whether the preview's URL answers from the preview itself. A deploy can succeed and
 * still serve nothing at its host: on Fabric an instance's certificate gains the `*.app.` wildcard only at its next
 * order or renewal, and a proxy in front of a self-managed cluster may not route preview hosts to the application's
 * own worker. The check reports the reason as a warning; it never fails the deploy.
 */

const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_WINDOW_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const MAX_BODY_BYTES = 4096;
// server/isolatedHostGuard.ts: a shared worker's answer for a host an isolated application owns.
const SHARED_PORT_REFUSAL = /is served by an isolated application whose worker is not running/;
const CERTIFICATE_ERRORS = new Set([
	'ERR_TLS_CERT_ALTNAME_INVALID',
	'CERT_HAS_EXPIRED',
	'CERT_NOT_YET_VALID',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

export interface Reachability {
	reachable: boolean;
	/** Set when unreachable: why, and whether trying again could change it. */
	reason?: string;
	retry?: boolean;
	status?: number;
}

type Fetch = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<Response>;

/** At most `limit` bytes of the body, then the rest is cancelled rather than read. */
async function readBodyStart(response: Response, limit = MAX_BODY_BYTES): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.length;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

function errorCode(error: any): string | undefined {
	return error?.cause?.code ?? error?.code ?? error?.cause?.cause?.code;
}

export async function probePreview(url: string, fetchImpl: Fetch = fetch as Fetch): Promise<Reachability> {
	const { host } = new URL(url);
	let response: Response;
	try {
		response = await fetchImpl(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS), redirect: 'manual' });
	} catch (error) {
		const code = errorCode(error);
		if (code === 'ENOTFOUND') {
			return {
				reachable: false,
				retry: false,
				reason: `${host} has no DNS record. On a self-managed cluster, add a wildcard record for the preview domain.`,
			};
		}
		if (code && CERTIFICATE_ERRORS.has(code)) {
			return {
				reachable: false,
				retry: false,
				reason:
					`the certificate ${host} presents does not cover it (${code}). On Fabric, an instance's certificate gains ` +
					'the *.app. wildcard at its next order or renewal, within about seven weeks; until then the preview is not served there.',
			};
		}
		const timedOut = (error as Error)?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT';
		return {
			reachable: false,
			retry: true,
			reason: timedOut
				? `${host} did not answer within ${ATTEMPT_TIMEOUT_MS / 1000}s`
				: `nothing accepted a connection to ${host} (${code ?? (error as Error)?.message})`,
		};
	}
	let body = '';
	if (response.status === 503) body = await readBodyStart(response).catch(() => '');
	else await response.body?.cancel().catch(() => {});
	if (response.status === 503 && SHARED_PORT_REFUSAL.test(body)) {
		return {
			reachable: false,
			retry: true,
			reason:
				`${host} reached Harper's shared port, not the preview's own worker: the proxy in front of the cluster does ` +
				'not route preview hosts to isolated applications (on Fabric, an nginx-mode host), or the worker is still starting.',
		};
	}
	const server = response.headers.get('server') ?? '';
	if (response.status >= 500 || ((response.status === 404 || response.status === 421) && /nginx/i.test(server))) {
		return {
			reachable: false,
			retry: response.status >= 500,
			reason: `${host} answered ${response.status}${server ? ` from ${server}` : ''}, not from the preview: whatever terminates TLS for it does not route it to the cluster's preview.`,
		};
	}
	return { reachable: true, status: response.status };
}

/** Probes until the preview answers or the window closes; only an outcome that can change is retried. */
export async function checkPreviewReachable(
	url: string,
	{
		fetchImpl = fetch as Fetch,
		windowMs = RETRY_WINDOW_MS,
		delayMs = RETRY_DELAY_MS,
	}: { fetchImpl?: Fetch; windowMs?: number; delayMs?: number } = {}
): Promise<Reachability> {
	const deadline = Date.now() + windowMs;
	for (;;) {
		let outcome: Reachability;
		try {
			outcome = await probePreview(url, fetchImpl);
		} catch (error) {
			outcome = { reachable: false, retry: false, reason: `it could not be checked: ${(error as Error)?.message}` };
		}
		if (outcome.reachable || !outcome.retry || Date.now() + delayMs >= deadline) return outcome;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
}
