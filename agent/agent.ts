/**
 * Built-in Harper Agent component (#626).
 *
 * `startOnMainThread` is invoked once on the main thread by `componentLoader`.
 * When `agent.enabled` is `false` (default) the component registers nothing
 * and returns immediately — opt-in keeps surprise LLM costs at bay. When
 * enabled, the six operations land on the operations API, the session table
 * is realized lazily on first use, and the loop runs in-process.
 *
 * The component intentionally avoids `handleApplication`: it has nothing
 * worker-thread-shaped to do. Two tool sources compose: operator-only tools
 * (FS, schedule, fetch, and the V8 inspector) that are inline, and RBAC-filtered
 * registry tools (#615/#617) drained for the agent's configured user via
 * `registryTools.ts`.
 */

import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import * as env from '../utility/environment/environmentManager.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import { Models } from '../resources/models/Models.ts';
import type { AuthedUser } from '../components/mcp/toolRegistry.ts';
import { workers } from '../server/threads/manageThreads.js';
import { composeToolset } from './toolset.ts';
import { buildInspectorTools } from './tools/inspectorTool.ts';
import { buildBestPracticeTool, loadBestPracticesOverview } from './bestPractices.ts';
import { composeRegistryTools, ensureOperationsToolsRegistered } from './registryTools.ts';
import { buildOperations } from './operations.ts';
import { registerAgentMcpTools } from './mcpTools.ts';
import { runAgent, _resetInFlightForTests } from './loop.ts';
import { appendMessage, getSession } from './session.ts';
import type { AgentConfig, AgentScopes, AgentTool } from './types.ts';

const log = harperLogger.loggerWithTag('agent');

const DEFAULT_CONFIG: AgentConfig = {
	enabled: false,
	maxTurns: 50,
	maxCostUsd: 5,
	autoApprove: false,
	allowDestructive: false,
	user: 'hdb_agent',
};

interface StartOpts {
	server: {
		registerOperation: (def: { name: string; execute: (op: any) => any | Promise<any> }) => void;
		/** Resolve a Harper user (with role/permissions) by username. Password/request unused here. */
		getUser?: (username: string, password: string | null, request: unknown) => Promise<AuthedUser> | AuthedUser;
	};
	// Component-level config plumbed by componentLoader (`...componentConfig`).
	enabled?: boolean;
	provider?: string;
	model?: string;
	maxTurns?: number;
	maxCostUsd?: number;
	autoApprove?: boolean;
	allowDestructive?: boolean;
	user?: string;
	componentsScope?: string;
	systemPromptAppend?: string;
}

