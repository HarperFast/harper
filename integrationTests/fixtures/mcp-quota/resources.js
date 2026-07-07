// #1610 fixture: a cost-bearing custom tool plus the config-named durable
// quota policy. `allowMcpCall` increments a persisted per-identity counter and
// denies past DAILY_LIMIT — the reporter's public-docs `answer` tool shape.

const DAILY_LIMIT = 3;

export class McpQuota extends tables.QuotaCounter {
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

	static async allowMcpCall({ identity }) {
		const id = identity ?? 'unknown';
		const existing = await McpQuota.get(id);
		const used = (existing?.used ?? 0) + 1;
		await McpQuota.put({ id, used });
		if (used > DAILY_LIMIT) {
			return { allowed: false, message: 'daily quota reached', retryAfterSeconds: 3600 };
		}
		return true;
	}
}
