/**
 * PROXY protocol header decoding — v1 (text) and v2 (binary) — for plaintext
 * sockets fronted by a trusted proxy (e.g. symphony on the per-worker UDS
 * mirrors, which terminates TLS and forwards the original connection facts).
 *
 * Beyond the client source address, the v2 TLV vector can carry TLS facts the
 * proxy observed — most importantly the mTLS client certificate chain (custom
 * TLV 0xE2, one DER-encoded certificate per TLV, leaf first). Symphony only
 * emits the chain after its verifier accepted it, so on a trusted link a
 * forwarded chain is treated like a directly-terminated, verified client cert:
 * `applyProxyHeader` gives the socket TLSSocket-shaped `authorized` and
 * `getPeerCertificate()` so the existing mTLS auth paths (HTTP and MQTT) work
 * unchanged.
 *
 * Trust model: identical to the PROXY v1 source-address override — anything
 * that can write to the socket can claim any identity, so this must only be
 * enabled on sockets reachable solely by the fronting proxy (filesystem-
 * permissioned UDS paths).
 */

import { X509Certificate } from 'node:crypto';

// PROXY v1 max header length per spec: 108 bytes
const PROXY_V1_MAX_HEADER = 108;
const PROXY_V1_PREFIX = Buffer.from('PROXY ');
const PROXY_V2_SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

const PP2_FAMILY_TCP4 = 0x11;
const PP2_FAMILY_TCP6 = 0x21;
const PP2_TYPE_SSL = 0x20;
// Custom-range TLVs (0xE0-0xEF are application-specific per the spec), matching
// symphony's allocation: 0xE0 = JA3, 0xE1 = JA4, 0xE2 = client cert chain.
const PP2_TYPE_CLIENT_CERT = 0xe2;
const PP2_CLIENT_CERT_CONN = 0x02;

export interface ForwardedTls {
	/** True when the proxy reported the presented client cert as verified (PP2 SSL TLV verify == 0). */
	verified: boolean;
	/** Client certificate chain (DER, leaf first) from PP2 0xE2 TLVs. */
	clientCertChain: Buffer[];
}

export interface DecodedProxyHeader {
	kind: 'header';
	/** Total bytes of the PROXY header; application data starts at this offset. */
	headerLength: number;
	srcIp?: string;
	srcPort?: number;
	tls?: ForwardedTls;
}

export type ProxyHeaderDecision = { kind: 'incomplete' } | { kind: 'none' } | DecodedProxyHeader;

/**
 * Decode a PROXY protocol v1 or v2 header from the start of `buffer`.
 * Returns 'incomplete' when more bytes could still form a valid header (the
 * caller should keep accumulating), 'none' when the connection does not start
 * with a PROXY header (forward everything unchanged).
 */
export function decodeProxyHeader(buffer: Buffer): ProxyHeaderDecision {
	// v2 first; its binary signature cannot collide with the v1 "PROXY " prefix.
	const v2CompareLength = Math.min(PROXY_V2_SIGNATURE.length, buffer.length);
	if (buffer.compare(PROXY_V2_SIGNATURE, 0, v2CompareLength, 0, v2CompareLength) === 0) {
		if (buffer.length < 16) return { kind: 'incomplete' };
		return decodeV2(buffer);
	}
	const v1CompareLength = Math.min(PROXY_V1_PREFIX.length, buffer.length);
	if (buffer.compare(PROXY_V1_PREFIX, 0, v1CompareLength, 0, v1CompareLength) === 0) {
		return decodeV1(buffer);
	}
	return { kind: 'none' };
}

function decodeV1(buffer: Buffer): ProxyHeaderDecision {
	const header = buffer.toString('latin1', 0, Math.min(PROXY_V1_MAX_HEADER, buffer.length));
	const eol = header.indexOf('\r\n');
	if (eol === -1) {
		// No CRLF within the spec max means it isn't a valid PROXY header after all.
		return buffer.length < PROXY_V1_MAX_HEADER ? { kind: 'incomplete' } : { kind: 'none' };
	}
	// "PROXY TCP4 <src-ip> <dst-ip> <src-port> <dst-port>"
	const decoded: DecodedProxyHeader = { kind: 'header', headerLength: eol + 2 };
	const parts = header.slice(0, eol).split(' ');
	if (parts.length === 6) {
		decoded.srcIp = parts[2];
		decoded.srcPort = parseInt(parts[4], 10);
	}
	return decoded;
}

