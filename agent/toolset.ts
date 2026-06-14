/**
 * Tool composer for the built-in agent (#626).
 *
 * Operator-only tools (FS, schedule, fetch) are inline today. Once the
 * unified MCP tool registry (#615) lands with the Operations (#617) and
 * Application (#618) profiles, this is the seam where RBAC-filtered
 * registry tools get folded in for the agent's configured user. The shape
 * of {@link composeToolset} won't change — only the body gains a registry
 * lookup.
 */

import { fsTools } from './tools/fsTools.ts';
import { httpFetchTool } from './tools/httpFetchTool.ts';
import { buildScheduleTool, type ScheduleToolDeps, type ScheduledFollowup } from './tools/scheduleTool.ts';
import type { AgentTool } from './types.ts';

export interface ComposeToolsetOpts extends ScheduleToolDeps {
	/** When `false`, destructive tools are filtered out at composition time. */
	allowDestructive?: boolean;
	/** Operator-injected extras (tests, custom plugins). */
	extraTools?: AgentTool[];
}

export interface ComposedToolset {
	tools: AgentTool[];
	scheduled: Map<string, ScheduledFollowup>;
}

export function composeToolset(opts: ComposeToolsetOpts): ComposedToolset {
	const schedule = buildScheduleTool(opts);
	const all: AgentTool[] = [...fsTools, httpFetchTool, schedule.tool, ...(opts.extraTools ?? [])];
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
