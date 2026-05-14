'use strict';

const envMgr = require('../utility/environment/environmentManager.js');
envMgr.initSync();
const terms = require('../utility/hdbTerms.ts');
const { httpRequest } = require('../utility/common_utils.js');
const path = require('path');
const fs = require('fs-extra');
const YAML = require('yaml');
const { streamPackagedDirectory } = require('../components/packageComponent.ts');
const { buildMultipartBody } = require('./multipartBuilder.ts');
const { parseSSE, renderDeployProgress } = require('./sseConsumer.ts');
const { getHdbPid } = require('../utility/processManagement/processManagement.js');
const { initConfig, getConfigPath } = require('../config/configUtils.js');

const OP_ALIASES = { deploy: 'deploy_component', package: 'package_component' };

// Operations whose responses should be consumed as text/event-stream so live phase events
// (extract, install, load, replicate, restart) render as they happen instead of after the
// whole deploy completes. Add an operation here only after wiring its server-side
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

module.exports = { cliOperations, buildRequest };
const PREPARE_OPERATION = {
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
function buildRequest() {
	const req = {};
	for (const arg of process.argv.slice(2)) {
		if (OP_ALIASES.hasOwnProperty(arg)) {
			req.operation = OP_ALIASES[arg];
		} else if (arg.includes('=')) {
			let [first, ...rest] = arg.split('=');
			rest = rest.join('=');

			try {
				rest = JSON.parse(rest);
			} catch {
				/* noop */
			}

			req[first] = rest;
		} else {
			// operation should only be in the first arg
			req.operation ??= arg;
		}
	}

	return req;
}

/**
 * Using a unix domain socket will send a request to hdb operations API server
 * @param req
 * @returns {Promise<void>}
 */
async function cliOperations(req) {
	if (!req.target) {
		req.target = process.env.HARPER_CLI_TARGET || process.env.CLI_TARGET;
	}
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
		target = {
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port,
			username: req.username || target.username || process.env.HARPER_CLI_USERNAME || process.env.CLI_TARGET_USERNAME,
			password: req.password || target.password || process.env.HARPER_CLI_PASSWORD || process.env.CLI_TARGET_PASSWORD,
			rejectUnauthorized: req.rejectUnauthorized,
		};
		console.error(`Connecting to ${target.protocol}//${target.hostname}:${target.port}`);
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
		}
		const useSse = SSE_OPERATIONS.has(req.operation);
		if (useSse) {
			options.headers.Accept = 'text/event-stream';
			options.streamResponse = true;
		}
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
			body = multipart.stream;
		} else {
			body = req;
		}
		let response = await httpRequest(options, body);

		let responseData;
		if (useSse && response.headers['content-type']?.startsWith('text/event-stream')) {
			// Consume SSE: render phase events live, capture the final result from the `done`
			// event (or the error message from the `error` event). The HTTP status stays 200
			// until end-of-stream; failures are signaled in-band.
			const state = {};
			let finalResult;
			let sseError;
			for await (const message of parseSSE(response)) {
				renderDeployProgress(message, state, process.stderr);
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
				console.error(`error: ${sseError.message ?? sseError}`);
				process.exit(1);
			}
			responseData = finalResult ?? { message: 'Deploy completed (no result payload).' };
		} else {
			try {
				responseData = JSON.parse(response.body);
			} catch {
				responseData = {
					status: response.statusCode + ' ' + (response.statusMessage || 'Unknown'),
					body: response.body,
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

		console.log(responseLog);

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
