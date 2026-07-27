'use strict';

import * as fs from 'fs-extra';
import Joi from 'joi';
import * as os from 'os';
const { boolean, string, number, array } = Joi.types();
import { totalmem } from 'os';
import * as path from 'path';
import * as hdbLogger from '../utility/logging/harper_logger.ts';
import * as hdbUtils from '../utility/common_utils.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import * as validator from './validationWrapper.ts';

const DEFAULT_LOG_FOLDER = 'log';
const DEFAULT_COMPONENTS_FOLDER = 'components';
const INVALID_SIZE_UNIT_MSG = 'Invalid logging.rotation.maxSize unit. Available units are G, M or K';
const INVALID_INTERVAL_UNIT_MSG =
	'Invalid logging.rotation.interval unit. Available units are D (days), H (hours), M (months) or m (minutes)';
const INVALID_MAX_SIZE_VALUE_MSG =
	"Invalid logging.rotation.maxSize value. Value should be a number followed by unit e.g. '10M'";
const INVALID_INTERVAL_VALUE_MSG =
	"Invalid logging.rotation.interval value. Value should be a number followed by unit e.g. '10D'";
const INVALID_RETENTION_UNIT_MSG =
	'Invalid logging.rotation.retention unit. Available units are D (days), H (hours), M (months) or m (minutes)';
const INVALID_RETENTION_VALUE_MSG =
	"Invalid logging.rotation.retention value. Value should be a number followed by unit e.g. '30D'";
// Units accepted for rotation durations, matching convertToMS: note capital M (months) vs lowercase m (minutes).
const VALID_ROTATION_DURATION_UNITS = ['D', 'd', 'H', 'h', 'M', 'm'];
const UNDEFINED_OPS_API = 'rootPath config parameter is undefined';

// Directory-path validation. The previous `([...]+)+$` nested quantifier
// backtracked catastrophically (ReDoS), hanging the CLI at 100% CPU on any
// value with a character outside its allow-list after a run of valid ones — a
// dotted rootPath such as `/Users/john.doe/hdb` is enough (#1779). An allow-list
// is also the wrong model for file paths: they legitimately contain spaces, `~`,
// parens (`C:\\Program Files (x86)`), apostrophes, and any Unicode
// (`/Users/café/hdb`), so any fixed class rejects real, previously-valid
// configs. These paths only ever reach `fs`/`path` (never a shell), so the
// character check is just a friendly "reject obvious garbage" gate — the real
// validation is the existence check in `validatePath`. So this is a denylist:
// reject only control characters — C0 (`\x00-\x1f`), DEL, and C1 (`\x80-\x9f`,
// which includes NEL U+0085) — plus the Unicode line/paragraph separators
// U+2028/U+2029, since paths get logged and any of these could forge log lines,
// via a single anchored quantifier — linear time, no backtracking. The
// `(?!\s*$)` guard rejects empty/whitespace-only values, which on Windows
// silently strip to a valid-but-wrong directory and would pass the existence
// check; `.`/`..` are allowed since they resolve honestly to real directories.
// eslint-disable-next-line no-control-regex -- deliberate: reject control characters
const DIRECTORY_PATH_PATTERN = /^(?!\s*$)[^\x00-\x1f\x7f\x80-\x9f\u2028\u2029]+$/;

const portConstraints = Joi.alternatives([number.min(0), string])
	.optional()
	.empty(null);
// Controlled-flow ("directional") replication fields. A route's `replicates` is either a boolean
// (full replication on/off) or an object describing per-direction flow; `sends`/`receives` and
// `sendsTo`/`receivesFrom` are also accepted as top-level route keys (iterateRoutes normalizes both
// forms). Entries in sendsTo/receivesFrom are a peer name (string) or an object scoping the edge by
// target/source + database, with an optional per-table excludeTables list. harper-pro#498 — these
// were previously unvalidated (allowUnknown), so typos/wrong types passed silently.
const routeEntryConstraints = Joi.alternatives([
	string,
	{
		target: string,
		source: string,
		database: string,
		excludeTables: array.items(string),
	},
]);
const replicatesConstraints = Joi.alternatives([
	boolean,
	{
		sends: boolean,
		sendsTo: array.items(routeEntryConstraints),
		receives: boolean,
		receivesFrom: array.items(routeEntryConstraints),
	},
]);
const directionalRouteFields = {
	replicates: replicatesConstraints,
	sends: boolean,
	receives: boolean,
	sendsTo: array.items(routeEntryConstraints),
	receivesFrom: array.items(routeEntryConstraints),
};
export const routeConstraints = Joi.alternatives([
	array
		.items(
			string,
			{
				host: string.required(),
				port: portConstraints,
				...directionalRouteFields,
			},
			{
				hostname: string.required(),
				port: portConstraints,
				...directionalRouteFields,
			}
		)
		.empty(null),
	array.items(string),
]);

