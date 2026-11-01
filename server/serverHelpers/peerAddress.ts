const HEX_DIGITS = Buffer.from('0123456789abcdef');
const COLON = 0x3a;
const ipv6Text = Buffer.alloc(39);

/**
 * The text Node's `socket.remoteAddress` gives for a peer's raw address bytes (4 for IPv4, 16 for
 * IPv6), so `request.ip` reads the same on every transport. This is libuv's `inet_ntop`: dotted IPv4;
 * IPv6 in lowercase hex without leading zeros, with the first longest run of two or more zero groups
 * as `::`, and a dotted tail for IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`)
 * addresses. Node also appends `%<zone>` to a link-local address it has a scope id for; raw bytes
 * carry none. Any other length (a Unix socket has no address) is ''.
 */
export function formatPeerAddress(bytes: Uint8Array): string {
	if (bytes.length === 4) return dotted(bytes, 0);
	if (bytes.length !== 16) return '';
	let leadingZeros = 0;
	while (leadingZeros < 12 && bytes[leadingZeros] === 0) leadingZeros++;
	if (leadingZeros === 10 && bytes[10] === 0xff && bytes[11] === 0xff) return '::ffff:' + dotted(bytes, 12);
	if (leadingZeros === 12 && (bytes[12] || bytes[13])) return '::' + dotted(bytes, 12);

	let zerosStart = -1;
	let zerosLength = 1;
	for (let group = 0; group < 8;) {
		let end = group;
		while (end < 8 && bytes[end * 2] === 0 && bytes[end * 2 + 1] === 0) end++;
		if (end - group > zerosLength) {
			zerosStart = group;
			zerosLength = end - group;
		}
		group = end + 1;
	}
	let length = 0;
	for (let group = 0; group < 8; group++) {
		if (group === zerosStart) {
			ipv6Text[length++] = COLON;
			group += zerosLength - 1;
			if (group === 7) ipv6Text[length++] = COLON;
			continue;
		}
		if (group) ipv6Text[length++] = COLON;
		const high = bytes[group * 2];
		const low = bytes[group * 2 + 1];
		if (high >> 4) ipv6Text[length++] = HEX_DIGITS[high >> 4];
		if (high) ipv6Text[length++] = HEX_DIGITS[high & 15];
		if (high || low >> 4) ipv6Text[length++] = HEX_DIGITS[low >> 4];
		ipv6Text[length++] = HEX_DIGITS[low & 15];
	}
	return ipv6Text.toString('latin1', 0, length);
}

function dotted(bytes: Uint8Array, offset: number): string {
	return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

/**
 * Whether a peer address is one `authentication.authorizeLocal` trusts: `127.0.0.x`, its IPv4-mapped
 * form, or `::1`. Exact forms, not a substring: an IPv4-compatible `::127.0.0.1` is not loopback.
 */
export function isLocalPeerAddress(address: string | undefined): boolean {
	if (!address) return false;
	return address === '::1' || address.startsWith('127.0.0.') || address.startsWith('::ffff:127.0.0.');
}
