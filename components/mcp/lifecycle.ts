/**
 * MCP lifecycle handlers — `initialize` and `notifications/initialized`.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
 * v1 supports protocol version `2025-06-18` (preferred) and `2025-03-26`
 * (backcompat). Anything else returns 400 to the client; per the spec, the
 * server SHOULD respond with its preferred supported version so the client
 * can decide whether to connect on the older version or disconnect.
 */
import { createSession, patchSession, type McpSessionRecord } from './session.ts';
import { GATED_CLIENT_CAPABILITIES } from './serverRequests.ts';
import { packageJson } from '../../utility/packageUtils.js';
import { applicationInstructions } from './applicationInfo.ts';
import type { McpProfile } from './transport.ts';

export const PROTOCOL_VERSION_PREFERRED = '2025-06-18';
export const PROTOCOL_VERSION_BACKCOMPAT = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION_PREFERRED, PROTOCOL_VERSION_BACKCOMPAT] as const;

export const SERVER_INFO = {
	name: 'harper-mcp',
	version: (packageJson as { version: string }).version,
} as const;

/** Server capabilities advertised on `initialize` for v1. */
export const SERVER_CAPABILITIES = {
	tools: { listChanged: true },
	resources: { listChanged: true, subscribe: true },
	prompts: { listChanged: true },
	completions: {},
	logging: {},
} as const;

/**
 * A stateless profile has no GET stream to push list changes, resource updates or log messages on, and no
 * session to hold a subscription or a log level, so it advertises none of them.
 */
export const STATELESS_SERVER_CAPABILITIES = {
	tools: {},
	resources: {},
	prompts: {},
	completions: {},
} as const;

export interface InitializeParams {
	protocolVersion?: unknown;
	capabilities?: unknown;
	clientInfo?: unknown;
}

export interface InitializeResult {
	protocolVersion: string;
	serverInfo: typeof SERVER_INFO;
	capabilities: typeof SERVER_CAPABILITIES | typeof STATELESS_SERVER_CAPABILITIES;
	instructions?: string;
}

export interface InitializeOutcome {
	ok: true;
	session?: McpSessionRecord;
	result: InitializeResult;
}

export interface InitializeOptions {
	profile?: McpProfile;
	stateless?: boolean;
}

export interface InitializeFailure {
	ok: false;
	reason: string;
	supportedVersions: readonly string[];
}

/**
 * Negotiate protocol version, create a session, and return the JSON-RPC
 * result body. The caller (transport core) maps `ok: false` to HTTP 400.
 *
 * Per the MCP spec: if the client requests a version the server does not
 * support, the server MUST respond with a version it does support (so the
 * client can decide whether to downgrade or disconnect) — NOT fail. We
 * pick `PROTOCOL_VERSION_PREFERRED` for any unknown version. The only
 * `ok: false` cases are a missing or non-string `protocolVersion` field,
 * which is a protocol-level violation rather than version negotiation.
 *
 * `instructions` are the application profile's configured or registered text (`applicationInstructions`);
 * the operations profile omits them.
 */
export async function handleInitialize(
	params: InitializeParams | undefined,
	user: string,
	options: InitializeOptions = {}
): Promise<InitializeOutcome | InitializeFailure> {
	const requested = params?.protocolVersion;
	if (typeof requested !== 'string') {
		return {
			ok: false,
			reason: `protocolVersion is required and must be a string`,
			supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
		};
	}
	const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])
		? requested
		: PROTOCOL_VERSION_PREFERRED;
	const result: InitializeResult = {
		protocolVersion: negotiated,
		serverInfo: SERVER_INFO,
		capabilities: options.stateless ? STATELESS_SERVER_CAPABILITIES : SERVER_CAPABILITIES,
	};
	const instructions = options.profile === 'application' ? applicationInstructions() : undefined;
	if (instructions) result.instructions = instructions;
	if (options.stateless) return { ok: true, result };
	const session = await createSession({
		user,
		protocolVersion: negotiated,
		clientCapabilities: pickClientCapabilities(params?.capabilities),
	});
	return { ok: true, session, result };
}

/**
 * Keep only presence of the capabilities Harper gates on, so the persisted
 * session row's size does not depend on what an (often anonymous) client sends.
 */
function pickClientCapabilities(capabilities: unknown): Record<string, unknown> | undefined {
	if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return undefined;
	let picked: Record<string, unknown> | undefined;
	for (const name of GATED_CLIENT_CAPABILITIES) {
		if ((capabilities as Record<string, unknown>)[name]) (picked ??= {})[name] = {};
	}
	return picked;
}

/**
 * Flip the session to `initialized: true`. Called when the client posts the
 * `notifications/initialized` JSON-RPC notification (per MCP §lifecycle).
 * The transport returns HTTP 202 with no body regardless of outcome here.
 */
export async function handleInitialized(session: McpSessionRecord): Promise<McpSessionRecord> {
	if (session.initialized) return session;
	const updated: McpSessionRecord = { ...session, initialized: true };
	await patchSession(session.id, { initialized: true });
	return updated;
}
