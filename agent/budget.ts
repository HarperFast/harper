/**
 * Per-session spend caps for the built-in agent (#3040), and validation of the agent's numeric limits.
 * Usage is never stored as a running total:
 * each assistant message carries what its model call reported, and the session's usage is folded
 * from the transcript, so a total cannot drift from the calls it summarizes.
 */

import { ClientError } from '../utility/errors/hdbError.ts';
import type { AgentCallUsage, AgentMessage, AgentSessionUsage } from './types.ts';

export interface BudgetCaps {
	maxSessionTokens?: number;
	maxCostUsd?: number;
}

export function hasBudget(caps: BudgetCaps): boolean {
	return caps.maxSessionTokens !== undefined || caps.maxCostUsd !== undefined;
}

export function summarizeSessionUsage(
	messages: Iterable<AgentMessage>,
	rejectedCalls: Iterable<AgentCallUsage> = []
): AgentSessionUsage {
	let calls = 0;
	let promptTokens: number | undefined = 0;
	let completionTokens: number | undefined = 0;
	let costUsd: number | undefined = 0;
	const add = (usage: AgentCallUsage | undefined) => {
		calls++;
		promptTokens = addMeasured(promptTokens, usage?.promptTokens);
		completionTokens = addMeasured(completionTokens, usage?.completionTokens);
		costUsd = addMeasured(costUsd, usage?.costUsd);
	};
	for (const message of messages) {
		if (message.role === 'assistant') add(message.usage);
	}
	for (const usage of rejectedCalls) add(usage);
	const usage: AgentSessionUsage = { calls };
	if (promptTokens !== undefined) usage.promptTokens = promptTokens;
	if (completionTokens !== undefined) usage.completionTokens = completionTokens;
	if (costUsd !== undefined) usage.costUsd = costUsd;
	return usage;
}

function addMeasured(total: number | undefined, value: unknown): number | undefined {
	if (total === undefined || typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
	return total + value;
}

export function callUsage(
	usage: { promptTokens?: number; completionTokens?: number } | undefined,
	costUsd: number | undefined
): AgentCallUsage | undefined {
	const reported: AgentCallUsage = {};
	if (usage?.promptTokens !== undefined) reported.promptTokens = usage.promptTokens;
	if (usage?.completionTokens !== undefined) reported.completionTokens = usage.completionTokens;
	if (costUsd !== undefined) reported.costUsd = costUsd;
	return Object.keys(reported).length > 0 ? reported : undefined;
}

/** An unmeasured total violates its cap: running uncapped under a configured cap is what this prevents. */
export function budgetViolation(usage: AgentSessionUsage, caps: BudgetCaps): string | undefined {
	if (caps.maxSessionTokens !== undefined) {
		if (usage.promptTokens === undefined || usage.completionTokens === undefined) {
			return `agent.maxSessionTokens=${caps.maxSessionTokens} cannot be enforced: a model call in this session reported no token usage; start a new session or clear the cap`;
		}
		const used = usage.promptTokens + usage.completionTokens;
		if (used >= caps.maxSessionTokens)
			return `agent.maxSessionTokens=${caps.maxSessionTokens} reached: this session used ${used} tokens`;
	}
	if (caps.maxCostUsd !== undefined) {
		if (usage.costUsd === undefined) {
			return `agent.maxCostUsd=${caps.maxCostUsd} cannot be enforced: a model call in this session was not priced; declare pricing on the models.generative entry the agent uses, then start a new session or clear the cap`;
		}
		if (usage.costUsd >= caps.maxCostUsd) {
			return `agent.maxCostUsd=${caps.maxCostUsd} reached: this session cost $${usage.costUsd.toFixed(4)}`;
		}
	}
	return undefined;
}

/** Refuses rather than coerces: a cap coerced to `NaN` would compare false forever and silently uncap. */
export function parseBudgetCap(name: keyof BudgetCaps, value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	const cap = configNumber(value);
	const valid =
		typeof cap === 'number' &&
		Number.isFinite(cap) &&
		(name === 'maxSessionTokens' ? Number.isInteger(cap) && cap >= 1 : cap >= 0);
	if (!valid) {
		const expected = name === 'maxSessionTokens' ? 'a positive integer' : 'a non-negative number';
		throw new ClientError(`agent.${name} must be ${expected} or null, got ${JSON.stringify(value)}`, 400);
	}
	return cap;
}

/** `maxTurns` has a default rather than an "off", so `null` is refused like any other non-integer (a bare config key is skipped before this). */
export function parseMaxTurns(value: unknown): number {
	const turns = configNumber(value);
	if (typeof turns === 'number' && Number.isInteger(turns) && turns >= 1) return turns;
	throw new ClientError(`agent.maxTurns must be a positive integer, got ${JSON.stringify(value)}`, 400);
}

/** Env vars and CLI flags arrive as strings. */
function configNumber(value: unknown): unknown {
	return typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
}
