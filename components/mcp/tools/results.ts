import type { ToolResult } from '../toolRegistry.ts';

const OPEN_BRACE = 0x7b; /* { */
const OPEN_BRACKET = 0x5b; /* [ */

function serialize(data: unknown): string {
	// `JSON.stringify` yields undefined for a payload it cannot represent; a content frame
	// without `text` is not a valid MCP result.
	return typeof data === 'string' ? data : (JSON.stringify(data ?? null) ?? 'null');
}

/**
 * Whether a payload reaches the wire as a JSON array — the question callers must ask, since a
 * `toJSON` can turn an object into one and an array into something else. Only a value carrying
 * `toJSON` is serialized to decide, so the ordinary paths cost one `typeof`.
 */
export function serializesToArray(data: unknown): boolean {
	if (data === null || typeof data !== 'object') return false;
	const hasToJson = typeof (data as { toJSON?: unknown }).toJSON === 'function';
	if (!hasToJson) return Array.isArray(data);
	return serialize(data).charCodeAt(0) === OPEN_BRACKET;
}

/**
 * MCP requires `structuredContent` to be a JSON object, and the reference client rejects the
 * whole call otherwise. Arrays are therefore wrapped; a value with no object form gets no
 * `structuredContent`, since the field is optional where a non-object is illegal. Decided on
 * the serialized form because that is what goes on the wire.
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
