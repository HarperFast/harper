'use strict';

import { loadCredentials, saveCredentials, normalizeTarget } from './cliCredentials.ts';
import { isJWTExpired } from '../security/tokenAuthentication.ts';
import * as envMgr from '../utility/environment/environmentManager.ts';
envMgr.initSync();
import * as terms from '../utility/hdbTerms.ts';
import { httpRequest } from '../utility/common_utils.ts';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as YAML from 'yaml';
import { Readable } from 'node:stream';
import { streamPackagedDirectory, packageDirectory, scanPackageDirectory } from '../components/packageComponent.ts';
import { encode as encodeCbor } from 'cbor-x';
import { buildMultipartBody } from './multipartBuilder.ts';
import { parseSSE } from './sseConsumer.ts';
import { DeployRenderer } from './deployRenderer.ts';
import { getHdbPid } from '../utility/processManagement/processManagement.js';
import { initConfig, getConfigPath } from '../config/configUtils.ts';

const OP_ALIASES = { deploy: 'deploy_component', package: 'package_component' };

// Shown for any local-instance connection failure (missing pid, missing/stale domain
// socket, or a refused/ENOENT connect against it) — they're all the same user-facing
// scenario: Harper isn't running. Remote-target failures keep the detailed error instead,
// since there's no single "just start it" fix for those.
const LOCAL_NOT_RUNNING_MESSAGE = 'Harper is not running. Use `harperdb run` (or `harperdb start`) to start it.';

// Operations whose responses should be consumed as text/event-stream so live phase events
// (prepare, load, replicate, restart) render as they happen instead of after the whole
// deploy completes. Add an operation here only after wiring its server-side
// SSE_PROGRESS_OPERATIONS entry — otherwise the server returns the buffered JSON path and
// the SSE parser sees no events.
const SSE_OPERATIONS = new Set(['deploy_component']);

// Properties on `req` that the CLI itself uses for transport/UX, not the operations API.
// They never get serialized into the request body. `username`/`password` are deliberately
// NOT here: those args are payload fields (e.g. the user add_user/alter_user create/alter),
// not transport — use `auth_username`/`auth_password` (or env-var/`harper login` auth) to
// authenticate as a different user than the one being operated on.
const TRANSPORT_ONLY_FIELDS = new Set([
	'target',
	'auth_username',
	'auth_password',
	'rejectUnauthorized',
	'json',
	'skip_node_modules',
	'skip_symlinks',
]);

// Streaming (multipart upload + SSE progress) deploy was introduced in 5.1.0. A CLI at >=
// 5.1 talking to a server < 5.1 must not use it: the older server has no multipart body
// parser (the upload is rejected) and its generic text/event-stream serializer emits a bare
// `data:` frame with no `done` event (so the CLI reads no result — "Deploy completed (no
// result payload)."). For those targets we fall back to the legacy deploy transport: the
// tarball rides as a native binary `payload` in a CBOR-encoded body — exactly what the
// pre-5.1 CLI sent (Content-Type: application/cbor) — so it stays compact (~1x) instead of
// ballooning as a base64 string (~1.33x) or a {type,data} JSON byte array (~5x).
const STREAMING_DEPLOY_MIN_MAJOR = 5;
const STREAMING_DEPLOY_MIN_MINOR = 1;

