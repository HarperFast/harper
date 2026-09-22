/**
 * Shared `tools/call` result framing for the operations and application
 * profiles. Both surfaces used to build this inline and had the same defect,
 * so the framing lives here once.
 */
import type { ToolResult } from '../toolRegistry.ts';

/**
 * Key used to wrap an array payload so it can travel in `structuredContent`.
 * Deliberately generic: the operations profile returns arrays of rows
 * (`sql` SELECT, `search_by_value`), of users, of roles, and of jobs, and no
 * narrower noun fits all of them. Distinct from the application profile's
 * `search_*` envelope (`{ rows, nextCursor }`), which is a paginated contract
 * with a cursor rather than a pass-through of the handler's payload.
 */
const ARRAY_RESULT_KEY = 'results';

/**
 * MCP types `structuredContent` as a JSON **object**. The reference client
 * validates it with `z.record(z.string(), z.unknown())` inside `Client.callTool`,
 * so a non-object value fails the whole call with a Zod `invalid_type` error
 * before the result is ever returned to the caller — the tool becomes unusable
 * from any spec-compliant host even though the response is otherwise fine.
 *
 * Harper handlers routinely resolve to arrays: `sql` for a SELECT,
 * `search_by_value` / `search_by_conditions` / `search_by_hash`, `list_users`,
 * `list_roles`, `get_job`, `search_jobs_by_start_date`, and any custom Resource
 * method that returns a list. Those are wrapped in `{ results }` so the field
 * stays spec-legal. Nothing is lost: the text content frame still carries the
 * handler's payload verbatim, unwrapped.
 *
 * A value that does not serialize to a JSON object at all — a scalar, or an
 * object whose `toJSON` yields one (a bare `Date`) — gets **no**
 * `structuredContent`. The field is optional, so omitting it is the spec-legal
 * way to say "no structured view of this result"; emitting a non-object instead
 * fails the call outright. The decision is made on the serialized form rather
 * than on `typeof`, because that is what actually goes on the wire.
 */
function toStructuredContent(data: unknown, serialized: string): Record<string, unknown> | undefined {
	if (data === null || typeof data !== 'object') return undefined;
	switch (serialized.charCodeAt(0)) {
		case 0x7b /* { */:
			// Serializes to a JSON object, which is exactly the record contract.
			return data as Record<string, unknown>;
		case 0x5b /* [ */:
			return { [ARRAY_RESULT_KEY]: data };
		default:
			// `toJSON` reduced the object to a scalar (Date, or an author's custom
			// serializer). There is no record to advertise, so advertise none.
			return undefined;
	}
}

/**
 * Build the MCP `tools/call` result for a handler's resolved value: the payload
 * as a text content frame, plus `structuredContent` when the payload has a
 * spec-legal object form (see `toStructuredContent`).
 */
export function wrapToolResult(data: unknown): ToolResult {
	// `JSON.stringify` returns `undefined` (the value, not the string) for a payload it
	// cannot represent — an object whose `toJSON` yields `undefined`. A content frame
	// with a missing `text` is not a valid MCP result, so fall back to `'null'`.
	const text = typeof data === 'string' ? data : (JSON.stringify(data ?? null) ?? 'null');
	const result: ToolResult = { content: [{ type: 'text', text }] };
	const structuredContent = toStructuredContent(data, text);
	if (structuredContent !== undefined) result.structuredContent = structuredContent;
	return result;
}
