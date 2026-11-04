export const AGENT_OPERATION_INPUT_SCHEMAS = {
	agent_prompt: {
		type: 'object',
		properties: {
			message: { type: 'string', description: 'The instruction/prompt for the agent.' },
			session_id: { type: 'string', description: 'Optional existing session id to continue the conversation.' },
		},
		required: ['message'],
	},
	get_agent_session: {
		type: 'object',
		properties: { session_id: { type: 'string' } },
		required: ['session_id'],
	},
	list_agent_sessions: {
		type: 'object',
		properties: { limit: { type: 'integer', minimum: 1, description: 'Max sessions to return (default 100).' } },
	},
	approve_agent_action: {
		type: 'object',
		properties: {
			session_id: { type: 'string' },
			approval_id: { type: 'string' },
			approved: { type: 'boolean', description: 'true to approve (default), false to deny.' },
		},
		required: ['session_id', 'approval_id'],
	},
	cancel_agent_run: {
		type: 'object',
		properties: { session_id: { type: 'string' } },
		required: ['session_id'],
	},
	set_agent_config: {
		type: 'object',
		not: { anyOf: [{ required: ['httpFetch'] }, { required: ['componentsScope'] }, { required: ['configScope'] }] },
		properties: {
			enabled: { type: 'boolean' },
			provider: { type: 'string' },
			model: { type: 'string' },
			maxTurns: { type: 'integer', minimum: 1 },
			maxCostUsd: { type: ['number', 'null'], minimum: 0 },
			maxSessionTokens: { type: ['integer', 'null'], minimum: 1 },
			maxTokens: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
			maxToolResultBytes: { type: 'integer', minimum: 1024, maximum: 1_048_576 },
			autoApprove: { type: 'boolean' },
			allowDestructive: { type: 'boolean' },
			systemPromptAppend: { type: 'string' },
		},
	},
} as const satisfies Record<string, object>;