// Idle-socket timeout for CLI Op-API requests: no traffic (in either direction) for this long
// means the target is unreachable or wedged. Resets on any activity, so a slow-but-active
// upload/deploy is unaffected — only a fully silent connection trips it. Overridable for
// operations against known-slow targets.
//
// SSE-based operations (see SSE_OPERATIONS above) get a much longer default: a long-running
// deploy_component can go quiet between phase events (e.g. a slow replicate/load step) for well
// over a minute even though the connection is perfectly healthy, so the generic 60s default is
// too tight for this one. HARPER_CLI_TIMEOUT_MS/CLI_TIMEOUT_MS, when set, overrides BOTH
// defaults uniformly — it's a single "I know what timeout I want" escape hatch rather than two
// separate env vars to keep in sync.
const DEFAULT_CLI_OPERATION_TIMEOUT_MS = 60000;
const DEFAULT_SSE_OPERATION_TIMEOUT_MS = 600000; // 10 minutes
// Largest delay Node's setTimeout accepts; a larger value is silently coerced and fires in
// ~1ms instead of the intended delay, so out-of-range input is treated the same as any other
// invalid input below (falls back to DEFAULT_CLI_OPERATION_TIMEOUT_MS) rather than passed through.
const MAX_CLI_OPERATION_TIMEOUT_MS = 2147483647; // 2^31 - 1
const RAW_CLI_OPERATION_TIMEOUT = (process.env.HARPER_CLI_TIMEOUT_MS || process.env.CLI_TIMEOUT_MS)?.trim();
const PARSED_CLI_OPERATION_TIMEOUT = RAW_CLI_OPERATION_TIMEOUT ? Number(RAW_CLI_OPERATION_TIMEOUT) : NaN;
const CLI_OPERATION_TIMEOUT_OVERRIDE_MS =
	Number.isInteger(PARSED_CLI_OPERATION_TIMEOUT) &&
	PARSED_CLI_OPERATION_TIMEOUT >= 0 &&
	PARSED_CLI_OPERATION_TIMEOUT <= MAX_CLI_OPERATION_TIMEOUT_MS
		? PARSED_CLI_OPERATION_TIMEOUT
		: undefined;
const CLI_OPERATION_TIMEOUT_MS = CLI_OPERATION_TIMEOUT_OVERRIDE_MS ?? DEFAULT_CLI_OPERATION_TIMEOUT_MS;
const SSE_OPERATION_TIMEOUT_MS = CLI_OPERATION_TIMEOUT_OVERRIDE_MS ?? DEFAULT_SSE_OPERATION_TIMEOUT_MS;

/**
 * Parses a Harper version string (e.g. "5.0.31", "5.1.0-beta.2") and reports whether the
 * server is new enough to accept the multipart + SSE streaming deploy. Unparseable input
 * returns true so we never downgrade a deploy against a server we simply can't classify.
 */
function versionSupportsStreamingDeploy(version: unknown): boolean {
	if (typeof version !== 'string') return true;
	const match = version.match(/^(\d+)\.(\d+)/);
	if (!match) return true;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major !== STREAMING_DEPLOY_MIN_MAJOR) return major > STREAMING_DEPLOY_MIN_MAJOR;
	return minor >= STREAMING_DEPLOY_MIN_MINOR;
}

/**
 * Probes a remote target's Harper version via `registration_info` (a lightweight, long-lived
 * operation present on both < 5.1 and >= 5.1 servers that returns `{ version }`) to decide
 * whether the streaming deploy protocol is supported. Any probe failure — non-200, missing
 * version, network error — resolves to `true` (assume modern) so we never break a deploy
 * that would otherwise have worked; we only downgrade on a positive "older than 5.1" reading.
 */
async function targetSupportsStreamingDeploy(options: any): Promise<boolean> {
	try {
		const probeOptions = {
			...options,
			headers: { ...options.headers, Accept: 'application/json' },
			timeout: CLI_OPERATION_TIMEOUT_MS,
		};
		delete probeOptions.streamResponse;
		const response = await httpRequest(probeOptions, { operation: 'registration_info' });
		if (response.statusCode !== 200 || !response.body) return true;
		const version = JSON.parse(response.body)?.version;
		return versionSupportsStreamingDeploy(version);
	} catch {
		return true;
	}
}

// Wraps the local packaging stream so an fs error while tar'ing up the payload (e.g. a file
// vanishing after the pre-deploy scan, or a permissions failure reading the project tree)
// surfaces as a descriptive packaging error instead of a raw fs error code. Without this, an
// ENOENT from *packaging* is indistinguishable from an ENOENT/ECONNREFUSED connecting to the
// local domain socket, and the catch block below (which classifies purely on err.code) would
// misreport it as "Harper is not running" even though Harper is running fine. Mirrors the
// legacy deploy path's wrapping of packageDirectory() below.
async function* wrapPackagingStream(stream: Readable, projectPath: string): AsyncGenerator<Buffer> {
	try {
		for await (const chunk of stream) yield chunk as Buffer;
	} catch (err: any) {
		throw new Error(`Failed to package component directory '${projectPath}': ${err.message}`, { cause: err });
	}
}

