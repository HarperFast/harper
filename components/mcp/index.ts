/**
 * Native MCP (Model Context Protocol) server component for Harper.
 *
 * #614 replaces the foundation stub from #613 with a real Streamable HTTP
 * transport. Two entry points:
 *
 *   - `registerMcpProfile({profile:'operations', host, config, routeOptions})`
 *     called from `server/operationsServer.ts` (Fastify-side gate).
 *
 *   - `handleApplication(scope)` invoked by the component loader when the
 *     root config contains a top-level `mcp:` block. Registers the
 *     application-profile handler on the HTTP port iff `mcp.application` is
 *     present.
 *
 * Profile presence drives enablement, matching Harper's `replication`
 * convention (no `enabled` flag). See #465 for the umbrella design.
 */
import harperLogger from '../../utility/logging/harper_logger.ts';
import { getConfigObj as realGetConfigObj } from '../../config/configUtils.js';
import { createFastifyHandler } from './adapters/fastify.ts';
import { createHarperHttpHandler } from './adapters/harperHttp.ts';
import { ensureSessionTable } from './session.ts';
import { initListChanged } from './listChanged.ts';
import { registerApplicationTools } from './tools/application.ts';
import { registerOperationsTools } from './tools/operations.ts';
import type { McpProfile } from './transport.ts';

// Indirection so tests can swap the config source.
let getConfigObj: () => unknown = realGetConfigObj as () => unknown;
export function _setGetConfigObjForTest(fn: () => unknown): void {
	getConfigObj = fn;
}
export function _restoreGetConfigObj(): void {
	getConfigObj = realGetConfigObj as () => unknown;
}

interface McpProfileConfig {
	mountPath?: string;
}

interface FullConfig {
	mcp?: {
		operations?: McpProfileConfig;
		application?: McpProfileConfig;
		session?: unknown;
	};
}

type FastifyContentTypeParser = (req: unknown, body: string, done: (err: Error | null, body?: unknown) => void) => void;

/** Encapsulated Fastify instance handed to a plugin (the MCP route context). */
interface FastifyLikeInstance {
	post: (path: string, ...rest: unknown[]) => unknown;
	get: (path: string, ...rest: unknown[]) => unknown;
	delete: (path: string, ...rest: unknown[]) => unknown;
	addContentTypeParser: (
		contentType: string,
		opts: { parseAs: 'string' | 'buffer' },
		parser: FastifyContentTypeParser
	) => unknown;
}

type FastifyPlugin = (instance: FastifyLikeInstance, opts: unknown, done: (err?: Error) => void) => void;

interface FastifyLikeHost {
	register: (plugin: FastifyPlugin) => unknown;
}

export interface RegisterMcpProfileArgs {
	profile: McpProfile;
	host: FastifyLikeHost;
	config: FullConfig;
	routeOptions?: Record<string, unknown>;
}

const DEFAULT_MOUNT_PATH = '/mcp';

/**
 * Fastify-side registration. Used by `server/operationsServer.ts` for the
 * operations profile.
 *
 * The routes are registered inside an encapsulated Fastify plugin so we can
 * install a raw-body content-type parser scoped to the MCP endpoint WITHOUT
 * touching the rest of the operations API. Fastify's default JSON parser
 * rejects a malformed body with a framework 400 *before* the handler runs; by
 * reading the body as a raw string and letting the transport's `parseMessage`
 * be the single JSON-RPC parse point, a malformed envelope comes back as a
 * JSON-RPC `-32700` frame (#1317 S1) — matching the spec convention and
 * Harper's own unit tests.
 */
export function registerMcpProfile({ profile, host, config, routeOptions }: RegisterMcpProfileArgs): void {
	const profileConfig = config?.mcp?.[profile];
	if (!profileConfig) {
		harperLogger.trace(`MCP ${profile} profile not configured, skipping registration`);
		return;
	}
	ensureSessionTable();
	initListChanged();
	if (profile === 'operations') {
		registerOperationsTools();
	}
	const mountPath = profileConfig.mountPath ?? DEFAULT_MOUNT_PATH;
	const handler = createFastifyHandler(profile);
	host.register((instance, _opts, done) => {
		// Pass the JSON body through unparsed; the transport parses it once.
		instance.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, parserDone) => {
			parserDone(null, body);
		});
		// Register POST, GET, and DELETE on the same mount path. The transport
		// core decides whether to handle (POST initialize / JSON-RPC dispatch),
		// return 405 with an accurate `Allow` header (GET always in v1, DELETE
		// when `mcp.session.allowClientDelete` is false), or process (DELETE
		// when enabled). Without explicit GET/DELETE routes Fastify would
		// short-circuit to its built-in 404 before the transport runs.
		for (const method of ['post', 'get', 'delete'] as const) {
			if (routeOptions) {
				instance[method](mountPath, routeOptions, handler);
			} else {
				instance[method](mountPath, handler);
			}
		}
		done();
	});
	harperLogger.info(`MCP ${profile} profile registered at ${mountPath}`);
}

let applicationStarted = false;

interface ScopeLike {
	server: {
		http: (handler: unknown, options: Record<string, unknown>) => unknown;
	};
}

/**
 * Trusted-Resource-Plugin entry point for the application profile. The
 * component loader invokes this with the runtime `Scope` when the root
 * config contains a top-level `mcp:` block. We register the handler iff the
 * `application` sub-block is also present.
 *
 * Idempotent — repeated invocations no-op via `applicationStarted`. This
 * matches REST's pattern at `server/REST.ts:283-303`.
 */
export function handleApplication(scope: ScopeLike): void {
	if (applicationStarted) return;
	const config = getConfigObj() as FullConfig | undefined;
	if (!config?.mcp?.application) {
		harperLogger.trace('MCP application profile not configured, skipping registration');
		return;
	}
	applicationStarted = true;
	ensureSessionTable();
	initListChanged();
	registerApplicationTools();
	const mountPath = config.mcp.application.mountPath ?? DEFAULT_MOUNT_PATH;
	const handler = createHarperHttpHandler('application');
	scope.server.http(handler, { urlPath: mountPath, after: 'authentication' });
	harperLogger.info(`MCP application profile registered at ${mountPath}`);
}

/** Test seam: reset the module-level guard so tests can re-invoke handleApplication. */
export function _resetApplicationStartedForTest(): void {
	applicationStarted = false;
}
