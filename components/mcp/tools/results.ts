import type { ToolResult } from '../toolRegistry.ts';

/**
 * MCP requires `structuredContent` to be a JSON object, and the reference client rejects the
 * whole call otherwise. Arrays are therefore wrapped; a value with no object form gets no
 * `structuredContent`, since the field is optional where a non-object is illegal. Decided on
 * the serialized form because that is what goes on the wire.
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
	// `JSON.stringify` yields undefined for a payload it cannot represent; a content frame
	// without `text` is not a valid MCP result.
	const text = typeof data === 'string' ? data : (JSON.stringify(data ?? null) ?? 'null');
	const result: ToolResult = { content: [{ type: 'text', text }] };
	const structuredContent = toStructuredContent(data, text);
	if (structuredContent !== undefined) result.structuredContent = structuredContent;
	return result;
}