export async function startOnMainThread(opts: StartOpts): Promise<void> {
	const config = mergeConfig(opts);
	if (!config.enabled) {
		log.info?.('Agent component disabled (agent.enabled=false); skipping registration');
		return;
	}

	// Lazily imported to avoid pulling configUtils at module-eval time for tests.
	const { getConfigPath, getConfigFilePath } = await import('../config/configUtils.ts');
	const scopes = resolveScopes(config, getConfigPath, getConfigFilePath);

	const models = new Models();
	const abortControllers = new Map<string, AbortController>();
	let liveConfig: AgentConfig = config;

	// Populate the Operations MCP profile on the main thread. `agentIdentity` resolves the enforcement
	// identity fresh on each call (so a live role change is honored, and an unresolvable non-default
	// user fails closed); the startup snapshot below is only for `visibleTo` listing.
	ensureOperationsToolsRegistered();
	const agentIdentity = () => resolveAgentIdentity(opts.server, liveConfig.user);
	let registryTools = await composeRegistryToolsForListing(agentIdentity);

	// Operator-only V8 inspector tools. Debug config is read once here — enabling threads_debug opens the
	// worker inspector ports at thread boot, so it can't be toggled without a restart anyway. Worker
	// count is a live closure over the pool, so attaches range-check against the current worker set.
	const inspectorTools = buildInspectorTools({
		debugEnabled: env.get(CONFIG_PARAMS.THREADS_DEBUG) !== false,
		startingPort: (env.get(CONFIG_PARAMS.THREADS_DEBUG_STARTINGPORT) as number | undefined) ?? undefined,
		host: (env.get(CONFIG_PARAMS.THREADS_DEBUG_HOST) as string | undefined) ?? '127.0.0.1',
		getWorkerCount: () => workers.length,
	});

	// Harper best-practices skill (@harperfast/skills): the SKILL.md overview goes in the system prompt;
	// the `harper_best_practice` tool serves the detailed rules on demand. Both degrade to nothing if the
	// package isn't resolvable, so the agent still runs without it.
	const bestPracticesOverview = loadBestPracticesOverview();
	const bestPracticeTool = buildBestPracticeTool();
	const extraTools: AgentTool[] = bestPracticeTool ? [bestPracticeTool] : [];

	function compose(): ReturnType<typeof composeToolset> {
		return composeToolset({
			allowDestructive: liveConfig.allowDestructive,
			onFollowup: handleFollowup,
			inspectorTools,
			registryTools,
			extraTools,
		});
	}

	let composed = compose();

	// Build the listing snapshot best-effort: if the configured user can't be resolved (and isn't the
	// default bootstrap user), `agentIdentity` fails closed — the agent then runs with only its
	// operator-only tools until the operator fixes `agent.user`. Never falls back to an escalated list.
	async function composeRegistryToolsForListing(resolveIdentity: () => Promise<AuthedUser>): Promise<AgentTool[]> {
		try {
			const listingUser = await resolveIdentity();
			return composeRegistryTools(listingUser, resolveIdentity);
		} catch (err) {
			log.error?.(
				`Registry tools disabled — agent.user='${liveConfig.user}' could not be resolved: ${err instanceof Error ? err.message : String(err)}`
			);
			return [];
		}
	}

	// Only warn when the operator explicitly configured `maxCostUsd`. Logging on the default
	// every boot would flood the log without telling anyone anything actionable.
	if (opts.maxCostUsd !== undefined) {
		log.warn?.(
			`agent.maxCostUsd=${liveConfig.maxCostUsd} is advertised but not yet enforced; cost-cap wiring depends on #612 telemetry.`
		);
	}

	async function handleFollowup(sessionId: string, prompt: string): Promise<void> {
		const session = await getSession(sessionId);
		if (!session) {
			log.warn?.(`schedule_followup target session ${sessionId} not found`);
			return;
		}
		await appendMessage(sessionId, { role: 'user', content: prompt, createdAt: Date.now() });
		startRun(sessionId);
	}

	function currentTools(): AgentTool[] {
		return composed.tools;
	}

	function startRun(sessionId: string): void {
		// A run is already active for this session. `runAgent` coalesces concurrent starts onto the
		// existing in-flight promise (bound to the existing controller), so creating a second
		// controller here would orphan it — `cancelRun` would then abort a controller nothing is
		// listening to, leaving the live run uncancellable. Any message appended before this call
		// (e.g. by a scheduled followup) is picked up by the in-flight loop on its next turn.
		if (abortControllers.has(sessionId)) return;
		const controller = new AbortController();
		abortControllers.set(sessionId, controller);
		runAgent({
			sessionId,
			models,
			tools: currentTools(),
			scopes,
			maxTurns: liveConfig.maxTurns,
			autoApprove: liveConfig.autoApprove,
			signal: controller.signal,
			generateOpts: { model: liveConfig.model },
			systemPrompt: buildSystemPrompt(scopes, bestPracticesOverview, liveConfig.systemPromptAppend),
		})
			.catch((err) => log.error?.(`Agent run failed for ${sessionId}: ${(err as Error)?.message ?? err}`))
			.finally(() => {
				if (abortControllers.get(sessionId) === controller) abortControllers.delete(sessionId);
			});
	}

	function cancelRun(sessionId: string): boolean {
		// Clear any scheduled followups first. Without this, a timer set via `schedule_followup`
		// would fire after the operator cancelled, silently re-injecting a user prompt and kicking
		// the loop off again — surprising behavior and avoidable LLM cost.
		for (const [id, followup] of composed.scheduled.entries()) {
			if (followup.sessionId === sessionId) {
				clearTimeout(followup.timer);
				composed.scheduled.delete(id);
			}
		}
		const controller = abortControllers.get(sessionId);
		if (!controller) return false;
		controller.abort(new Error('cancelled by operator'));
		abortControllers.delete(sessionId);
		return true;
	}

	function setConfig(patch: Partial<AgentConfig>): AgentConfig {
		const previousAllowDestructive = liveConfig.allowDestructive;
		liveConfig = { ...liveConfig, ...patch };
		if (liveConfig.allowDestructive !== previousAllowDestructive) {
			composed = compose();
		}
		// NOTE: an already in-flight run captured its toolset (and autoApprove) at start, so flipping
		// allowDestructive here only affects subsequent runs — the live loop finishes on its existing
		// toolset. Acceptable: the approval gate still applies on the next turn's run, and operators
		// who need to halt a run immediately use cancel_agent_run. Tightening to per-turn re-evaluation
		// would require threading a config getter into the loop; deferred until there's a need.
		return liveConfig;
	}

	const operations = buildOperations({
		getConfig: () => liveConfig,
		setConfig,
		startRun,
		cancelRun,
	});
	for (const op of operations) opts.server.registerOperation(op);

	// Expose the agent over MCP: register curated agent tools into the registry AFTER the ops exist.
	// (The generic operations-profile walk ran before this, so allow-listing the agent ops wouldn't
	// surface them — see mcpTools.ts.) They only reach clients when the MCP surface is enabled.
	registerAgentMcpTools(operations);

	log.info?.(`Agent component initialized with ${composed.tools.length} tools`);
}

