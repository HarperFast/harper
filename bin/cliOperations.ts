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
import { packageDirectory } from '../components/packageComponent.ts';
import { encode } from 'cbor-x';
import { getHdbPid } from '../utility/processManagement/processManagement.js';
import { initConfig, getConfigPath } from '../config/configUtils.js';

const OP_ALIASES = { deploy: 'deploy_component', package: 'package_component' };

export { cliOperations, buildRequest };
const PREPARE_OPERATION: any = {
	deploy_component: async (req) => {
		if (req.package) {
			return;
		}

		const projectPath = process.cwd();
		req.payload = await packageDirectory(projectPath, { skip_node_modules: true, ...req });
		req.cborEncode = true;
		if (!req.project) req.project = path.basename(projectPath);
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
		if (req.cborEncode) {
			options.headers['Content-Type'] = 'application/cbor';
			req = encode(req);
		}
		let response: any = await httpRequest(options, req);

		let responseData;
		try {
			responseData = JSON.parse(response.body);
		} catch {
			responseData = {
				status: response.statusCode + ' ' + (response.statusMessage || 'Unknown'),
				body: response.body,
			};
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