function decodeV2(buffer: Buffer): ProxyHeaderDecision {
	const headerLength = 16 + buffer.readUInt16BE(14);
	if (buffer.length < headerLength) return { kind: 'incomplete' };
	const versionCommand = buffer[12];
	if ((versionCommand & 0xf0) !== 0x20) return { kind: 'none' };
	const decoded: DecodedProxyHeader = { kind: 'header', headerLength };
	// Command LOCAL (0x0, health checks) carries no usable addresses; only PROXY (0x1) does.
	if ((versionCommand & 0x0f) !== 0x01) return decoded;

	const family = buffer[13];
	let tlvOffset: number;
	if (family === PP2_FAMILY_TCP4 && headerLength >= 16 + 12) {
		decoded.srcIp = `${buffer[16]}.${buffer[17]}.${buffer[18]}.${buffer[19]}`;
		decoded.srcPort = buffer.readUInt16BE(24);
		tlvOffset = 16 + 12;
	} else if (family === PP2_FAMILY_TCP6 && headerLength >= 16 + 36) {
		decoded.srcIp = formatIpv6(buffer, 16);
		decoded.srcPort = buffer.readUInt16BE(48);
		tlvOffset = 16 + 36;
	} else {
		// Unknown/unspecified family: consume the header but read no addresses or TLVs.
		return decoded;
	}

	let certPresented = false;
	let verified = false;
	let clientCertChain: Buffer[] | undefined;
	while (tlvOffset + 3 <= headerLength) {
		const type = buffer[tlvOffset];
		const valueLength = buffer.readUInt16BE(tlvOffset + 1);
		const valueEnd = tlvOffset + 3 + valueLength;
		if (valueEnd > headerLength) break; // malformed TLV — keep what we parsed so far
		if (type === PP2_TYPE_SSL && valueLength >= 5) {
			// struct pp2_tlv_ssl: client(1) verify(4, 0 = verified ok), then sub-TLVs
			certPresented = (buffer[tlvOffset + 3] & PP2_CLIENT_CERT_CONN) !== 0;
			verified = buffer.readUInt32BE(tlvOffset + 4) === 0;
		} else if (type === PP2_TYPE_CLIENT_CERT && valueLength > 0) {
			// Copy so the retained chain doesn't pin the connection's first read buffer.
			(clientCertChain ??= []).push(Buffer.from(buffer.subarray(tlvOffset + 3, valueEnd)));
		}
		tlvOffset = valueEnd;
	}
	if (certPresented && clientCertChain) {
		decoded.tls = { verified, clientCertChain };
	}
	return decoded;
}

/**
 * Format 16 address bytes as compressed IPv6 (longest zero run becomes '::'),
 * matching Node's net.Socket remoteAddress format so downstream string
 * comparisons (logs, allowlists) behave the same as for direct connections.
 */
function formatIpv6(buffer: Buffer, offset: number): string {
	const groups: number[] = [];
	for (let i = 0; i < 16; i += 2) {
		groups.push(buffer.readUInt16BE(offset + i));
	}
	// Find the longest run of zero groups (must be at least 2 to compress)
	let bestStart = -1;
	let bestLength = 1;
	for (let i = 0; i < 8;) {
		if (groups[i] !== 0) {
			i++;
			continue;
		}
		let end = i;
		while (end < 8 && groups[end] === 0) end++;
		if (end - i > bestLength) {
			bestStart = i;
			bestLength = end - i;
		}
		i = end;
	}
	if (bestStart === -1) return groups.map((g) => g.toString(16)).join(':');
	const head = groups.slice(0, bestStart).map((g) => g.toString(16));
	const tail = groups.slice(bestStart + bestLength).map((g) => g.toString(16));
	return `${head.join(':')}::${tail.join(':')}`;
}

/**
 * Apply a decoded PROXY header to the socket: override remoteAddress/remotePort
 * with the real client values, and when the proxy forwarded a verified client
 * cert chain, expose it with TLSSocket semantics (`authorized`,
 * `getPeerCertificate()`) so mTLS auth treats it like a directly-terminated cert.
 */
export function applyProxyHeader(socket: any, header: DecodedProxyHeader): void {
	if (header.srcIp !== undefined) {
		Object.defineProperty(socket, 'remoteAddress', { value: header.srcIp, configurable: true });
		Object.defineProperty(socket, 'remotePort', { value: header.srcPort, configurable: true });
	}
	const tls = header.tls;
	if (tls) {
		let detailedCertificate: any;
		let leafCertificate: any;
		socket.authorized = tls.verified;
		// Lazy so X509 parsing only happens when an auth path actually reads the
		// cert. Matches Node's TLSSocket API: detailed=true includes the
		// issuerCertificate chain, otherwise just the peer certificate.
		socket.getPeerCertificate = (detailed?: boolean) => {
			detailedCertificate ??= synthesizePeerCertificate(tls.clientCertChain);
			if (detailed) return detailedCertificate;
			if (!leafCertificate) {
				const { issuerCertificate: _omitted, ...leaf } = detailedCertificate;
				leafCertificate = leaf;
			}
			return leafCertificate;
		};
	}
}