let hdbRoot;
let skipFsVal = false;

export function configValidator(configJson, skipFsValidation = false) {
	skipFsVal = skipFsValidation;
	hdbRoot = configJson.rootPath;
	if (hdbUtils.isEmpty(hdbRoot)) {
		throw UNDEFINED_OPS_API;
	}

	const enabledConstraints = boolean.optional();
	const threadsConstraints = number.min(0).max(1000).empty(null).default(setDefaultThreads);
	const rootConstraints = string.pattern(DIRECTORY_PATH_PATTERN, 'directory path').empty(null).default(setDefaultRoot);
	const pemFileConstraints = string.optional().empty(null);

	const storagePathConstraints = Joi.custom(validatePath).empty(null).default(setDefaultRoot);
	const tlsConstraints = Joi.object({
		certificate: pemFileConstraints,
		certificateAuthority: pemFileConstraints,
		privateKey: pemFileConstraints,
		// Periodic re-read interval (ms) for the cert-file watcher's polling safety net.
		// 0 disables polling, leaving only the inotify-based chokidar watcher. Honored on the
		// top-level tls block (a single global setting); see getCertificateWatchInterval in security/keys.ts.
		certificateWatchInterval: number.min(0).optional().empty(null),
	});

	// MCP — sub-issue #613 lands the config surface ahead of the transport (#614).
	// Presence-based enablement: a profile is on iff its sub-block exists in
	// config (same convention as `replication`). No `enabled` field.
	const mcpRateLimitSchema = Joi.object({
		perToolPerSecond: number.min(0).optional(),
		perToolBurst: number.min(0).optional(),
		sessionConcurrency: number.min(0).optional(),
		sessionPerSecond: number.min(0).optional(),
	});
	const mcpOperationsSchema = Joi.object({
		mountPath: string.optional().default('/mcp'),
		allow: array.items(string).optional(),
		deny: array.items(string).optional(),
		maxTools: number.min(1).optional(),
		rateLimit: mcpRateLimitSchema.optional(),
	});
	const mcpApplicationSchema = mcpOperationsSchema.keys({
		searchMaxResults: number.min(1).optional(),
	});
	const mcpSessionSchema = Joi.object({
		idleTimeoutSeconds: number.min(1).optional(),
		allowClientDelete: boolean.optional(),
	});
	const mcpSchema = Joi.object({
		operations: mcpOperationsSchema.optional(),
		application: mcpApplicationSchema.optional(),
		session: mcpSessionSchema.optional(),
	});

	// Models — `models:` block opts a deployment into the per-backend registry.
	// Per-backend shape is validated by a discriminated alternative on the
	// `backend` field. Phase 2 (#629) lands ollama; Phase 3 (#630) lands openai.
	//
	// `.unknown(false)` on each known backend's schema turns field-name typos
	// (`bakend: ollama`, `hsot: ...`) into boot-blocking validation errors.
	// Without it, Joi's top-level `allowUnknown: true` propagates and typos
	// silently survive into bootstrap. Unknown backend types (anything not in
	// the `switch` list) fall through to a permissive schema so future Harper
	// versions or third-party components can register their own backends
	// without core schema edits — `bootstrapModels` logs+skips at runtime.
	//
	// `requestTimeoutMs: min(1)` (not `min(0)`) so the meaning is unambiguous:
	// omit the field for "no timeout". `0` would validate but `composeSignal`
	// treats it as "no timeout" via `if (!timeoutMs)`, surprising a test that
	// sets 0 to mean "fail immediately".
	const commonEntryFields = {
		model: string.optional(),
		requestTimeoutMs: number.min(1).optional(),
		// Ordered fallback group — other logical names tried, in order, after this one (#1326).
		fallback: Joi.array().items(string).optional(),
	};
	const ollamaEntrySchema = Joi.object({
		backend: string.valid('ollama').required(),
		host: string.optional(),
		...commonEntryFields,
	}).unknown(false);
	const openaiEntrySchema = Joi.object({
		backend: string.valid('openai').required(),
		// `apiKey` may be a literal secret or a `${ENV_VAR}` placeholder; both
		// are syntactically strings. `bootstrap.ts` runs `expandEnvVarsDeep`
		// before construction; the backend rejects unresolved placeholders
		// with an explicit error pointing at the env-var name.
		apiKey: string.required(),
		baseUrl: string.optional(),
		organization: string.optional(),
		...commonEntryFields,
	}).unknown(false);
	const anthropicEntrySchema = Joi.object({
		backend: string.valid('anthropic').required(),
		// Same secret-handling posture as openai's `apiKey`.
		apiKey: string.required(),
		baseUrl: string.optional(),
		...commonEntryFields,
	}).unknown(false);
	const bedrockEntrySchema = Joi.object({
		backend: string.valid('bedrock').required(),
		// AWS credentials resolve via the SDK chain (env / shared file / IAM
		// roles for service accounts) — no apiKey field. `region` is
		// effectively required (Bedrock is regional) but the backend can
		// fall back to AWS_REGION env, so we leave it optional here.
		region: string.optional(),
		...commonEntryFields,
	}).unknown(false);
	const unknownBackendEntrySchema = Joi.object({
		backend: string.required(),
	}).unknown(true);
	const modelEntrySchema = Joi.alternatives().conditional('.backend', {
		switch: [
			{ is: 'ollama', then: ollamaEntrySchema },
			{ is: 'openai', then: openaiEntrySchema },
			{ is: 'anthropic', then: anthropicEntrySchema },
			{ is: 'bedrock', then: bedrockEntrySchema },
		],
		otherwise: unknownBackendEntrySchema,
	});
	const modelsSchema = Joi.object({
		embedding: Joi.object().pattern(Joi.string(), modelEntrySchema).optional(),
		generative: Joi.object().pattern(Joi.string(), modelEntrySchema).optional(),
	});

	const configSchema = Joi.object({
		authentication: Joi.alternatives(
			Joi.object({
				authorizeLocal: boolean,
				cacheTTL: number.required(),
				cookie: Joi.object({
					domains: array.items(string).optional(),
					expires: string.optional(),
				}),
				enableSessions: boolean,
				hashFunction: string.valid('md5', 'sha256', 'argon2id').optional().empty(null),
			}),
			boolean
		).optional(),
		analytics: Joi.object({
			aggregatePeriod: number,
			replicate: boolean.optional(),
		}),
		replication: Joi.object({
			hostname: Joi.alternatives(string, number).optional().empty(null),
			url: string.optional().empty(null),
			port: portConstraints,
			securePort: portConstraints,
			routes: array.optional().empty(null),
			databases: Joi.alternatives(string, array),
			enableRootCAs: boolean.optional(),
			copyTablesToCatchUp: boolean.optional(),
			pingInterval: number.min(1).optional().empty(null),
			pingTimeout: number.min(1).optional().empty(null),
			copyTimeout: number.min(1).optional().empty(null),
			replayTimeout: number.min(1).optional().empty(null),
		}).optional(),
		componentsRoot: rootConstraints.optional(),
		localStudio: Joi.object({
			enabled: enabledConstraints,
		}).required(),
		logging: Joi.object({
			auditAuthEvents: Joi.object({
				logFailed: boolean,
				logSuccessful: boolean,
			}),
			file: boolean.required(),
			level: Joi.valid('notify', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'),
			rotation: Joi.object({
				enabled: boolean.optional(),
				compress: boolean.optional(),
				interval: string.custom(validateRotationInterval).optional().empty(null),
				maxSize: string.custom(validateRotationMaxSize).optional().empty(null),
				retention: string.custom(validateRotationRetention).optional().empty(null),
				path: string.optional().empty(null).default(setDefaultRoot),
			}).required(),
			root: rootConstraints,
			stdStreams: boolean.required(),
			auditLog: boolean.required(),
		}).required(),
		operationsApi: Joi.object({
			network: Joi.object({
				cors: boolean.optional(),
				corsAccessList: array.optional(),
				headersTimeout: number.min(1).optional(),
				keepAliveTimeout: number.min(1).optional(),
				port: portConstraints,
				domainSocket: Joi.optional().empty('hdb/operations-server').default(setDefaultRoot),
				securePort: portConstraints,
				timeout: number.min(1).optional(),
			}).optional(),
			tls: Joi.alternatives([Joi.array().items(tlsConstraints), tlsConstraints]),
		}).required(),
		rootPath: string.pattern(DIRECTORY_PATH_PATTERN, 'directory path').required(),
		mqtt: Joi.object({
			network: Joi.object({
				port: portConstraints,
				securePort: portConstraints,
				mtls: Joi.alternatives([
					boolean.optional(),
					Joi.object({
						user: string.optional(),
						certificateAuthority: pemFileConstraints,
						required: boolean.optional(),
					}),
				]),
			}).required(),
			webSocket: boolean.optional(),
			requireAuthentication: boolean.optional(),
		}),
		http: Joi.object({
			compressionThreshold: number.optional(),
			cors: boolean.optional(),
			corsAccessList: array.optional(),
			headersTimeout: number.min(1).optional(),
			port: portConstraints,
			securePort: portConstraints,
			maxHeaderSize: number.optional(),
			mtls: Joi.alternatives([
				boolean.optional(),
				Joi.object({
					user: string.optional(),
					certificateAuthority: pemFileConstraints,
					required: boolean.optional(),
				}),
			]),
			threadRange: Joi.alternatives([array.optional(), string.optional()]),
			securityHeaders: Joi.object()
				.pattern(string, Joi.alternatives([string, number, boolean]))
				.optional(),
		}).required(),
		threads: Joi.alternatives(
			threadsConstraints.optional(),
			Joi.object({
				count: threadsConstraints.optional(),
				debug: Joi.alternatives(
					boolean.optional(),
					Joi.object({
						startingPort: number.min(1).optional(),
						host: string.optional(),
						waitForDebugger: boolean.optional(),
					})
				),
				maxHeapMemory: number.min(0).optional(),
				preload: Joi.alternatives([string, array.items(string)])
					.allow(null)
					.optional(),
				preloadRequire: Joi.alternatives([string, array.items(string)])
					.allow(null)
					.optional(),
			})
		),
		storage: Joi.object({
			writeAsync: boolean.required(),
			overlappingSync: boolean.optional(),
			caching: boolean.optional(),
			compression: Joi.alternatives([
				boolean.optional(),
				Joi.object({ dictionary: string.optional(), threshold: number.optional() }),
			]),
			compactOnStart: boolean.optional(),
			compactOnStartKeepBackup: boolean.optional(),
			noReadAhead: boolean.optional(),
			path: storagePathConstraints,
			prefetchWrites: boolean.optional(),
			maxFreeSpaceToLoad: number.optional(),
			maxFreeSpaceToRetain: number.optional(),
		}).required(),
		mcp: mcpSchema.optional(),
		models: modelsSchema.optional(),
		ignoreScripts: boolean.optional(),
		tls: Joi.alternatives([Joi.array().items(tlsConstraints), tlsConstraints]),
	});

	// Not using the validation wrapper here because we need the result if validation is successful because
	// there is default values set as part of validation.
	return configSchema.validate(configJson, {
		allowUnknown: true,
		abortEarly: false,
		errors: { wrap: { label: "'" } },
	});
}

// This function is used to validate existence of paths passed as an argument
function doesPathExist(pathToCheck) {
	if (skipFsVal) return null;
	let exists = fs.existsSync(pathToCheck);
	if (exists) {
		return null;
	}

	return `Specified path ${pathToCheck} does not exist.`;
}

function validatePath(value, helpers) {
	Joi.assert(value, string.pattern(DIRECTORY_PATH_PATTERN, 'directory path'));

	let resolvedValue;
	if (value.startsWith('~/')) {
		resolvedValue = path.join(os.homedir(), value.slice(1));
	} else if (path.isAbsolute(value)) {
		resolvedValue = value;
	} else {
		resolvedValue = path.join(hdbRoot, value);
	}
	const doesExistMsg = doesPathExist(resolvedValue);
	if (doesExistMsg) {
		return helpers.message(doesExistMsg);
	}
}

// A Unix domain socket path is stored in a fixed-size `sockaddr_un.sun_path` buffer that must
// also fit a trailing NUL — 108 bytes on Linux (107 usable), 104 on macOS (103 usable). A path
// at or beyond that limit fails at listen() time with a bare EINVAL (see listenOnPorts() in
// server/threads/threadServer.js, which now fails soft on that error rather than aborting
// startup). This is a *warning*, not a schema error: a long rootPath is common (nested worktree
// checkouts, deep install paths) and losing the domain socket costs nothing but a convenience
// mirror of the TCP operations-API port — it must not block config validation / startup the way
// a real schema error does (validateConfig in configUtils.ts throws on any Joi error).
function udsPathMaxBytes(platform) {
	return platform === 'darwin' ? 103 : 107;
}

export const UDS_PATH_MAX_BYTES = udsPathMaxBytes(process.platform);

/**
 * Returns a warning message if `domainSocket` (resolved against `hdbRootPath`) would exceed the
 * platform's Unix domain socket path limit, or null if it fits (or domainSocket is falsy/non-string,
 * i.e. disabled). Called from configUtils.ts's validateConfig, after the Joi schema (which resolves
 * the default) has already run — non-blocking, so it's a plain function rather than a Joi custom rule.
 * `platform` defaults to `process.platform` but is accepted as a parameter so the path-resolution
 * logic for every platform can be unit tested from any CI host.
 */
export function getDomainSocketPathLengthWarning(hdbRootPath, domainSocket, platform = process.platform) {
	if (!domainSocket || typeof domainSocket !== 'string') return null;

	const platformPath = platform === 'win32' ? path.win32 : path.posix;
	let resolvedValue;
	if (domainSocket.startsWith('~/')) {
		resolvedValue = platformPath.join(os.homedir(), domainSocket.slice(1));
	} else if (platformPath.isAbsolute(domainSocket)) {
		resolvedValue = domainSocket;
	} else {
		// getConfigPath() (configUtils.ts) resolves this same value at runtime with
		// `path.resolve(rootPath, value)`, not `.join()` — when rootPath is itself relative (the
		// `rootPath` config value has no absolute-path requirement), resolve() folds in the process's
		// cwd while join() would leave the result relative, undercounting its real byte length.
		resolvedValue = platformPath.resolve(hdbRootPath, domainSocket);
	}
	const byteLength = Buffer.byteLength(resolvedValue);
	const limit = udsPathMaxBytes(platform);
	if (byteLength <= limit) return null;
	return `operationsApi.network.domainSocket resolves to "${resolvedValue}" (${byteLength} bytes), which exceeds the ${limit}-byte Unix domain socket path limit on ${platform}. The operations API will start without its domain socket (the TCP port is unaffected) — use a shorter rootPath, set operationsApi.network.domainSocket to a short absolute path outside rootPath, or set it to false to silence this warning.`;
}

function validateRotationMaxSize(value, helpers) {
	const unit = value.slice(-1);
	if (unit !== 'G' && unit !== 'M' && unit !== 'K') {
		return helpers.message(INVALID_SIZE_UNIT_MSG);
	}

	const size = value.slice(0, -1);
	if (isNaN(parseInt(size))) {
		return helpers.message(INVALID_MAX_SIZE_VALUE_MSG);
	}

	return value;
}

function validateRotationInterval(value, helpers) {
	const unit = value.slice(-1);
	if (!VALID_ROTATION_DURATION_UNITS.includes(unit)) {
		return helpers.message(INVALID_INTERVAL_UNIT_MSG);
	}

	const size = value.slice(0, -1);
	if (isNaN(parseInt(size))) {
		return helpers.message(INVALID_INTERVAL_VALUE_MSG);
	}

	return value;
}
function validateRotationRetention(value, helpers) {
	if (typeof value !== 'string' || !value.trim()) {
		return helpers.message(INVALID_RETENTION_VALUE_MSG);
	}

	const unit = value.slice(-1);
	if (!VALID_ROTATION_DURATION_UNITS.includes(unit)) {
		return helpers.message(INVALID_RETENTION_UNIT_MSG);
	}

	// parseFloat + strictly-positive check: convertToMS accepts fractional intervals, and a zero or
	// negative retention makes every rotated log older than the (<=0) window, deleting them immediately.
	const age = parseFloat(value.slice(0, -1));
	if (isNaN(age) || age <= 0) {
		return helpers.message(INVALID_RETENTION_VALUE_MSG);
	}

	return value;
}

function setDefaultThreads(parent, helpers) {
	const configParam = helpers.state.path.join('.');
	// Without SO_REUSEPORT (macOS is unreliable, Windows lacks it) worker threads cannot share the
	// HTTP/socket ports — the main thread binds them all first and serves alone, so extra HTTP
	// workers never receive direct TCP traffic. Default to a single worker there; an explicit
	// threads.count still overrides.
	if (process.platform === 'darwin' || process.platform === 'win32') {
		hdbLogger.info(
			`Defaulting ${configParam} to 1 on ${process.platform}: without SO_REUSEPORT, additional HTTP workers cannot share the server ports`
		);
		return 1;
	}
	let processors = os.cpus().length;

	// default to one less than the number of logical CPU/processors so we can have good concurrency with the
	// ingest process and any extra processes (jobs, reply, etc.).
	let numProcesses = processors - 1;
	// But if only two or less processors, keep two processes so we have some level of concurrency fairness
	if (numProcesses <= 2) numProcesses = 2;
	let availableMemory = process.constrainedMemory?.() || totalmem(); // used constrained memory if it is available
	// and lower than total memory
	availableMemory = Math.round(Math.min(availableMemory, totalmem()) / 1000000);
	// (available memory -750MB) / 300MB
	numProcesses = Math.max(Math.min(numProcesses, Math.round((availableMemory - 750) / 300)), 1);
	hdbLogger.info(
		`Detected ${processors} cores and ${availableMemory}MB on this machine, defaulting ${configParam} to ${numProcesses}`
	);
	return numProcesses;
}

/**
 * Sets a default root for a config param.
 * @param parent
 * @param helpers
 * @returns {string}
 */
function setDefaultRoot(parent, helpers) {
	// For some reason Joi is still calling set default when value is not null.
	// For that reason we do this check.
	const configParam = helpers.state.path.join('.');
	if (!hdbUtils.isEmpty(helpers.original) && configParam !== 'operationsApi.network.domainSocket') {
		return helpers.original;
	}

	if (hdbUtils.isEmpty(hdbRoot)) {
		throw new Error(`Error setting default root for: ${configParam}. HDB root is not defined`);
	}

	switch (configParam) {
		case 'componentsRoot':
			return DEFAULT_COMPONENTS_FOLDER;
		case 'logging.root':
			return DEFAULT_LOG_FOLDER;
		case 'storage.path':
			const legacyStoragePath = path.join(hdbRoot, hdbTerms.LEGACY_DATABASES_DIR_NAME);
			if (fs.existsSync(legacyStoragePath)) return hdbTerms.LEGACY_DATABASES_DIR_NAME;
			return hdbTerms.DATABASES_DIR_NAME;
		case 'logging.rotation.path':
			return DEFAULT_LOG_FOLDER;
		case 'operationsApi.network.domainSocket':
			return configParam == null ? null : 'operations-server';
		default:
			throw new Error(`Error setting default root for config parameter: ${configParam}. Unrecognized config parameter`);
	}
}

/**
 * Validates just the routes array.
 * @param routesArray
 * @returns {*}
 */
export function routesValidator(routesArray) {
	const schema = Joi.object({
		routes: routeConstraints,
	});
	return validator.validateBySchema({ routes: routesArray }, schema);
}
