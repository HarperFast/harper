/**
 * Expose the built-in agent over MCP (#626).
 *
 * The generic MCP operations profile (#617) walks `OPERATION_FUNCTION_MAP` once,
 * before this component registers its operations — so the agent ops never land
 * on the MCP surface via `mcp.operations.allow` alone (they're added to the map
 * too late for the walk). We therefore register a *curated* agent tool set
 * directly into the registry after the ops exist: guaranteed exposure, proper
 * schemas/descriptions, and independent of walk timing or the allow-list.
 *
 * Each tool dispatches straight to the agent operation's `execute`, with the MCP
 * caller's identity as `hdb_user` — so the operation's own super_user check and
 * any downstream RBAC still apply. Listing is restricted to super_users.
 */

import { addTool, isSuperUser, type AuthedUser, type ToolResult } from '../components/mcp/toolRegistry.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import type { OperationDefinition } from '../server/serverHelpers/serverUtilities.ts';

const log = harperLogger.loggerWithTag('agent');

interface AgentMcpToolMeta {
	description: string;
	inputSchema: object;
	destructive?: boolean;
	readOnly?: boolean;
}

// Curated client-facing surface for driving the agent. `set_agent_config` is intentionally excluded
// — it's an operator/config action, not something an MCP client should reach.
const AGENT_MCP_TOOLS: Record<string, AgentMcpToolMeta> = {
	agent_prompt: {
		description:
			'Send a prompt to the built-in Harper agent. Starts a new session, or continues one when session_id is given. Returns { session_id, status }; poll get_agent_session for the transcript and result.',
		inputSchema: {
			type: 'object',
			properties: {
				message: { type: 'string', description: 'The instruction/prompt for the agent.' },
				session_id: { type: 'string', description: 'Optional existing session id to continue the conversation.' },
			},
			required: ['message'],
		},
		destructive: true, // the agent may take actions in response
	},
	get_agent_session: {
		description:
			'Read a built-in-agent session: its status, full transcript (messages, tool calls and results), and any pending approvals.',
		inputSchema: {
			type: 'object',
			properties: { session_id: { type: 'string' } },
			required: ['session_id'],
		},
		readOnly: true,
	},
	list_agent_sessions: {
		description: 'List built-in-agent sessions, most recent first.',
		inputSchema: {
			type: 'object',
			properties: { limit: { type: 'integer', minimum: 1, description: 'Max sessions to return (default 100).' } },
		},
		readOnly: true,
	},
	approve_agent_action: {
		description:
			'Approve or deny a pending agent tool call (when autoApprove is off), then resume the run. Get the approval_id from get_agent_session.pendingApprovals.',
		inputSchema: {
			type: 'object',
			properties: {
				session_id: { type: 'string' },
				approval_id: { type: 'string' },
				approved: { type: 'boolean', description: 'true to approve (default), false to deny.' },
			},
			required: ['session_id', 'approval_id'],
		},
		destructive: true,
	},
	cancel_agent_run: {
		description: 'Cancel an in-progress agent run for a session.',
		inputSchema: {
			type: 'object',
			properties: { session_id: { type: 'string' } },
			required: ['session_id'],
		},
		destructive: true,
	},
};

/**
 * Register the curated agent tools into the MCP registry (operations profile). Call after the agent
 * operations are registered. Safe to call whether or not the MCP HTTP surface is enabled — the tools
 * simply sit in the registry until an MCP client lists them.
 */
export function registerAgentMcpTools(operations: OperationDefinition[]): void {
	const byName = new Map(operations.map((op) => [op.name, op]));
	let count = 0;
	for (const [name, meta] of Object.entries(AGENT_MCP_TOOLS)) {
		const op = byName.get(name);
		if (!op) continue; // op not registered (shouldn't happen) — skip rather than expose a dead tool
		const annotations = meta.destructive ? { destructiveHint: true } : meta.readOnly ? { readOnlyHint: true } : {};
		addTool({
			name,
			description: meta.description,
			inputSchema: meta.inputSchema,
			profile: 'operations',
			...(Object.keys(annotations).length > 0 ? { annotations } : {}),
			// Listing is restricted to super_users; the operation's own super_user check enforces at call time.
			visibleTo: (user: AuthedUser) => isSuperUser(user),
			handler: async (args: unknown, context: { user: AuthedUser }): Promise<ToolResult> => {
				try {
					const body = {
						...(args && typeof args === 'object' ? (args as Record<string, unknown>) : {}),
						operation: name,
						hdb_user: context.user,
					};
					const data = await op.execute(body);
					const result: ToolResult = {
						content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data ?? null) }],
					};
					if (data !== null && typeof data === 'object') result.structuredContent = data as object;
					return result;
				} catch (err) {
					const e = err as { message?: string; http_resp_msg?: string };
					return {
						isError: true,
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									error: e?.http_resp_msg ?? e?.message ?? (err ? String(err) : `agent op '${name}' failed`),
								}),
							},
						],
					};
				}
			},
		});
		count++;
	}
	log.info?.(`Agent MCP tools registered: ${count}`);
}