/**
 * Grounding prompt so the agent knows what it is, where its files live, and how a Harper app is
 * shaped. Without it the model can't know the absolute componentsRoot and guesses literal path
 * prefixes (e.g. "componentsRoot/…") that fall outside the write scope.
 *
 * Assembled as: built-in grounding → Harper best-practices overview (if available) → operator
 * `agent.systemPromptAppend` (if set). The append is read from liveConfig at each run so it can be
 * tuned via `set_agent_config` without a restart.
 */
function buildSystemPrompt(scopes: AgentScopes, bestPracticesOverview?: string, append?: string): string {
	const parts = [
		'You are the built-in Harper agent, running on the main thread inside a live Harper server.',
		'You operate this instance for an operator via tools: Harper operations (describe_all, search, deploy_component, restart, set_configuration, add_role, …), scoped filesystem tools (read_file, write_file, list_dir, grep_files, tail_file), schedule_followup, http_fetch, and (when available) V8 inspector tools for debugging worker threads and a harper_best_practice tool for detailed Harper guidance.',
		'',
		'Filesystem:',
		`- Components (apps) directory — your WRITE scope: ${scopes.componentsRoot}`,
		`- Log directory (read-only): ${scopes.logDir}`,
		`- Config directory (read-only): ${scopes.configDir}`,
		'- Pass write_file/read_file paths RELATIVE to the components directory (e.g. "my_app/schema.graphql"), or an absolute path within a scope. Do NOT prefix paths with "componentsRoot".',
		'',
		'A Harper app is a component directory under the components dir. Define tables/resources in a schema (GraphQL `.graphql` with `@table`/`@export`, or `config.yaml` + resource files). After writing or changing component files, deploy/restart as needed for them to load, then verify by querying the REST endpoint via http_fetch against this server.',
		'Prefer the operations tools for database/cluster actions; use the filesystem tools for app source. When designing schemas or building app logic, consult the Harper best practices below and read the relevant rule via the harper_best_practice tool. Be concise and verify your work.',
	];
	if (bestPracticesOverview) {
		parts.push('', '=== Harper best practices (overview) ===', bestPracticesOverview);
	}
	if (append && append.trim()) {
		parts.push('', '=== Operator instructions ===', append.trim());
	}
	return parts.join('\n');
}

