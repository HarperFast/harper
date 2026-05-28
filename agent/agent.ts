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
 * worker-thread-shaped to do. Operator-only tools (FS, schedule, fetch) are
 * inline; registry-backed tools (#615/#617/#618) will fold in via toolset.ts
 * once those land.
 */

import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import { Models } from '../resources/models/Models.ts';
import { composeToolset } from './toolset.ts';
import { buildOperations } from './operations.ts';
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
}

export async function startOnMainThread(opts: StartOpts): Promise<void> {
	const config = mergeConfig(opts);
	if (!config.enabled) {
		log.info?.('Agent component disabled (agent.enabled=false); skipping registration');
		return;
	}

	// Lazily required to avoid pulling configUtils at module-eval time for tests.
	const { getConfigPath, getConfigFilePath } = require('../config/configUtils.js');
	const scopes = resolveScopes(config, getConfigPath, getConfigFilePath);

	const models = new Models();
	const abortControllers = new Map<string, AbortController>();
	let liveConfig: AgentConfig = config;
	let composed = composeToolset({
		allowDestructive: liveConfig.allowDestructive,
		onFollowup: handleFollowup,
	});

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
			composed = composeToolset({
				allowDestructive: liveConfig.allowDestructive,
				onFollowup: handleFollowup,
			});
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

	log.info?.(`Agent component initialized with ${composed.tools.length} tools`);
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
	};
}

/** Test-only: reset module state between specs. */
export function _resetForTests(): void {
	_resetInFlightForTests();
}
