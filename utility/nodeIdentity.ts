import { isIP } from 'node:net';

/**
 * A node's identity — node.hostname, and the replication.hostname / certificate it falls back to —
 * must be a bare hostname or IP literal, not a URL: it becomes the certificate common name and the
 * host replication advertises and dials, so a scheme/port/path/non-string corrupts both (harper#2218,
 * where "ws://http://host:9926:9925" resolves to host "http"). Returns a reason clause when `value`
 * is not a bare host, else undefined. An empty string is "unset" (a caller's cue to fall back), not a
 * violation.
 */
export function bareHostViolation(value: unknown): string | undefined {
	if (typeof value !== 'string') return `must be a string, but is a ${value === null ? 'null' : typeof value}`;
	if (value === '') return undefined;
	// The identity is stored unbracketed (bracketing belongs to URL construction). Reject a bracketed
	// form so it is never cached — otherwise net.isIP fails on it and the certificate SAN is mistyped
	// as DNS rather than IP, and the same node's identity string would differ by source.
	if (value.includes('[') || value.includes(']'))
		return 'must be an unbracketed IPv6 literal (e.g. "::1", not "[::1]")';
	// A zone id ("fe80::1%eth0") passes net.isIP but has no valid URL authority, so exclude it here.
	if (isIP(value) && !value.includes('%')) return undefined; // a bare IPv4/IPv6 literal is a valid identity
	if (value.includes('://')) return 'must not include a URL scheme';
	let url;
	try {
		// Parse under a special scheme so the host grammar matches the ws:// replication URLs that
		// consume this value — a host this accepts is one the consumer accepts (a non-special scheme is
		// more lenient and would pass e.g. "node%20" or "0x7f.1"). A port or path makes url.hostname
		// differ from the input and is caught by the round-trip check below.
		url = new URL(`https://${value}`);
	} catch {
		return 'is not a valid hostname';
	}
	// Report the port before the round-trip check: the parser strips a default port for the scheme it
	// was given (":443" under https), which would otherwise surface as a vaguer "is not a bare hostname".
	if (url.port || (url.hostname && value.slice(url.hostname.length).startsWith(':'))) {
		return 'must not include a port';
	}
	if (url.username || url.password) return 'must not include credentials';
	if (url.search) return 'must not include a query string';
	if (url.hash) return 'must not include a fragment';
	if (url.pathname && url.pathname !== '/') return 'must not include a path';
	// The host must survive parsing unchanged (compared case-insensitively, since URL lowercases it);
	// anything that does not round-trip carried extra syntax and is not a bare host.
	if (url.hostname.toLowerCase() !== value.toLowerCase()) return 'is not a bare hostname';
	return undefined;
}