/**
 * Resolve the identity the agent's tool calls run as. Registry tools are enforced
 * (`hdb_user` at call time) against this user, so an operator who sets `agent.user`
 * to a restricted role gets a narrowed surface — and a later role change is honored,
 * because this runs per call rather than once at startup.
 *
 * Failure policy — fail closed, with one bounded exception:
 *   - If `agent.user` resolves to a permissioned user, use it.
 *   - If it can't be resolved AND it's the *default* `hdb_agent` bootstrap user,
 *     fall back to a super_user identity (the system user isn't provisioned yet —
 *     #626 defers creating it). This is the documented default-agent behavior.
 *   - If it can't be resolved and the operator configured a *non-default* user,
 *     throw. Silently escalating a misconfigured/transient restricted account to
 *     super_user is the vulnerability we refuse to introduce.
 */
async function resolveAgentIdentity(server: StartOpts['server'], username: string): Promise<AuthedUser> {
	let resolved: AuthedUser | undefined;
	if (typeof server.getUser === 'function') {
		try {
			const user = await server.getUser(username, null, null);
			if (user?.role?.permission) resolved = user;
		} catch (err) {
			log.warn?.(`Failed to resolve agent.user='${username}': ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (resolved) return resolved;

	if (username === DEFAULT_CONFIG.user) {
		log.warn?.(`Default agent user '${username}' is not provisioned yet; using super_user bootstrap identity`);
		return { username, role: { permission: { super_user: true } } };
	}
	throw new Error(`agent.user '${username}' could not be resolved to a permissioned user; failing closed`);
}

function resolveScopes(
	config: AgentConfig,
	getConfigPath: (param: string) => string | undefined,
	getConfigFilePath?: () => string
): AgentScopes {
	const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT) ?? process.cwd();
	const logDir = getConfigPath(CONFIG_PARAMS.LOGGING_ROOT) ?? process.cwd();
	const rootPath = getConfigPath(CONFIG_PARAMS.ROOTPATH) ?? componentsRoot;
	const configFile = getConfigFilePath?.();
	const configDir = configFile ? dirname(configFile) : process.cwd();
	// A relative `componentsScope` is resolved against rootPath, as documented in the schema —
	// NOT against componentsRoot, which would double-nest (`./components` → componentsRoot/components).
	// With no scope set, the full componentsRoot is the FS write scope.
	const scopedComponents = config.componentsScope
		? isAbsolute(config.componentsScope)
			? config.componentsScope
			: resolvePath(rootPath, config.componentsScope)
		: componentsRoot;
	return { componentsRoot: scopedComponents, logDir, configDir };
}

function mergeConfig(opts: StartOpts): AgentConfig {
	return {
		...DEFAULT_CONFIG,
		...(opts.enabled !== undefined && { enabled: !!opts.enabled }),
		...(opts.provider !== undefined && { provider: String(opts.provider) }),
		...(opts.model !== undefined && { model: String(opts.model) }),
		...(opts.maxTurns !== undefined && { maxTurns: Number(opts.maxTurns) }),
		...(opts.maxCostUsd !== undefined && { maxCostUsd: Number(opts.maxCostUsd) }),
		...(opts.autoApprove !== undefined && { autoApprove: !!opts.autoApprove }),
		...(opts.allowDestructive !== undefined && { allowDestructive: !!opts.allowDestructive }),
		...(opts.user !== undefined && { user: String(opts.user) }),
		...(opts.componentsScope !== undefined && { componentsScope: String(opts.componentsScope) }),
		...(opts.systemPromptAppend !== undefined && { systemPromptAppend: String(opts.systemPromptAppend) }),
	};
}

/** Test-only: reset module state between specs. */
export function _resetForTests(): void {
	_resetInFlightForTests();
}