// Build the JSON operation-field set from `req`, dropping the CLI's internal (`_`-prefixed)
// and transport-only fields so neither the CLI internals nor credentials leak into the
// request body. Shared by the multipart and legacy-JSON deploy body builders.
function operationFields(req: any): any {
	const fields: any = {};
	for (const [key, value] of Object.entries(req)) {
		if (key.startsWith('_') || TRANSPORT_ONLY_FIELDS.has(key)) continue;
		fields[key] = value;
	}
	return fields;
}

function basicAuthHeader(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * Picks the HTTP Basic credentials for a targeted operation from the first source that supplies
 * any, in precedence order: the dedicated `auth_username=`/`auth_password=` args, then userinfo
 * embedded in the target URL, then each env-var pair. Every source is all-or-nothing: pairing one
 * source's username with another's password would send one identity's name with a different
 * identity's secret, so a half-specified source is never completed from the next one (an empty
 * value — a blank CI variable, say — counts as specified-but-missing).
 *
 * Returns undefined when no source is configured at all, which leaves authentication to the saved
 * `harper login` token and, failing that, the legacy `username=`/`password=` payload fallback.
 */
function resolveTransportCredentials(req: any, urlCredentials: { username: string; password: string }) {
	const sources = [
		{
			name: '`auth_username=`/`auth_password=`',
			username: req.auth_username,
			password: req.auth_password,
			incompleteIsFatal: true,
		},
		{
			name: 'the target URL',
			// A URL with no userinfo yields empty strings, which here mean "absent" — unlike an
			// explicitly passed empty value, there is nothing for the user to have gotten wrong.
			username: urlCredentials.username || undefined,
			password: urlCredentials.password || undefined,
			incompleteIsFatal: true,
		},
		{
			name: 'HARPER_CLI_USERNAME/HARPER_CLI_PASSWORD',
			username: process.env.HARPER_CLI_USERNAME,
			password: process.env.HARPER_CLI_PASSWORD,
			incompleteIsFatal: false,
		},
		{
			name: 'CLI_TARGET_USERNAME/CLI_TARGET_PASSWORD',
			username: process.env.CLI_TARGET_USERNAME,
			password: process.env.CLI_TARGET_PASSWORD,
			incompleteIsFatal: false,
		},
	];
	// A source counts as configured once either half is *supplied*, empty or not: `auth_username=`
	// with an unset CI variable behind it is a broken credential, and quietly falling through to a
	// saved admin token would run the command as the wrong identity.
	for (const { name, username, password, incompleteIsFatal } of sources) {
		if (username === undefined && password === undefined) continue;
		if (!username || !password) {
			const missing = username ? 'a password' : password ? 'a username' : 'a username and a password';
			const detail = `${name} is missing ${missing}, and credentials are never combined across sources`;
			// Credentials passed explicitly for this command have no other purpose, so an
			// incomplete pair is a mistake worth failing on. The env vars double as `harper login`
			// inputs — a lone HARPER_CLI_USERNAME or HARPER_CLI_PASSWORD is a supported login idiom
			// with the other half prompted for — so an incomplete pair there is skipped with a
			// warning instead of breaking every later operation in the same shell or CI job.
			if (incompleteIsFatal) throw new Error(`Incomplete credentials: ${detail}.`);
			console.error(`Ignoring incomplete credentials: ${detail}.`);
			continue;
		}
		return { username, password };
	}
}

// Secret-valued CLI args, whatever their role (transport auth or operation payload). Logging a
// parsed CLI request must go through redactCredentials() so a password doesn't land in the log
// file — the command line already exposes it to shell history and process listings; the log
// shouldn't be a third copy. This list is by field name, not exhaustive — any future secret-bearing
// arg (a token, a key) needs to be added here explicitly, or it will reach logger.trace unredacted.
const SECRET_FIELDS = new Set(['auth_password', 'password']);

