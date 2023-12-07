'use strict';

const env_mgr = require('../utility/environment/environmentManager');
env_mgr.initSync();
const terms = require('../utility/hdbTerms');
const { httpRequest } = require('../utility/common_utils');
const path = require('path');
const fs = require('fs-extra');
const YAML = require('yaml');

const SUPPORTED_OPS = {
	describe_table: true,
	describe_all: true,
	describe_database: true,
	list_users: true,
	list_roles: true,
	drop_role: true,
	add_user: true,
	alter_user: true,
	drop_user: true,
	restart_service: true,
	restart: true,
	create_database: true,
	drop_database: true,
	create_table: true,
	drop_table: true,
	create_attribute: true,
	drop_attribute: true,
	search_by_id: true,
	delete: true,
	search_by_value: true,
	csv_file_load: true,
	csv_url_load: true,
	cluster_get_routes: true,
	cluster_network: true,
	cluster_status: true,
	remove_node: true,
	add_component: true,
	deploy_component: true,
	package_component: true,
	drop_component: true,
	get_components: true,
	get_component_file: true,
	set_component_file: true,
	registration_info: true,
	get_fingerprint: true,
	set_license: true,
	get_job: true,
	search_jobs_by_start_date: true,
	read_log: true,
	read_transaction_log: true,
	read_audit_log: true,
	delete_transaction_logs_before: true,
	purge_stream: true,
	delete_records_before: true,
	install_node_modules: true,
	set_configuration: true,
	get_configuration: true,
	create_authentication_tokens: true,
	refresh_operation_token: true,
	system_information: true,
	sql: true,
};

module.exports = { cliOperations, buildRequest };

/**
 * Builds an Op-API request object from CLI args
 * @returns {{}}
 */
function buildRequest() {
	const req = {};
	for (const arg of process.argv) {
		if (SUPPORTED_OPS[arg]) {
			req.operation = arg;
			continue;
		}

		if (arg.includes('=')) {
			let [first, ...rest] = arg.split('=');
			rest = rest.join('=');
			try {
				rest = JSON.parse(rest);
			} catch (e) {}

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
	if (!(await fs.exists(path.join(env_mgr.get(terms.CONFIG_PARAMS.ROOTPATH), terms.HDB_PID_FILE)))) {
		console.error('HarperDB must be running to perform this operation');
		process.exit();
	}

	if (!(await fs.exists(env_mgr.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET)))) {
		console.error('No domain socket found, unable to perform this operation');
		process.exit();
	}

	try {
		let res = await httpRequest(
			{
				method: 'POST',
				protocol: 'http:',
				socketPath: env_mgr.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET),
				headers: { 'Content-Type': 'application/json' },
			},
			req
		);

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