/**
 * Consume a leading PROXY header (v1 or v2) from a socket that has no data
 * listeners attached yet, apply it to the socket, then call `handoff`. Bytes
 * beyond the header are unshifted so whatever parser `handoff` attaches reads
 * them first. Connections that don't start with a PROXY header hand off on
 * first bytes, unmodified.
 */
export function consumeProxyHeader(socket: any, handoff: () => void): void {
	let buffered: Buffer | null = null;
	const onReadable = () => {
		let chunk: Buffer;
		while ((chunk = socket.read()) !== null) {
			buffered = buffered ? Buffer.concat([buffered, chunk]) : chunk;
			const decision = decodeProxyHeader(buffered);
			// A valid header may still be forming — keep buffering.
			if (decision.kind === 'incomplete') continue;
			socket.removeListener('readable', onReadable);
			let rest = buffered;
			if (decision.kind === 'header') {
				applyProxyHeader(socket, decision);
				rest = buffered.subarray(decision.headerLength);
			}
			if (rest.length > 0) socket.unshift(rest);
			return handoff();
		}
	};
	socket.on('readable', onReadable);
}

/**
 * Wrap a raw-socket connection listener so any leading PROXY header is decoded
 * and applied BEFORE the listener runs. enableProxyProtocol-style data-path
 * interception only fixes up the socket when the first data event fires — too
 * late for protocols like MQTT that read `socket.authorized`/`remoteAddress`
 * at connection time. A connection that stalls before completing the header is
 * destroyed after `prehandoffTimeout` ms so it can't hold an fd forever.
 */
export function withProxyProtocol(listener: (socket: any) => void, prehandoffTimeout = 10_000): (socket: any) => void {
	return (socket: any) => {
		applyDefaultPeerCertificate(socket);
		// The listener's own error/timeout handling isn't attached yet.
		const onPrehandoff = () => socket.destroy();
		socket.on('error', onPrehandoff);
		socket.setTimeout(prehandoffTimeout, onPrehandoff);
		consumeProxyHeader(socket, () => {
			socket.removeListener('error', onPrehandoff);
			socket.setTimeout(0);
			socket.removeListener('timeout', onPrehandoff);
			listener(socket);
		});
	};
}

const returnEmptyPeerCertificate = () => ({});

/**
 * Give a plaintext socket the shape of a TLSSocket that received no client
 * cert (`getPeerCertificate()` returning `{}`, `authorized: false`) so
 * mTLS-aware code doesn't need to distinguish proxied sockets from TLS ones.
 */
export function applyDefaultPeerCertificate(socket: any): void {
	socket.authorized = false;
	socket.getPeerCertificate = returnEmptyPeerCertificate;
}

/**
 * Build a Node `getPeerCertificate(true)`-shaped object from a DER chain
 * (leaf first): parsed subject/issuer, validity, fingerprints, `raw`, and
 * `issuerCertificate` links (self-referencing on a self-signed root, matching
 * Node) so certificateVerification's chain walk and OCSP/CRL checks work.
 */
export function synthesizePeerCertificate(chain: Buffer[]): any {
	let leaf: any = null;
	let previous: any = null;
	let previousX509: X509Certificate | null = null;
	for (const der of chain) {
		let x509: X509Certificate;
		try {
			x509 = new X509Certificate(der);
		} catch {
			break; // stop the chain at the first unparseable certificate
		}
		const certificate: any = {
			subject: parseNameString(x509.subject),
			issuer: parseNameString(x509.issuer),
			subjectaltname: x509.subjectAltName,
			valid_from: x509.validFrom,
			valid_to: x509.validTo,
			serialNumber: x509.serialNumber,
			fingerprint: x509.fingerprint,
			fingerprint256: x509.fingerprint256,
			fingerprint512: x509.fingerprint512,
			raw: der,
		};
		if (previous) previous.issuerCertificate = certificate;
		else leaf = certificate;
		previous = certificate;
		previousX509 = x509;
	}
	// Node marks a self-signed terminal cert by pointing issuerCertificate at itself.
	if (previous && previousX509 && previousX509.subject === previousX509.issuer) {
		previous.issuerCertificate = previous;
	}
	return leaf ?? {};
}

/**
 * Parse an X509Certificate subject/issuer string ("CN=x" lines, one RDN per
 * line) into the object shape of Node's legacy certificate objects; repeated
 * keys become arrays.
 */
function parseNameString(name: string): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = {};
	if (!name) return result;
	for (const line of name.split('\n')) {
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const key = line.slice(0, eq);
		const value = line.slice(eq + 1);
		const existing = result[key];
		if (existing === undefined) result[key] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else result[key] = [existing, value];
	}
	return result;
}
