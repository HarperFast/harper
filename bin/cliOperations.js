'use strict';

const env_mgr = require('../utility/environment/environmentManager');
env_mgr.initSync();
const terms = require('../utility/hdbTerms');
const { httpRequest } = require('../utility/common_utils');
const path = require('path');
const fs = require('fs-extra');
const YAML = require('yaml');
const { packageDirectory } = require('../components/packageComponent');
const { encode } = require('cbor-x');

const SUPPORTED_OPS = [
	'describe_table',
	'describe_all',
	'describe_database',
	'list_users',
	'list_roles',
	'drop_role',
	'add_user',
	'alter_user',
	'drop_user',
	'restart_service',
	'restart',
	'create_database',
	'drop_database',
	'create_table',
	'drop_table',
	'create_attribute',
	'drop_attribute',
	'search_by_id',
	'insert',
	'update',
	'upsert',
	'delete',
	'search_by_value',
	'csv_file_load',
	'csv_url_load',
	'cluster_get_routes',
	'cluster_network',
	'cluster_status',
	'remove_node',
	'add_component',
	'deploy_component',
	'package_component',
	'drop_component',
	'get_components',
	'get_component_file',
	'set_component_file',
	'registration_info',
	'get_fingerprint',
	'set_license',
	'get_job',
	'search_jobs_by_start_date',
	'read_log',
	'read_transaction_log',
	'read_audit_log',
	'delete_transaction_logs_before',
	'purge_stream',
	'delete_records_before',
	'install_node_modules',
	'set_configuration',
	'get_configuration',
	'create_authentication_tokens',
	'refresh_operation_token',
	'system_information',
	'sql',
	'create_csr',
	'sign_certificate',
	'list_certificates',
	'add_certificate',
	'remove_certificate',
	'add_ssh_key',
	'update_ssh_key',
	'delete_ssh_key',
	'list_ssh_keys',
	'set_ssh_known_hosts',
	'get_ssh_known_hosts',
];

const OP_ALIASES = { deploy: 'deploy_component', package: 'package_component' };

module.exports = { cliOperations, buildRequest };
const PREPARE_OPERATION = {
	deploy_component: async (req) => {
		const project_path = process.cwd();
		req.payload = await packageDirectory(project_path, { skip_node_modules: true, ...req });
		req.cborEncode = true;
		if (!req.project) req.project = path.basename(project_path);
	},
};

/**
 * Builds an Op-API request object from CLI args
 */
function buildRequest() {
	const req = {};
	for (const arg of process.argv.slice(2)) {
		if (SUPPORTED_OPS.includes(arg)) {
			req.operation = arg;
		} else if (OP_ALIASES.hasOwnProperty(arg)) {
			req.operation = OP_ALIASES[arg];
		} else if (arg.includes('=')) {
			let [first, ...rest] = arg.split('=');
			rest = rest.join('=');

			try {
				rest = JSON.parse(rest);
				// eslint-disable-next-line sonarjs/no-ignored-exceptions
			} catch (e) {
				/* noop */
			}

			req[first] = rest;
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
		target = new URL(req.target);
		target = {
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port,
			username: req.username || target.username || process.env.CLI_TARGET_USERNAME,
			password: req.password || target.password || process.env.CLI_TARGET_PASSWORD,
			rejectUnauthorized: req.rejectUnauthorized,
		};
	} else {
		if (!fs.existsSync(path.join(env_mgr.get(terms.CONFIG_PARAMS.ROOTPATH), terms.HDB_PID_FILE))) {
			console.error('HarperDB must be running to perform this operation');
			process.exit();
		}

		if (!fs.existsSync(env_mgr.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET))) {
			console.error('No domain socket found, unable to perform this operation');
			process.exit();
		}
	}
	await PREPARE_OPERATION[req.operation]?.(req);
	try {
		let options = target ?? {
			protocol: 'http:',
			socketPath: env_mgr.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET),
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
		let res = await httpRequest(options, req);

		res = JSON.parse(res.body);

		if (req.json) {
			console.log(JSON.stringify(res, null, 2));
		} else {
			console.log(YAML.stringify(res).trim());
		}
	} catch (err) {
		let err_msg = 'Error: ';
		if (err?.response?.data?.error) {
			err_msg += err.response.data.error;
		} else if (err?.response?.data) {
			err_msg += err?.response?.data;
		} else {
			err_msg += err.message;
		}
		console.error(err_msg);
	}
}
