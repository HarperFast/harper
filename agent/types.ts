/**
 * Shared types for the built-in Harper Agent component (#626).
 *
 * `AgentMessage` mirrors `resources/models/types.ts:Message` rather than
 * re-exporting it: the session row is durable storage and shouldn't trail
 * shape changes in the model-access surface.
 */

import type { ToolCall, ToolDef } from '../resources/models/types.ts';

export type AgentRunStatus = 'idle' | 'running' | 'awaiting_approval' | 'completed' | 'aborted' | 'error';

export interface AgentMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
	/** Wall-clock timestamp of when this item entered the transcript. */
	createdAt: number;
}

export interface ApprovalRequest {
	id: string;
	toolName: string;
	arguments: object;
	/** Tool-call id from the assistant message that produced this request. Used to resume execution. */
	toolCallId: string;
	/** Human-readable rationale for why approval is required (e.g. 'destructive', 'first_use'). */
	reason: string;
	createdAt: number;
	resolved?: boolean;
	approved?: boolean;
	resolvedAt?: number;
	/** Set to true once the loop has consumed the resolved approval (executed or refused). */
	consumed?: boolean;
}

export interface AgentSessionRow {
	session_id: string;
	user: string;
	status: AgentRunStatus;
	messages: AgentMessage[];
	pendingApprovals: ApprovalRequest[];
	model?: string;
	provider?: string;
	createdAt: number;
	updatedAt: number;
	lastError?: string;
}

export interface AgentToolHandler {
	(args: object, ctx: AgentToolContext): Promise<unknown>;
}

export interface AgentTool {
	def: ToolDef;
	handler: AgentToolHandler;
	/** When true, invocations of this tool require an approval gate unless `autoApprove` is set. */
	destructive?: boolean;
}

export interface AgentToolContext {
	sessionId: string;
	signal?: AbortSignal;
	/** Filesystem scope roots accessible to FS tools. Read-only after composition. */
	scopes: AgentScopes;
}

export interface AgentScopes {
	componentsRoot: string;
	logDir: string;
	configDir: string;
}

export interface AgentConfig {
	enabled: boolean;
	provider?: string;
	model?: string;
	maxTurns: number;
	maxCostUsd: number;
	autoApprove: boolean;
	allowDestructive: boolean;
	user: string;
	componentsScope?: string;
}
