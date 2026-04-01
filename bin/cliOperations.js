'use strict';

const envMgr = require('../utility/environment/environmentManager.js');
envMgr.initSync();
const terms = require('../utility/hdbTerms.ts');
const { httpRequest } = require('../utility/common_utils.js');
const path = require('path');
const fs = require('fs-extra');
const YAML = require('yaml');
const { packageDirectory } = require('../components/packageComponent.ts');
const { encode } = require('cbor-x');
const { getHdbPid } = require('../utility/processManagement/processManagement.js');
const { initConfig, getConfigPath } = require('../config/configUtils.js');

const OP_ALIASES = { deploy: 'deploy_component', package: 'package_component' };

module.exports = { cliOperations, buildRequest };
const PREPARE_OPERATION = {
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
		req.target = process.env.CLI_TARGET;
	}
	let target;
	if (req.target) {
		try {
			target = new URL(req.target);
		} catch (error) {
			try {
				target = new URL(`https://${req.target}:9925`);
			} catch {
				throw error; // throw the original error
			}
		}
		target = {
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port,
			username: req.username || target.username || process.env.CLI_TARGET_USERNAME,
			password: req.password || target.password || process.env.CLI_TARGET_PASSWORD,
			rejectUnauthorized: req.rejectUnauthorized,
		};
	} else {
		// if we aren't doing a targeted operation (like deploy), we initialize the config and verify that local harper
		// is running and that we can communicate with it.
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
		if (req.cborEncode) {
			options.headers['Content-Type'] = 'application/cbor';
			req = encode(req);
		}
		let response = await httpRequest(options, req);

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
