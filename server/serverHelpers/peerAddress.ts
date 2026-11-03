const HEX_DIGITS = Buffer.from('0123456789abcdef');
const COLON = 0x3a;
const ipv6Text = Buffer.alloc(39);

/**
 * Peer address bytes (4 or 16) as Node's `socket.remoteAddress` writes them, which is libuv's
 * `inet_ntop`; '' for any other length. Node also appends `%<zone>` to a link-local address it has a
 * scope id for, and raw bytes carry none.
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
 * The loopback peers `authentication.authorizeLocal` trusts. Anchored at the start, never a substring
 * match: IPv4-compatible `::127.0.0.1` is not loopback.
 */
export function isLocalPeerAddress(address: string | undefined): boolean {
	if (!address) return false;
	return address === '::1' || address.startsWith('127.0.0.') || address.startsWith('::ffff:127.0.0.');
}
