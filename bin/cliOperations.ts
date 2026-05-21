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
import { streamPackagedDirectory } from '../components/packageComponent.ts';
import { buildMultipartBody } from './multipartBuilder.ts';
import { parseSSE } from './sseConsumer.ts';
import { DeployRenderer } from './deployRenderer.ts';
import { getHdbPid } from '../utility/processManagement/processManagement.js';
import { initConfig, getConfigPath } from '../config/configUtils.js';

const OP_ALIASES = { deploy: 'deploy_component', package: 'package_component' };

// Operations whose responses should be consumed as text/event-stream so live phase events
// (prepare, load, replicate, restart) render as they happen instead of after the whole
// deploy completes. Add an operation here only after wiring its server-side
// SSE_PROGRESS_OPERATIONS entry — otherwise the server returns the buffered JSON path and
// the SSE parser sees no events.
const SSE_OPERATIONS = new Set(['deploy_component']);

// Properties on `req` that the CLI itself uses for transport/UX, not the operations API.
// They never get serialized into the request body.
const TRANSPORT_ONLY_FIELDS = new Set([
	'target',
	'username',
	'password',
	'rejectUnauthorized',
	'json',
	'skip_node_modules',
	'skip_symlinks',
]);

export { cliOperations, buildRequest };
const PREPARE_OPERATION: any = {
	deploy_component: async (req) => {
		if (req.package) {
			return;
		}

		const projectPath = process.cwd();
		if (!req.project) req.project = path.basename(projectPath);
		// Stream the tar+gzip directly to the server as the file part of a multipart body.
		// This bypasses the Node Buffer 2 GB cap that the previous CBOR-encoded path was
		// subject to, so large components can deploy without materializing in memory.
		req._packageStream = streamPackagedDirectory(projectPath, {
			skip_node_modules: req.skip_node_modules !== false,
			skip_symlinks: req.skip_symlinks === true,
		});
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
	if (req.target) {
		try {
			target = new URL(req.target);
		} catch (error) {
			try {
				target = new URL(`https://${req.target}:9925`);
			} catch {
				throw error;
			}
		}
		const resolvedTarget = req.target;
		target = {
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port,
			username: req.username || target.username || process.env.HARPER_CLI_USERNAME || process.env.CLI_TARGET_USERNAME,
			password: req.password || target.password || process.env.HARPER_CLI_PASSWORD || process.env.CLI_TARGET_PASSWORD,
			rejectUnauthorized: req.rejectUnauthorized,
			resolvedTarget,
		};
		console.error(`Connecting to ${resolvedTarget}`);
	} else {
		// if we aren't doing a targeted operation (like deploy), we initialize the config and verify that local harper
		// is running and that we can communicate with it.
		console.error('Connecting to local Harper instance');
		initConfig();
		if (!getHdbPid()) {
			console.error('Harper must be running to perform this operation');
			process.exit(1);
		}

		if (!fs.existsSync(getConfigPath(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET))) {
			console.error('No domain socket found, unable to perform this operation');
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
		if (target?.username) {
			options.headers.Authorization = `Basic ${Buffer.from(`${target.username}:${target.password}`).toString('base64')}`;
		} else if (allCredentials) {
			let tokens = null;
			let lookupKey = null;
			if (target && allCredentials.targets) {
				lookupKey = target.resolvedTarget;
				tokens = allCredentials.targets[lookupKey] ?? null;
			}

			if (tokens?.operation_token) {
				if (tokens.refresh_token && isJWTExpired(tokens.operation_token)) {
					console.error('Operation token expired, attempting to refresh...');
					try {
						const refreshOptions = { ...options };
						refreshOptions.headers = { ...options.headers, Authorization: `Bearer ${tokens.refresh_token}` };
						const refreshResponse = await httpRequest(refreshOptions, {
							operation: 'refresh_operation_token',
						});
						if (refreshResponse.statusCode === 200) {
							const refreshData = JSON.parse(refreshResponse.body);
							if (refreshData.operation_token) {
								tokens.operation_token = refreshData.operation_token;
								saveCredentials(lookupKey || target?.resolvedTarget, {
									operation_token: tokens.operation_token,
									refresh_token: tokens.refresh_token,
								});
								console.error('Operation token refreshed successfully.');
								// Update the original request's authorization header with the new token
								options.headers.Authorization = `Bearer ${tokens.operation_token}`;
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
				options.headers.Authorization = `Bearer ${tokens.operation_token}`;
			}
		}
		const useSse = SSE_OPERATIONS.has(req.operation);
		if (useSse) {
			options.headers.Accept = 'text/event-stream';
			options.streamResponse = true;
		}
		// One renderer owns the (future) upload bar and the SSE event rendering for a
		// multipart deploy. Created here so the upload-stream tap and the SSE consumer
		// below share the same instance.
		const renderer = req._multipart ? new DeployRenderer({}) : null;
		let body;
		if (req._multipart) {
			const packageStream = req._packageStream;
			const fields = {};
			for (const [key, value] of Object.entries(req)) {
				if (key.startsWith('_') || TRANSPORT_ONLY_FIELDS.has(key)) continue;
				fields[key] = value;
			}
			const multipart = buildMultipartBody(
				fields,
				packageStream
					? { name: 'payload', filename: 'package.tar.gz', contentType: 'application/gzip', stream: packageStream }
					: undefined
			);
			options.headers['Content-Type'] = multipart.contentType;
			// Use chunked transfer-encoding: we don't know the total size up front because the
			// payload is streamed from `tar.pack` and never fully buffered.
			options.headers['Transfer-Encoding'] = 'chunked';
			// Tap the body so bytes flowing into the HTTP request advance the upload bar.
			// The renderer's Transform is identity — chunks pass through unmodified.
			body = renderer ? renderer.tapUploadStream(multipart.stream) : multipart.stream;
		} else {
			body = req;
		}
		let response: any = await httpRequest(options, body);

		// Upload is done by the time we get the response; tear the bar down before any SSE
		// rendering so the bar and event lines don't fight for the same terminal row.
		renderer?.endUpload();

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
		if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
			console.error(`error: Failed to connect to Harper (${err.code}): ${err.message}`);
		} else if (err.code === 'EACCES') {
			console.error(`error: Permission denied accessing the domain socket: ${err.message}`);
		} else if (err.code === 'ENOTFOUND') {
			console.error(`error: Host not found: "${err.hostname}" ${err.message}`);
		} else {
			console.error(`error: ${err.message ?? err}`);
		}
		process.exit(1);
	}
}
