/**
 * Tool composer for the built-in agent (#626).
 *
 * Two sources, composed per the design:
 *  1. Operator-only tools (FS, schedule, fetch) — inline here, NOT in the MCP
 *     registry (their runtime assumptions only hold on the main thread).
 *  2. RBAC-filtered tools from the unified MCP registry (#615/#781 + Operations
 *     profile #617), passed in by `agent.ts` already filtered for the agent's
 *     configured user. See `registryTools.ts`.
 *
 * Operator-only tools win on a name collision — they are the curated,
 * main-thread-safe surface and must not be shadowed by a same-named registry
 * tool.
 */

import { fsTools } from './tools/fsTools.ts';
import { httpFetchTool } from './tools/httpFetchTool.ts';
import { buildScheduleTool, type ScheduleToolDeps, type ScheduledFollowup } from './tools/scheduleTool.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import type { AgentTool } from './types.ts';

const log = harperLogger.loggerWithTag('agent');

export interface ComposeToolsetOpts extends ScheduleToolDeps {
	/** When `false`, destructive tools are filtered out at composition time. */
	allowDestructive?: boolean;
	/** Operator-injected extras (tests, custom plugins). */
	extraTools?: AgentTool[];
	/** RBAC-filtered tools from the MCP registry (Operations profile), pre-filtered for the agent user. */
	registryTools?: AgentTool[];
}

export interface ComposedToolset {
	tools: AgentTool[];
	scheduled: Map<string, ScheduledFollowup>;
}

export function composeToolset(opts: ComposeToolsetOpts): ComposedToolset {
	const schedule = buildScheduleTool(opts);
	// Operator-only first so they take precedence on name collisions.
	const operatorOnly: AgentTool[] = [...fsTools, httpFetchTool, schedule.tool, ...(opts.extraTools ?? [])];
	const operatorNames = new Set(operatorOnly.map((t) => t.def.name));
	const registry = (opts.registryTools ?? []).filter((t) => {
		if (operatorNames.has(t.def.name)) {
			log.trace?.(`Agent: registry tool '${t.def.name}' shadowed by operator-only tool of the same name; skipping`);
			return false;
		}
		return true;
	});
	const all: AgentTool[] = [...operatorOnly, ...registry];
	const tools = opts.allowDestructive === false ? all.filter((t) => !t.destructive) : all;
	return { tools, scheduled: schedule.pending };
}

export function toolMapByName(tools: AgentTool[]): Map<string, AgentTool> {
	const map = new Map<string, AgentTool>();
	for (const tool of tools) {
		if (map.has(tool.def.name)) throw new Error(`Duplicate tool registered: ${tool.def.name}`);
		map.set(tool.def.name, tool);
	}
	return map;
}
