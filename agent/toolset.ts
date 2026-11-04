/**
 * Tool composer for the built-in agent (#626).
 *
 * Two sources merge here: operator-only tools (FS, schedule, fetch, inspector,
 * best-practice lookup) that are private to this component, and RBAC-filtered
 * tools drained from the unified MCP tool registry (#615) for the agent's
 * configured user — the Operations profile (#617) today, adapted in
 * `registryTools.ts`. Operator-only tools win on a name collision: a private
 * tool must never be shadowed by a same-named registry tool, since the two have
 * different runtime assumptions. Each operator group has a boot-time switch
 * (`agent.tools.*`, harper#3993); a group that is off is not composed, and its
 * names stay reserved. The schedule tool arrives built, like `http_fetch`.
 */

import { BEST_PRACTICE_TOOL_NAME } from './bestPractices.ts';
import { fsTools } from './tools/fsTools.ts';
import { HTTP_FETCH_TOOL_NAME } from './tools/httpFetchTool.ts';
import { INSPECTOR_TOOL_NAMES } from './tools/inspectorTool.ts';
import { SCHEDULE_TOOL_NAME, type ScheduledFollowup, type ScheduleTool } from './tools/scheduleTool.ts';
import type { AgentTool, AgentToolSwitches } from './types.ts';

export const ALL_TOOL_SWITCHES_ON: Readonly<AgentToolSwitches> = Object.freeze({
	filesystem: true,
	schedule: true,
	inspector: true,
	bestPractices: true,
});

export const OPERATOR_TOOL_NAMES: ReadonlySet<string> = new Set([
	...fsTools.map((tool) => tool.def.name),
	HTTP_FETCH_TOOL_NAME,
	SCHEDULE_TOOL_NAME,
	...Object.values(INSPECTOR_TOOL_NAMES),
	BEST_PRACTICE_TOOL_NAME,
]);

export interface ComposeToolsetOpts {
	/** When `false`, destructive tools are filtered out at composition time. */
	allowDestructive?: boolean;
	/** The boot-time `agent.tools` switches. Absent: every group is composed. */
	tools?: AgentToolSwitches;
	/** `schedule_followup`, built once by the caller (`buildScheduleTool`); absent when there is nothing to call back. */
	scheduleTool?: ScheduleTool;
	/** `http_fetch` built from the boot-time `agent.httpFetch` policy; absent when the policy disables it. */
	httpFetchTool?: AgentTool;
	/** `harper_best_practice`; absent when the skills package ships no rules. */
	bestPracticeTool?: AgentTool;
	/** Operator-injected extras (tests, custom plugins). One named after an operator-only tool is dropped. */
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
	const switches = opts.tools ?? ALL_TOOL_SWITCHES_ON;
	const schedule = switches.schedule ? opts.scheduleTool : undefined;
	// Operator-only tools own their names whether or not their group is composed, so disabling a
	// group never admits a same-named extra or registry tool in its place.
	const extras = (opts.extraTools ?? []).filter((tool) => !OPERATOR_TOOL_NAMES.has(tool.def.name));
	const operator: AgentTool[] = [
		...(switches.filesystem ? fsTools : []),
		...(opts.httpFetchTool ? [opts.httpFetchTool] : []),
		...(schedule ? [schedule.tool] : []),
		...(switches.inspector ? (opts.inspectorTools ?? []) : []),
		...(switches.bestPractices && opts.bestPracticeTool ? [opts.bestPracticeTool] : []),
		...extras,
	];
	const reservedNames = new Set([...OPERATOR_TOOL_NAMES, ...extras.map((tool) => tool.def.name)]);
	const registry = (opts.registryTools ?? []).filter((tool) => !reservedNames.has(tool.def.name));
	const all = [...operator, ...registry];
	const tools = opts.allowDestructive === false ? all.filter((tool) => !tool.destructive) : all;
	return { tools, scheduled: schedule?.pending ?? new Map() };
}

export function toolMapByName(tools: AgentTool[]): Map<string, AgentTool> {
	const map = new Map<string, AgentTool>();
	for (const tool of tools) {
		if (map.has(tool.def.name)) throw new Error(`Duplicate tool registered: ${tool.def.name}`);
		map.set(tool.def.name, tool);
	}
	return map;
}
