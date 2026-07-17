/**
 * Tool composer for the built-in agent (#626).
 *
 * Two sources merge here: operator-only tools (FS, schedule, fetch, inspector)
 * that are private to this component, and RBAC-filtered tools drained from the
 * unified MCP tool registry (#615) for the agent's configured user — the
 * Operations profile (#617) today, adapted in `registryTools.ts`. Operator-only
 * tools win on a name collision: a private tool must never be shadowed by a
 * same-named registry tool, since the two have different runtime assumptions.
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
	/**
	 * V8 inspector (CDP) tools, built from runtime debug config (`buildInspectorTools`).
	 * Operator-only, like the FS/schedule/fetch tools.
	 */
	inspectorTools?: AgentTool[];
	/**
	 * RBAC-filtered registry tools for the agent's configured user (from
	 * `composeRegistryTools`). Shadowed by any operator-only tool of the same name.
	 */
	registryTools?: AgentTool[];
}

export interface ComposedToolset {
	tools: AgentTool[];
	scheduled: Map<string, ScheduledFollowup>;
}

export function composeToolset(opts: ComposeToolsetOpts): ComposedToolset {
	const schedule = buildScheduleTool(opts);
	// Operator-only tools first — they own their names. Registry tools that collide are dropped.
	const operator: AgentTool[] = [
		...fsTools,
		httpFetchTool,
		schedule.tool,
		...(opts.inspectorTools ?? []),
		...(opts.extraTools ?? []),
	];
	const operatorNames = new Set(operator.map((t) => t.def.name));
	const registry = (opts.registryTools ?? []).filter((t) => !operatorNames.has(t.def.name));
	const all = [...operator, ...registry];
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
