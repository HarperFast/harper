/** Shared `tools/call` result framing for the operations and application profiles. */
import type { ToolResult } from '../toolRegistry.ts';

/**
 * MCP types `structuredContent` as a JSON object and the reference client enforces it
 * (`z.record(z.string(), z.unknown())`), failing the whole call on anything else. Harper
 * handlers routinely resolve to arrays (`sql` SELECT, `search_by_*`, `list_users`,
 * `list_roles`, `get_job`), so those are wrapped; the text frame keeps the payload verbatim.
 *
 * A value with no object form — a scalar, or an object whose `toJSON` yields one — gets no
 * `structuredContent`: the field is optional, so omitting it is legal where a non-object is
 * not. Decided on the serialized form because that is what goes on the wire.
 */
function toStructuredContent(data: unknown, serialized: string): Record<string, unknown> | undefined {
	if (data === null || typeof data !== 'object') return undefined;
	switch (serialized.charCodeAt(0)) {
		case 0x7b /* { */:
			return data as Record<string, unknown>;
		case 0x5b /* [ */:
			return { results: data };
		default:
			return undefined;
	}
}

export function wrapToolResult(data: unknown): ToolResult {
	// `JSON.stringify` returns undefined for a payload it cannot represent (a `toJSON` yielding
	// undefined); a content frame without `text` is not a valid MCP result.
	const text = typeof data === 'string' ? data : (JSON.stringify(data ?? null) ?? 'null');
	const result: ToolResult = { content: [{ type: 'text', text }] };
	const structuredContent = toStructuredContent(data, text);
	if (structuredContent !== undefined) result.structuredContent = structuredContent;
	return result;
}