// `target=https://admin:secret@host` carries a password too, so masking the userinfo is part of
// making a target printable — the same string is echoed by the "Connecting to ..." line.
function redactTargetUrl(target: unknown): unknown {
	if (typeof target !== 'string') return target;
	try {
		const url = new URL(target);
		if (!url.password) return target;
		url.password = '***';
		return url.toString();
	} catch {
		return target;
	}
}

function redactCredentials(req: any): any {
	const redacted: any = {};
	for (const [key, value] of Object.entries(req)) {
		if (SECRET_FIELDS.has(key) && value) redacted[key] = '***';
		else if (key === 'target') redacted[key] = redactTargetUrl(value);
		else redacted[key] = value;
	}
	return redacted;
}

export { cliOperations, buildRequest, redactCredentials, refreshExpiredOperationToken };
const PREPARE_OPERATION: any = {
	deploy_component: async (req) => {
		if (req.package) {
			return;
		}

		const projectPath = process.cwd();
		if (!req.project) req.project = path.basename(projectPath);
		const packageOptions = {
			skip_node_modules: req.skip_node_modules !== false,
			skip_symlinks: req.skip_symlinks === true,
		};
		// Store path + options for deferred stream creation after the renderer is set up,
		// so the pre-gzip onBytes callback can be wired directly to renderer.countUploadBytes.
		req._projectPath = projectPath;
		req._packageOptions = packageOptions;
		// Pre-walk the directory once for both the uncompressed-size estimate (progress bar
		// total) and the dangling-symlink list — a dangling symlink would otherwise silently
		// truncate the tarball (tar-fs finalizes early on the broken target). Packaging skips
		// them; the list is reused below (no second walk) and warns the user which links were
		// skipped so the omission is visible.
		const scan = await scanPackageDirectory(projectPath, packageOptions);
		req._uploadSizeEstimate = scan.totalSize;
		req._danglingSymlinks = scan.danglingSymlinks;
		if (scan.danglingSymlinks.length) {
			process.stderr.write(
				`warning: skipping ${scan.danglingSymlinks.length} broken symlink(s) — their linked content will NOT be deployed:\n` +
					scan.danglingSymlinks.map((p) => `  ${p}\n`).join('')
			);
		}
		req._multipart = true;
	},
};

/**
 * Builds an Op-API request object from CLI args
 */
function buildRequest(): any {
	const req: any = {};
	for (const arg of process.argv.slice(2)) {
		if (OP_ALIASES.hasOwnProperty(arg)) {
			req.operation = OP_ALIASES[arg];
		} else if (arg.includes('=')) {
			let [first, ...rest] = arg.split('=');
			let restStr: any = rest.join('=');

			try {
				restStr = JSON.parse(restStr);
			} catch {
				/* noop */
			}

			req[first] = restStr;
		} else {
			// operation should only be in the first arg
			req.operation ??= arg;
		}
	}

	return req;
}

/**
 * Resolves the target URL from various sources.
 * @param {Object} req The request object.
 * @param {Object} allCredentials Stored credentials.
 * @returns {string|null} The resolved target URL.
 */
function resolveTarget(req, allCredentials) {
	return (
		req.target ||
		process.env.HARPER_CLI_TARGET ||
		process.env.CLI_TARGET ||
		(allCredentials && allCredentials.last_target)
	);
}

/**
 * If `tokens.operation_token` is expired and a `refresh_token` is on hand, refreshes it via
 * `refresh_operation_token`, persisting the new token to the credentials file and updating
 * `tokens.operation_token` in place. Shared by `cliOperations` and any other CLI transport
 * (e.g. `harper agent`) authenticating with stored `harper login` tokens, so refresh behavior
 * stays in one place instead of drifting between callers.
 */
