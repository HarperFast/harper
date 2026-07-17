/**
 * Harper best-practices knowledge for the built-in agent (#626).
 *
 * Sources the `harper-best-practices` skill from the `@harperfast/skills`
 * package (versioned with the release, no drift). The package exposes the skill
 * content directly as module exports — `skillSummary` (the SKILL.md overview),
 * `ruleNames` (the rule index), and `rules` (name → markdown body) — so we read
 * from those rather than groveling around the installed package on disk.
 *
 * Progressive disclosure, mirroring how the skill is meant to be used:
 *   - the SKILL.md overview (rule index + when-to-use) is injected into the
 *     agent's system prompt so it always knows *which* practices exist;
 *   - the detailed rule bodies are pulled on demand via the
 *     `harper_best_practice` tool, so the agent only spends context on the
 *     guidance relevant to the task instead of carrying all ~20 rules.
 */

import { ruleNames, rules, skillSummary } from '@harperfast/skills';
import type { AgentTool } from './types.ts';

/** The SKILL.md overview (rule index + guidance), for injection into the system prompt. Undefined if unavailable. */
export function loadBestPracticesOverview(): string | undefined {
	return skillSummary || undefined;
}

/**
 * A tool that lists the best-practice rules (no arg) or returns one rule's full body (`rule` arg).
 * Returns undefined when the skill package ships no rules, so the caller simply omits it.
 */
export function buildBestPracticeTool(): AgentTool | undefined {
	if (!ruleNames?.length) return undefined;
	return {
		def: {
			name: 'harper_best_practice',
			description:
				'Read a Harper best-practices rule for detailed guidance and code examples — schema design, relationships, automatic/REST APIs, authentication, custom resources, caching, vector indexing, TypeScript type-stripping, deployment, logging, and more. Call with no `rule` to list the available rule names; then call again with a `rule` to read it. Consult these before designing schemas or building app logic.',
			parameters: {
				type: 'object',
				properties: {
					rule: {
						type: 'string',
						description: 'Rule name without extension, e.g. "adding-tables-with-schemas". Omit to list all rules.',
					},
				},
			},
		},
		handler: async (args: any) => {
			const rule = args?.rule ? String(args.rule).trim() : '';
			if (!rule) return { rules: [...ruleNames] };
			// A plain map lookup — an unknown or malformed name simply misses, so there's no
			// path-traversal surface to guard against.
			const content = (rules as Record<string, string>)[rule];
			if (content == null)
				throw new Error(`No such best-practice rule: '${rule}'. Call with no rule to list available rules.`);
			return { rule, content };
		},
	};
}
