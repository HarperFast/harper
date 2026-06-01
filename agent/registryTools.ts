/**
 * Bridges the unified MCP tool registry (#615/#781, Operations profile #617)
 * into the built-in agent's toolset.
 *
 * The agent consumes the SAME registry the MCP server exposes, RBAC-filtered
 * for the agent's configured user — so an operator who points `agent.user` at
 * a restricted role automatically gets a narrowed tool surface, with no
 * per-tool wiring here. Operator-only tools (FS, schedule, fetch) stay inline
 * in `toolset.ts`; they are intentionally NOT in the registry.
 *
 * Scope (v1): the **Operations** profile only. Those tools are registered on
 * the main thread (where the agent runs) by `registerOperationsTools()`, which
 * is idempotent — so the agent populates them itself rather than depending on
 * the operator having enabled the `mcp:` HTTP surface. The **Application**
 * profile (#618, per-Resource tools) is populated from the worker-thread
 * Resources registry and is a follow-up.
 */

import harperLogger from '../utility/logging/harper_logger.ts';
import { getTool, listTools, type AuthedUser, type ToolResult } from '../components/mcp/toolRegistry.ts';
import { registerOperationsTools } from '../components/mcp/tools/operations.ts';
import type { AgentTool, AgentToolContext } from './types.ts';

const log = harperLogger.loggerWithTag('agent');
const REGISTRY_PAGE_SIZE = 200;

/**
 * Ensure the Operations-profile tools exist in the registry. Idempotent
 * (`addTool` is `Map.set`-backed), so it's safe whether or not the MCP
 * component already registered them. Failures are logged, not thrown — a
 * registry hiccup must not stop the agent from starting with its inline tools.
 */
export function ensureOperationsToolsRegistered(): void {
	try {
		registerOperationsTools();
	} catch (err) {
		log.warn?.(`Agent: failed to populate operations tools in MCP registry: ${(err as Error)?.message ?? err}`);
	}
}

/**
 * Build {@link AgentTool}s from the registry's Operations profile, filtered to
 * what `agentUser` may invoke. Pagination is drained fully — the agent wants
 * every visible tool, not a page.
 */
export function composeRegistryTools(agentUser: AuthedUser, sessionId: string): AgentTool[] {
	const tools: AgentTool[] = [];
	let cursor: string | undefined;
	do {
		const page = listTools({ user: agentUser, profile: 'operations', sessionId, cursor, limit: REGISTRY_PAGE_SIZE });
		for (const descriptor of page.tools) {
			tools.push(
				adaptRegistryTool(
					descriptor.name,
					descriptor.description,
					descriptor.inputSchema,
					agentUser,
					descriptor.annotations?.destructiveHint === true
				)
			);
		}
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}

function adaptRegistryTool(
	name: string,
	description: string,
	inputSchema: object,
	agentUser: AuthedUser,
	destructive: boolean
): AgentTool {
	return {
		def: { name, description, parameters: inputSchema },
		destructive,
		handler: async (args: object, ctx: AgentToolContext) => {
			const tool = getTool(name);
			if (!tool) throw new Error(`registry tool '${name}' no longer registered`);
			const result: ToolResult = await tool.handler(args ?? {}, {
				user: agentUser,
				profile: 'operations',
				sessionId: ctx.sessionId,
			});
			if (result.isError) {
				// Surface the registry tool's error text to the loop, which records it as a structured
				// failure observation (the model can then adjust) rather than aborting the run.
				const text = result.content?.find((c) => c.type === 'text')?.text ?? `tool '${name}' failed`;
				throw new Error(text);
			}
			// Prefer the structured payload; fall back to concatenated text content.
			if (result.structuredContent !== undefined) return result.structuredContent;
			return result.content?.map((c) => c.text ?? '').join('') ?? '';
		},
	};
}
