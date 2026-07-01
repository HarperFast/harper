/**
 * Opaque pagination cursors for MCP list methods (`tools/list`,
 * `resources/list`). Shared by the tool and resource registries so both
 * encode/decode cursors identically.
 *
 * A cursor is the base64url encoding of `{offset:N}`. Cursors are opaque to
 * clients per MCP §server/utilities/pagination — the client only echoes the
 * `nextCursor` it was handed. An unrecognized or malformed cursor decodes to
 * `null`; the transport maps that to a JSON-RPC `-32602 Invalid params` rather
 * than silently restarting from offset 0 (which can mask client paging bugs).
 */

// A real cursor is base64url of `{offset:N}` — a couple dozen chars. Reject
// anything wildly longer before allocating buffers / parsing, so a malicious
// client can't force large allocations through the cursor field.
const MAX_CURSOR_LENGTH = 512;

export function encodeCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor to its offset, or `null` if the cursor is malformed
 * (not valid base64url JSON), non-canonical, or carries an out-of-range offset
 * (non-integer, negative, or non-finite). Never throws.
 */
export function decodeCursor(cursor: string): number | null {
	if (cursor.length > MAX_CURSOR_LENGTH) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown };
		const offset = decoded?.offset;
		if (typeof offset !== 'number' || offset < 0 || !Number.isFinite(offset) || !Number.isInteger(offset)) {
			return null;
		}
		// Node's base64url decoder silently tolerates invalid/extra characters, so a
		// tampered cursor (e.g. `${validCursor}!`) would still decode and bypass the
		// `-32602` path. Require the input to be the exact canonical encoding of the
		// decoded offset, rejecting any junk/non-canonical form.
		if (encodeCursor(offset) !== cursor) return null;
		return offset;
	} catch {
		return null;
	}
}
