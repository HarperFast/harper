/**
 * Resolves a client certificate's issuer from Harper's own trusted certificate authorities.
 *
 * Node completes a peer chain from the trust store only through the listener's default TLS
 * context; Harper's client CAs live on the SNI contexts built by createTLSSelector, so whenever the
 * client-sent chain is unavailable (every resumed TLS session; Node 26.8.0/26.8.1 on every
 * connection, nodejs/node#65579) getPeerCertificate(true) exposes the leaf alone. The CA set that
 * authorized the connection is the same set published here, so the issuer is recoverable from it
 * unless it is an intermediate the client sent but Harper does not trust directly.
 */

import { X509Certificate, createHash } from 'node:crypto';

const PEM_CERTIFICATE_PATTERN =
	/-----BEGIN (?:TRUSTED |X509 )?CERTIFICATE-----[\s\S]*?-----END (?:TRUSTED |X509 )?CERTIFICATE-----/g;
const MAX_RESOLVED_LEAVES = 10_000;

let trustedAuthorities: X509Certificate[] = [];
let publishedAuthorityPems = '';
let resolvedIssuers = new Map<string, Buffer | null>();

/**
 * Publish the current trusted authority set (PEM strings, each possibly a bundle of several
 * certificates). Replaces the previous generation atomically and drops its resolution cache,
 * unless the set is unchanged. Unparseable certificates are skipped so one bad record cannot
 * disable resolution for the rest; this never throws, because it runs inside the TLS selector's
 * publication step.
 */
export function publishTrustedAuthorities(authorityPems: Iterable<unknown>): void {
	const pems = Array.from(authorityPems).filter((pem): pem is string => typeof pem === 'string');
	const joined = pems.join('\n');
	if (joined === publishedAuthorityPems) return;
	publishedAuthorityPems = joined;
	const parsed: X509Certificate[] = [];
	for (const pem of pems) {
		for (const block of pem.match(PEM_CERTIFICATE_PATTERN) ?? []) {
			try {
				parsed.push(new X509Certificate(block));
			} catch {}
		}
	}
	trustedAuthorities = parsed;
	resolvedIssuers = new Map();
}

/**
 * Find the trusted authority that issued `leafDer`: subject/AKI match plus a signature check, so a
 * same-named authority with a different key never counts, and a certificate is never its own
 * issuer. Returns the issuer's DER, or undefined.
 */
export function resolveTrustedIssuer(leafDer: Buffer, fingerprint256?: string): Buffer | undefined {
	if (trustedAuthorities.length === 0) return undefined;
	const key = fingerprint256 ?? createHash('sha256').update(leafDer).digest('hex');
	const cached = resolvedIssuers.get(key);
	if (cached !== undefined) return cached ?? undefined;

	let issuer: Buffer | null = null;
	try {
		const leaf = new X509Certificate(leafDer);
		for (const authority of trustedAuthorities) {
			try {
				if (
					authority.fingerprint256 !== leaf.fingerprint256 &&
					leaf.checkIssued(authority) &&
					leaf.verify(authority.publicKey)
				) {
					issuer = authority.raw;
					break;
				}
			} catch {}
		}
	} catch {}
	if (resolvedIssuers.size >= MAX_RESOLVED_LEAVES) resolvedIssuers.clear();
	resolvedIssuers.set(key, issuer);
	return issuer ?? undefined;
}
