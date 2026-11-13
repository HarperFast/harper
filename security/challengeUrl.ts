const MAX_CHALLENGE_URL_LENGTH = 2048;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '[::1]']);
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True for a URL that can name RFC 9728 protected-resource metadata in a `WWW-Authenticate` challenge, quoted as
 * is. Visible ASCII only, without `"` or `\`, so it cannot end the quoted string or the header. `https:` with no
 * fragment, as RFC 9728 requires of the identifiers it builds on; `http:` only for a loopback host, for local
 * development.
 */
export function isValidChallengeUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CHALLENGE_URL_LENGTH) return false;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x21 || code > 0x7e || code === 0x22 || code === 0x5c || code === 0x23) return false;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol === 'https:') return true;
	return url.protocol === 'http:' && (LOOPBACK_HOSTNAMES.has(url.hostname) || IPV4_LOOPBACK.test(url.hostname));
}
