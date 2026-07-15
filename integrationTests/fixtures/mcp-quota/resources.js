// #1610 / #1809 fixture: a cost-bearing custom MCP tool plus a durable quota
// policy registered as a FUNCTION (server.setMcpQuotaHandler). The policy is
// never an exposed Resource, and the counter it uses is an internal (non-@export)
// table, so no client can read or reset its own counter over any transport.
//
// NOTE: the get-then-put below is NOT race-safe — concurrent calls for one
// identity can interleave between the read and the write and undercount. Fine
// for this single-threaded test instance; production handlers must make the
// read-modify-write atomic (see the RACE-SAFETY note in components/mcp/quota.ts).

const DAILY_LIMIT = 3;

// The cost-bearing tool clients call (exported — this is the public surface).
export class Answerer extends Resource {
	static mcpTools = [
		{
			name: 'answer',
			description: 'Answer a question (cost-bearing)',
			method: 'doAnswer',
			inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
		},
	];

	async doAnswer(args) {
		return { answered: args?.q ?? '' };
	}
}

// Durable quota policy, registered as a function and backed by the internal
// QuotaCounter table — no config points at a Resource, and nothing is exposed.
server.setMcpQuotaHandler(async ({ identity }) => {
	const id = identity ?? 'unknown';
	const existing = await tables.QuotaCounter.get(id);
	const used = (existing?.used ?? 0) + 1;
	await tables.QuotaCounter.put({ id, used });
	if (used > DAILY_LIMIT) {
		return { allowed: false, message: 'daily quota reached', retryAfterSeconds: 3600 };
	}
	return true;
});
