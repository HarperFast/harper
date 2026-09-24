import type { ToolResult } from '../toolRegistry.ts';

const OPEN_BRACE = 0x7b; /* { */
const OPEN_BRACKET = 0x5b; /* [ */

function serialize(data: unknown): string {
	// `JSON.stringify` returns undefined for a payload it cannot represent, and a content frame
	// without `text` is not a valid MCP result.
	return typeof data === 'string' ? data : (JSON.stringify(data ?? null) ?? 'null');
}

/** Whether the payload reaches the wire as a JSON array: `toJSON` can turn either into the other. */
export function serializesToArray(data: unknown): boolean {
	if (data === null || typeof data !== 'object') return false;
	const hasToJson = typeof (data as { toJSON?: unknown }).toJSON === 'function';
	if (!hasToJson) return Array.isArray(data);
	return serialize(data).charCodeAt(0) === OPEN_BRACKET;
}

/**
 * MCP requires `structuredContent` to be a JSON object and the reference client rejects the whole
 * call otherwise, so an array is wrapped and a non-object form omits the field, which is optional.
 */
function toStructuredContent(data: unknown, serialized: string): Record<string, unknown> | undefined {
	if (data === null || typeof data !== 'object') return undefined;
	switch (serialized.charCodeAt(0)) {
		case OPEN_BRACE:
			return data as Record<string, unknown>;
		case OPEN_BRACKET:
			return { results: data };
		default:
			return undefined;
	}
}

export function wrapToolResult(data: unknown): ToolResult {
	const text = serialize(data);
	const result: ToolResult = { content: [{ type: 'text', text }] };
	const structuredContent = toStructuredContent(data, text);
	if (structuredContent !== undefined) result.structuredContent = structuredContent;
	return result;
}
