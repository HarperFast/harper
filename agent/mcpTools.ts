/**
 * Expose the built-in agent over MCP (#626).
 *
 * The generic MCP operations profile (#617) can surface these ops too, but only
 * when an operator opts them into `mcp.operations.allow` and with generic,
 * schema-inferred descriptions. We register a *curated* agent tool set directly
 * into the registry instead: exposed by default (no allow-list entry needed),
 * with hand-written descriptions and annotations tuned for driving the agent.
 *
 * Each tool dispatches through the SAME path the generic operations profile uses
 * (`makeOperationToolHandler` → `chooseOperation` + `processLocalTransaction`), so
 * Harper's `verifyPerms` runs at call time and enforces the `requiresSuperUser: true`
 * declared on each agent op — plus any scoped `operations: ['agent_*']` delegation
 * role. Listing mirrors that boundary via `canRoleInvokeOperation`. A direct
 * `op.execute(body)` call is NOT used: it would bypass `verifyPerms` entirely and
 * let any authenticated MCP user drive the super_user agent.
 */

import { addTool, canRoleInvokeOperation, type AuthedUser } from '../components/mcp/toolRegistry.ts';
import { makeOperationToolHandler } from '../components/mcp/tools/operations.ts';
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
	const registered = new Set(operations.map((op) => op.name));
	let count = 0;
	for (const [name, meta] of Object.entries(AGENT_MCP_TOOLS)) {
		if (!registered.has(name)) continue; // op not registered (shouldn't happen) — skip rather than expose a dead tool
		const annotations = meta.destructive ? { destructiveHint: true } : meta.readOnly ? { readOnlyHint: true } : {};
		addTool({
			name,
			description: meta.description,
			inputSchema: meta.inputSchema,
			profile: 'operations',
			...(Object.keys(annotations).length > 0 ? { annotations } : {}),
			// List only for users the op's role-level policy would let call it (super_user, or a
			// scoped `operations: ['agent_*']` delegation role). verifyPerms enforces the same at
			// call time inside makeOperationToolHandler — this predicate keeps hidden tools out of
			// the listing, not out of reach.
			visibleTo: (user: AuthedUser) => canRoleInvokeOperation(user, name),
			// Route through the standard operation dispatch (chooseOperation + processLocalTransaction),
			// so verifyPerms runs and the op's requiresSuperUser gate is actually enforced — a direct
			// op.execute() would skip it. Same handler the generic operations profile uses.
			handler: makeOperationToolHandler(name),
		});
		count++;
	}
	log.info?.(`Agent MCP tools registered: ${count}`);
}