async function refreshExpiredOperationToken(
	options: any,
	tokens: { operation_token: string; refresh_token: string },
	lookupKey: string
): Promise<void> {
	if (!tokens.refresh_token || !isJWTExpired(tokens.operation_token)) return;
	console.error('Operation token expired, attempting to refresh...');
	try {
		// Always use the standard operation timeout for this call, even when the caller's
		// own options carry the longer SSE timeout (e.g. a deploy_component retry) — the
		// refresh call itself is a small, fast request, not the streaming operation.
		const refreshOptions = { ...options, timeout: CLI_OPERATION_TIMEOUT_MS };
		refreshOptions.headers = { ...options.headers, Authorization: `Bearer ${tokens.refresh_token}` };
		const refreshResponse = await httpRequest(refreshOptions, {
			operation: 'refresh_operation_token',
		});
		if (refreshResponse.statusCode === 200) {
			const refreshData = JSON.parse(refreshResponse.body);
			if (refreshData.operation_token) {
				tokens.operation_token = refreshData.operation_token;
				saveCredentials(lookupKey, {
					operation_token: tokens.operation_token,
					refresh_token: tokens.refresh_token,
				});
				console.error('Operation token refreshed successfully.');
			}
		} else if (refreshResponse.statusCode === 401) {
			console.error('Refresh token expired or invalid. Please run harper login again.');
			process.exit(1);
		} else {
			console.error(`Failed to refresh operation token: ${refreshResponse.statusCode}`);
		}
	} catch (refreshErr) {
		console.error(`Error refreshing operation token: ${refreshErr.message}`);
	}
}

/**
 * Using a unix domain socket will send a request to hdb operations API server
 * @param req
 * @param skipResponseLog By default, the response is logged to the console. Set this to true to skip logging it, which can be useful for sensitive responses like login calls!
 * @returns {Promise<void>}
 */
