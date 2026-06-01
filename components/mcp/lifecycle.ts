/**
 * MCP lifecycle handlers — `initialize` and `notifications/initialized`.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
 * v1 supports protocol version `2025-06-18` (preferred) and `2025-03-26`
 * (backcompat). Anything else returns 400 to the client; per the spec, the
 * server SHOULD respond with its preferred supported version so the client
 * can decide whether to connect on the older version or disconnect.
 */
import { createSession, saveSession, type McpSessionRecord } from './session.ts';
import { packageJson } from '../../utility/packageUtils.js';

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
	resources: { listChanged: true },
	logging: {},
} as const;

export interface InitializeParams {
	protocolVersion?: unknown;
	capabilities?: unknown;
	clientInfo?: unknown;
}

export interface InitializeResult {
	protocolVersion: string;
	serverInfo: typeof SERVER_INFO;
	capabilities: typeof SERVER_CAPABILITIES;
	instructions?: string;
}

export interface InitializeOutcome {
	ok: true;
	session: McpSessionRecord;
	result: InitializeResult;
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
 * `instructions` is optional per spec; we omit it in v1 (it can be wired
 * later when tools land in #617 and we know which profile is active).
 */
export async function handleInitialize(
	params: InitializeParams | undefined,
	user: string
): Promise<InitializeOutcome | InitializeFailure> {
	const requested = params?.protocolVersion;
	if (
		typeof requested !== 'string' ||
		!SUPPORTED_PROTOCOL_VERSIONS.includes(requested as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])
	) {
		return {
			ok: false,
			reason: `unsupported protocolVersion${typeof requested === 'string' ? `: ${requested}` : ''}`,
			supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
		};
	}
	const session = await createSession({ user, protocolVersion: requested });
	return {
		ok: true,
		session,
		result: {
			protocolVersion: requested,
			serverInfo: SERVER_INFO,
			capabilities: SERVER_CAPABILITIES,
		},
	};
}

/**
 * Flip the session to `initialized: true`. Called when the client posts the
 * `notifications/initialized` JSON-RPC notification (per MCP §lifecycle).
 * The transport returns HTTP 202 with no body regardless of outcome here.
 */
export async function handleInitialized(session: McpSessionRecord): Promise<McpSessionRecord> {
	if (session.initialized) return session;
	const updated: McpSessionRecord = { ...session, initialized: true };
	await saveSession(updated);
	return updated;
}
