export const AGENT_OPERATION_INPUT_SCHEMAS: Record<string, object> = {
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
		properties: {
			enabled: { type: 'boolean' },
			provider: { type: 'string' },
			model: { type: 'string' },
			maxTurns: { type: 'integer', minimum: 1 },
			maxCostUsd: { type: 'number', minimum: 0 },
			autoApprove: { type: 'boolean' },
			allowDestructive: { type: 'boolean' },
			systemPromptAppend: { type: 'string' },
		},
	},
};
