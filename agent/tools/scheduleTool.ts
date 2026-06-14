/**
 * `schedule_followup` for the built-in agent (#626).
 *
 * Lives on the main thread so it survives worker-thread restarts that happen
 * on code reload. The followup callback is injected from the entry point —
 * this module only schedules the timer and tracks pending entries.
 */

import { randomUUID } from 'node:crypto';
import type { AgentTool, AgentToolContext } from '../types.ts';

const MAX_DELAY_MS = 24 * 60 * 60 * 1000; // 24h
const MIN_DELAY_MS = 1_000;

export interface ScheduledFollowup {
	id: string;
	sessionId: string;
	prompt: string;
	fireAt: number;
	timer: NodeJS.Timeout;
}

export interface ScheduleToolDeps {
	onFollowup: (sessionId: string, prompt: string) => Promise<void> | void;
}

export function buildScheduleTool(deps: ScheduleToolDeps): {
	tool: AgentTool;
	pending: Map<string, ScheduledFollowup>;
} {
	const pending = new Map<string, ScheduledFollowup>();
	const tool: AgentTool = {
		def: {
			name: 'schedule_followup',
			description: 'Re-invoke the agent on the current session after the given delay with a new prompt.',
			parameters: {
				type: 'object',
				properties: {
					delayMs: { type: 'integer', minimum: MIN_DELAY_MS, maximum: MAX_DELAY_MS },
					prompt: { type: 'string', description: 'Prompt the agent should re-enter on with.' },
				},
				required: ['delayMs', 'prompt'],
			},
		},
		handler: async (args: any, ctx: AgentToolContext) => {
			const delay = Number(args.delayMs);
			if (!Number.isFinite(delay) || delay < MIN_DELAY_MS || delay > MAX_DELAY_MS) {
				throw new Error(`delayMs must be between ${MIN_DELAY_MS} and ${MAX_DELAY_MS}`);
			}
			const prompt = String(args.prompt ?? '').trim();
			if (!prompt) throw new Error('prompt is required');
			const id = randomUUID();
			const fireAt = Date.now() + delay;
			const timer = setTimeout(() => {
				pending.delete(id);
				Promise.resolve()
					.then(() => deps.onFollowup(ctx.sessionId, prompt))
					.catch(() => {
						/* swallow — caller logs */
					});
			}, delay);
			timer.unref?.();
			pending.set(id, { id, sessionId: ctx.sessionId, prompt, fireAt, timer });
			return { id, fireAt };
		},
	};
	return { tool, pending };
}
