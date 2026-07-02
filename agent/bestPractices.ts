/**
 * Harper best-practices knowledge for the built-in agent (#626).
 *
 * Sources the `harper-best-practices` skill from the `@harperfast/skills`
 * package (versioned with the release, no drift). Progressive disclosure,
 * mirroring how the skill is meant to be used:
 *   - the SKILL.md overview (rule index + when-to-use) is injected into the
 *     agent's system prompt so it always knows *which* practices exist;
 *   - the detailed `rules/<name>.md` bodies are pulled on demand via the
 *     `harper_best_practice` tool, so the agent only spends context on the
 *     guidance relevant to the task instead of carrying all ~20 rules.
 *
 * Everything degrades gracefully: if `@harperfast/skills` isn't resolvable the
 * overview is omitted and the tool isn't registered — the agent still runs.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AgentTool } from './types.ts';

// Rule file names are `[a-z0-9-].md`; this guards the tool arg against path traversal.
const RULE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Resolve the `harper-best-practices` directory inside the installed `@harperfast/skills`, or undefined. */
function bestPracticesDir(): string | undefined {
	try {
		// `@harperfast/skills` exports only `.` (dist/index.js), so resolve the package's main entry
		// and walk up to the package root; the `harper-best-practices/` assets sit alongside `dist/`.
		const root = resolve(dirname(require.resolve('@harperfast/skills')), '..');
		const dir = join(root, 'harper-best-practices');
		return existsSync(join(dir, 'SKILL.md')) ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** The SKILL.md overview (rule index + guidance), for injection into the system prompt. Undefined if unavailable. */
export function loadBestPracticesOverview(): string | undefined {
	const dir = bestPracticesDir();
	if (!dir) return undefined;
	try {
		return readFileSync(join(dir, 'SKILL.md'), 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * A tool that lists the best-practice rules (no arg) or returns one rule's full body (`rule` arg).
 * Returns undefined when the skill package isn't resolvable, so the caller simply omits it.
 */
export function buildBestPracticeTool(): AgentTool | undefined {
	const dir = bestPracticesDir();
	if (!dir) return undefined;
	const rulesDir = join(dir, 'rules');
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
			if (!rule) {
				const rules = readdirSync(rulesDir)
					.filter((f) => f.endsWith('.md'))
					.map((f) => f.replace(/\.md$/, ''))
					.sort();
				return { rules };
			}
			if (!RULE_NAME.test(rule))
				throw new Error(`Invalid rule name '${rule}' (expected e.g. "adding-tables-with-schemas")`);
			const file = join(rulesDir, `${rule}.md`);
			if (!existsSync(file))
				throw new Error(`No such best-practice rule: '${rule}'. Call with no rule to list available rules.`);
			return { rule, content: readFileSync(file, 'utf8') };
		},
	};
}
