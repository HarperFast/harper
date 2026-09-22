// A close frame's payload is at most 125 bytes, two of which are the status code, and `ws` throws a
// RangeError past that (node_modules/ws/lib/sender.js). Both close sites below are reached from a
// rejection handler, where such a throw would surface as an unhandled rejection rather than a failed
// close, so a message Harper does not control — a `server.getUser` override's, for instance — must be
// bounded before it gets there.
const MAX_CLOSE_REASON_BYTES = 123;

/** Bounds `text` to what a close frame accepts, truncating on a code-point boundary. */
export function toCloseReason(text: string | undefined): string {
	const reason = text ?? '';
	// a UTF-16 code unit never encodes to fewer than one byte, so an over-long string is over the byte
	// limit too — testing that first keeps an unbounded message off byteLength's whole-string scan
	if (reason.length <= MAX_CLOSE_REASON_BYTES && Buffer.byteLength(reason, 'utf8') <= MAX_CLOSE_REASON_BYTES)
		return reason;
	let bytes = 0;
	let end = 0;
	// iterating the string yields whole code points, so a surrogate pair is never split
	for (const character of reason) {
		const size = Buffer.byteLength(character, 'utf8');
		if (bytes + size > MAX_CLOSE_REASON_BYTES) break;
		bytes += size;
		end += character.length;
	}
	return reason.slice(0, end);
}