async function cliOperations(req: any, skipResponseLog = false) {
	require('dotenv').config();

	const allCredentials = loadCredentials();
	req.target = normalizeTarget(resolveTarget(req, allCredentials));
	let target;
	let urlCredentials = { username: '', password: '' };
	if (req.target) {
		let parsedTarget;
		try {
			parsedTarget = new URL(req.target);
		} catch (error) {
			try {
				parsedTarget = new URL(`https://${req.target}:9925`);
			} catch {
				throw error;
			}
		}
		const resolvedTarget = req.target;
		urlCredentials = { username: parsedTarget.username, password: parsedTarget.password };
		target = {
			protocol: parsedTarget.protocol,
			hostname: parsedTarget.hostname,
			port: parsedTarget.port,
			rejectUnauthorized: req.rejectUnauthorized,
			resolvedTarget,
		};
		console.error(`Connecting to ${redactTargetUrl(resolvedTarget)}`);
	} else {
		// if we aren't doing a targeted operation (like deploy), we initialize the config and verify that local harper
		// is running and that we can communicate with it.
		console.error('Connecting to local Harper instance');
		initConfig();
		if (!getHdbPid()) {
			console.error(LOCAL_NOT_RUNNING_MESSAGE);
			process.exit(1);
		}

		if (!fs.existsSync(getConfigPath(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET))) {
			console.error(LOCAL_NOT_RUNNING_MESSAGE);
			process.exit(1);
		}
	}
	await PREPARE_OPERATION[req.operation]?.(req);
	try {
		let options = target ?? {
			protocol: 'http:',
			socketPath: getConfigPath(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET),
		};
		options.method = 'POST';
		options.headers = { 'Content-Type': 'application/json' };
		options.timeout = SSE_OPERATIONS.has(req.operation) ? SSE_OPERATION_TIMEOUT_MS : CLI_OPERATION_TIMEOUT_MS;
		// Authentication precedence: explicitly configured credentials (dedicated args, URL
		// userinfo, env vars) beat everything, then the saved `harper login` token, and only then
		// the legacy `username=`/`password=` payload fallback below. The saved token must outrank
		// that fallback: for add_user/alter_user those args are the credentials of the user being
		// created/altered, so treating them as auth would authenticate as a user who doesn't exist
		// yet (or as the wrong identity) instead of using the admin's existing session.
		const transportCredentials = target ? resolveTransportCredentials(req, urlCredentials) : undefined;
		if (transportCredentials) {
			options.headers.Authorization = basicAuthHeader(transportCredentials.username, transportCredentials.password);
		} else if (allCredentials) {
			let tokens = null;
			let lookupKey = null;
			if (target && allCredentials.targets) {
				lookupKey = target.resolvedTarget;
				tokens = allCredentials.targets[lookupKey] ?? null;
			}

			if (tokens?.operation_token) {
				await refreshExpiredOperationToken(options, tokens, lookupKey || target?.resolvedTarget);
				options.headers.Authorization = `Bearer ${tokens.operation_token}`;
			}
		}
		// Legacy fallback for operations where `username=`/`password=` genuinely ARE the caller's
		// credentials (e.g. `create_table username= password=`) and nothing else is configured.
		// Both are required — a lone `username=` (as in `drop_user username=bob`) is payload, not
		// a credential.
		if (target && !options.headers.Authorization && req.username && req.password) {
			options.headers.Authorization = basicAuthHeader(req.username, req.password);
		}
		// Streaming deploy (multipart upload + SSE progress) only works against >= 5.1 servers.
		// When deploying to a remote target, probe its version first and downgrade to the
		// legacy JSON deploy if it predates 5.1. Local (domain-socket) deploys always
		// hit this same Harper build, so no probe is needed there.
		if (req.operation === 'deploy_component' && target && !(await targetSupportsStreamingDeploy(options))) {
			req._legacyDeploy = true;
			if (req._multipart) {
				// Re-package the directory as a single buffered tarball. The legacy CBOR body
				// below carries it as native binary, matching the pre-5.1 CLI. Wrap the
				// packaging so a local failure (e.g. a file vanishing after the size walk)
				// surfaces as itself rather than being mapped to "Failed to connect to Harper"
				// by the catch below (which keys off err.code === 'ENOENT').
				try {
					req.payload = await packageDirectory(req._projectPath, req._packageOptions);
				} catch (packageErr: any) {
					throw new Error(`Failed to package component directory '${req._projectPath}': ${packageErr.message}`, {
						cause: packageErr,
					});
				}
				delete req._multipart;
			}
			console.error(
				'Target Harper predates streaming deploy (< 5.1); using legacy compatibility deploy (no live progress).'
			);
		}

		const useSse = SSE_OPERATIONS.has(req.operation) && !req._legacyDeploy;
		if (useSse) {
			options.headers.Accept = 'text/event-stream';
			options.streamResponse = true;
		}
		// One renderer owns the (future) upload bar and the SSE event rendering for a
		// multipart deploy. Created here so the upload-stream tap and the SSE consumer
		// below share the same instance.
		const renderer = req._multipart ? new DeployRenderer({ uploadTotal: req._uploadSizeEstimate ?? 0 }) : null;
		let body;
		if (req._multipart) {
			// Create the package stream here — after the renderer exists — so we can pass
			// renderer.countUploadBytes as the onBytes callback. Both progress and total are
			// uncompressed bytes, so the bar tracks accurately to 100% without premature snapping.
			const packageStream = streamPackagedDirectory(
				req._projectPath,
				req._packageOptions,
				renderer ? (n) => renderer.countUploadBytes(n) : undefined,
				req._danglingSymlinks
			);
			const fields = operationFields(req);
			const multipart = buildMultipartBody(fields, {
				name: 'payload',
				filename: 'package.tar.gz',
				contentType: 'application/gzip',
				stream: Readable.from(wrapPackagingStream(packageStream, req._projectPath)),
			});
			options.headers['Content-Type'] = multipart.contentType;
			// Use chunked transfer-encoding: we don't know the total size up front because the
			// payload is streamed from `tar.pack` and never fully buffered.
			options.headers['Transfer-Encoding'] = 'chunked';
			// Tap the body so bytes flowing into the HTTP request advance the upload bar.
			// The renderer's Transform is identity — chunks pass through unmodified.
			body = renderer ? renderer.tapUploadStream(multipart.stream) : multipart.stream;
		} else if (req._legacyDeploy) {
			const fields = operationFields(req);
			if (Buffer.isBuffer(fields.payload)) {
				// Directory deploy: CBOR-encode so the tarball travels as a native binary
				// byte string (the pre-5.1 transport). The pre-5.1 server's cbor parser hands
				// the handler a real Buffer payload. Accept JSON so the buffered response
				// parses on the existing (non-SSE) path below.
				options.headers['Content-Type'] = 'application/cbor';
				options.headers.Accept = 'application/json';
				body = encodeCbor(fields);
			} else {
				// Package deploy (no binary payload): plain JSON, as pre-5.1 sent it.
				body = fields;
			}
		} else {
			// Same TRANSPORT_ONLY_FIELDS stripping as the deploy body paths above — auth_username/
			// auth_password (and target/rejectUnauthorized/json/etc.) must never reach the wire as
			// operation-payload fields, on this path either.
			body = operationFields(req);
		}
		let response: any = await httpRequest(options, body);

		// endUpload() is called from the counter Transform's flush callback in tapUploadStream
		// once all multipart bytes have flowed through. For SSE deploys, httpRequest resolves
		// when response headers arrive (streamResponse: true), which happens before the full
		// upload completes — calling endUpload() here would snap the bar prematurely.

		let responseData;
		if (useSse && response.headers['content-type']?.startsWith('text/event-stream')) {
			// Consume SSE: render phase events live, capture the final result from the `done`
			// event (or the error message from the `error` event). The HTTP status stays 200
			// until end-of-stream; failures are signaled in-band.
			let finalResult;
			let sseError;
			for await (const message of parseSSE(response)) {
				renderer?.renderEvent(message);
				if (message.event === 'done') {
					try {
						finalResult = JSON.parse(message.data)?.result;
					} catch {
						finalResult = message.data;
					}
				} else if (message.event === 'error') {
					try {
						sseError = JSON.parse(message.data);
					} catch {
						sseError = { message: message.data };
					}
				}
			}
			if (sseError) {
				const errMsg = sseError.message ?? (typeof sseError === 'object' ? JSON.stringify(sseError) : sseError);
				console.error(`error: ${errMsg}`);
				process.exit(1);
			}
			responseData = finalResult ?? { message: 'Deploy completed (no result payload).' };
		} else {
			// When useSse is true, httpRequest returns a raw IncomingMessage (streamResponse mode),
			// so .body is undefined. Drain the stream to get the text (e.g. a 401 error body).
			let bodyText: string;
			if (useSse) {
				const chunks: Buffer[] = [];
				for await (const chunk of response as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
				bodyText = Buffer.concat(chunks).toString('utf8');
			} else {
				bodyText = response.body;
			}
			try {
				responseData = JSON.parse(bodyText);
			} catch {
				responseData = {
					status: response.statusCode + ' ' + (response.statusMessage || 'Unknown'),
					body: bodyText,
				};
			}
		}

		let responseLog;
		if (req.json) {
			responseLog = JSON.stringify(responseData, null, 2);
		} else {
			responseLog = YAML.stringify(responseData).trim();
		}

		const { statusCode } = response;
		if (statusCode < 200 || (statusCode >= 300 && statusCode !== 304)) {
			const errorPrefix = responseLog.startsWith('error:') ? '' : 'error: ';
			console.error(`${errorPrefix}${responseLog}`);
			process.exit(1);
		}

		if (!skipResponseLog) {
			console.log(responseLog);
		}

		if (target) {
			responseData.resolvedTarget = target.resolvedTarget;
		}

		return responseData;
	} catch (err) {
		let code, message, hostname;
		try {
			code = err?.code;
			message = err?.message;
			hostname = err?.hostname;
		} catch {}
		const isConnectionFailure = code === 'ENOENT' || code === 'ECONNREFUSED';
		if (isConnectionFailure && !target) {
			console.error(LOCAL_NOT_RUNNING_MESSAGE);
		} else if (isConnectionFailure) {
			console.error(`error: Failed to connect to Harper (${code}): ${message}`);
		} else if (code === 'EACCES') {
			console.error(`error: Permission denied accessing the domain socket: ${message}`);
		} else if (code === 'ENOTFOUND') {
			console.error(`error: Host not found: "${hostname}" ${message}`);
		} else {
			console.error(`error: ${message ?? err}`);
		}
		process.exit(1);
	}
}
