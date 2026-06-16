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

export function encodeCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor to its offset, or `null` if the cursor is malformed
 * (not valid base64url JSON) or carries an out-of-range offset (non-integer,
 * negative, or non-finite). Never throws.
 */
export function decodeCursor(cursor: string): number | null {
	try {
		const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown };
		const offset = decoded?.offset;
		if (typeof offset !== 'number' || offset < 0 || !Number.isFinite(offset) || !Number.isInteger(offset)) {
			return null;
		}
		return offset;
	} catch {
		return null;
	}
}
