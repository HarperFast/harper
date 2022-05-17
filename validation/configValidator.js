'use strict';

const fs = require('fs-extra');
const Joi = require('joi');
const os = require('os');
const { boolean, string, number, array } = Joi.types();
const path = require('path');
const hdb_logger = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const certificates_terms = require('../utility/terms/certificates');

const DEFAULT_KEY_DIR = 'keys';
const DEFAULT_HDB_CERT = certificates_terms.CERTIFICATE_PEM_NAME;
const DEFAULT_HDB_PRIVATE_KEY = certificates_terms.PRIVATEKEY_PEM_NAME;
const DEFAULT_CF_CERT = certificates_terms.CERTIFICATE_PEM_NAME;
const DEFAULT_CF_PRIVATE_KEY = certificates_terms.PRIVATEKEY_PEM_NAME;
const DEFAULT_CLUSTERING_CERT = certificates_terms.CERTIFICATE_PEM_NAME;
const DEFAULT_CLUSTERING_PRIVATE_KEY = certificates_terms.PRIVATEKEY_PEM_NAME;
const DEFAULT_CLUSTERING_CERT_AUTH = certificates_terms.CA_PEM_NAME;
const DEFAULT_LOG_FOLDER = 'log';
const DEFAULT_CUSTOM_FUNCTIONS_FOLDER = 'custom_functions';
const DEFAULT_CORES_IF_ERR = 4;
const INVALID_SIZE_UNIT_MSG = 'Invalid logging.rotation.maxSize unit. Available units are G, M or K';
const INVALID_MAX_SIZE_VALUE_MSG =
	"Invalid logging.rotation.maxSize value. Value should be a number followed by unit e.g. '10M'";
const UNDEFINED_OPS_API = 'operationsApi.root config parameter is undefined';
const UNDEFINED_NATS_ENABLED = 'clustering.enabled config parameter is undefined';

let hdb_root;

module.exports = configValidator;

function configValidator(config_json) {
	hdb_root = config_json.operationsApi?.root;
	if (hdb_utils.isEmpty(hdb_root)) {
		throw UNDEFINED_OPS_API;
	}

	const enabled_constraints = boolean.required();
	const port_constraints = number.min(0).required();
	const node_env_constraints = Joi.valid('production', 'development').required();
	const processes_constraints = number.min(1).max(1000).empty(null).default(setDefaultProcesses);
	const root_constraints = string
		.pattern(/^\/$|(\/[a-zA-Z_0-9-]+)+$/, 'unix directory path')
		.empty(null)
		.default(setDefaultRoot);
	const pem_file_constraints = Joi.custom(validatePemFile)
		.messages({ 'any.custom': '{:#label} {:#error}' })
		.empty(null)
		.default(setDefaultRoot);
	const nats_term_constraints = string
		.pattern(/^[^\s.,*>]+$/)
		.messages({ 'string.pattern.base': '{:#label} invalid, must not contain ., * or >' })
		.empty(null);

	const clustering_enabled = config_json.clustering?.enabled;
	if (hdb_utils.isEmpty(clustering_enabled)) {
		throw UNDEFINED_NATS_ENABLED;
	}

	// If clustering is enabled validate clustering config
	let clustering_validation_schema;
	if (clustering_enabled === true) {
		clustering_validation_schema = Joi.object({
			enabled: enabled_constraints,
			hubServer: Joi.object({
				cluster: Joi.object({
					name: Joi.required().empty(null),
					network: Joi.object({
						port: port_constraints,
						routes: array
							.items({
								ip: string
									.ip({ version: ['ipv4', 'ipv6'] })
									.messages({
										'string.ipVersion': '{:#label} invalid IP address',
										'string.ip': '{:#label} invalid IP address',
									})
									.required(),
								port: port_constraints,
							})
							.empty(null),
					}).required(),
				}).required(),
				leafNodes: Joi.object({
					network: Joi.object({
						port: port_constraints,
					}).required(),
				}).required(),
				network: Joi.object({
					port: port_constraints,
				}).required(),
			}).required(),
			ingestService: Joi.object({
				processes: number.min(1).max(1000),
			}).required(),
			leafServer: Joi.object({
				network: Joi.object({
					port: port_constraints,
				}).required(),
			}).required(),
			nodeName: nats_term_constraints,
			replyService: Joi.object({
				processes: number.min(1).max(1000),
			}).required(),
			tls: Joi.object({
				certificate: pem_file_constraints,
				certificateAuthority: Joi.required(),
				privateKey: pem_file_constraints,
			}),
			user: Joi.string().required(),
		}).required();
	} else {
		clustering_validation_schema = Joi.object({
			enabled: enabled_constraints,
		}).required();
	}

	const config_schema = Joi.object({
		clustering: clustering_validation_schema,
		customFunctions: Joi.object({
			enabled: enabled_constraints,
			network: Joi.object({
				cors: boolean.required(),
				corsWhitelist: array.required(),
				headersTimeout: number.min(1).required(),
				https: boolean.required(),
				keepAliveTimeout: number.min(1).required(),
				port: port_constraints,
				timeout: number.min(1).required(),
			}),
			nodeEnv: node_env_constraints,
			processes: processes_constraints,
			root: root_constraints,
			tls: Joi.object({
				certificate: pem_file_constraints,
				certificateAuthority: Joi.required(),
				privateKey: pem_file_constraints,
			}),
		}).required(),
		ipc: Joi.object({
			network: Joi.object({
				port: port_constraints,
			}),
		}).required(),
		localStudio: Joi.object({
			enabled: enabled_constraints,
		}).required(),
		logging: Joi.object({
			file: boolean.required(),
			level: Joi.valid('notify', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'),
			rotation: Joi.object({
				compress: boolean.required(),
				dateFormat: string.required(),
				maxSize: string.custom(validateRotationMaxSize).required(),
				retain: number.min(0).required(),
				rotate: boolean.required(),
				rotateInterval: string.required(),
				rotateModule: boolean.required(),
				timezone: string.required(),
				workerInterval: number.min(1).required(),
			}).required(),
			root: root_constraints,
			stdStreams: boolean.required(),
			auditLog: boolean.required(),
		}).required(),
		operationsApi: Joi.object({
			authentication: Joi.object({
				operationTokenTimeout: Joi.required(),
				refreshTokenTimeout: Joi.required(),
			}).required(),
			foreground: boolean.required(),
			network: Joi.object({
				cors: boolean.required(),
				corsWhitelist: array.required(),
				headersTimeout: number.min(1).required(),
				https: boolean.required(),
				keepAliveTimeout: number.min(1).required(),
				port: port_constraints,
				timeout: number.min(1).required(),
			}).required(),
			nodeEnv: node_env_constraints,
			processes: processes_constraints,
			root: string.pattern(/^\/$|(\/[a-zA-Z_0-9-]+)+$/, 'unix directory path').required(),
			storage: Joi.object({
				writeAsync: boolean.required(),
			}).required(),
			tls: Joi.object({
				certificate: pem_file_constraints,
				certificateAuthority: Joi.required(),
				privateKey: pem_file_constraints,
			}),
		}).required(),
	});

	// Not using the validation wrapper here because we need the result if validation is successful because
	// there is default values set as part of validation.
	return config_schema.validate(config_json, {
		allowUnknown: true,
		abortEarly: false,
		errors: { wrap: { label: "'" } },
	});
}

// This function is used to validate existence of paths passed as an argument
function doesPathExist(path_to_check) {
	let exists = fs.existsSync(path_to_check);
	if (exists) {
		return null;
	}

	return `Specified path ${path_to_check} does not exist.`;
}

function validatePemFile(value, helpers) {
	Joi.assert(
		value,
		string
			.pattern(/^((?!.*\/\/.*)(?!.*\/ .*)\/([^\\(){}:<>])+\.(pem))$/)
			.messages({ 'string.pattern.base': 'must be a valid unix directory path and specify a .pem file' })
	);

	const does_exist_msg = doesPathExist(value);
	if (does_exist_msg) {
		return helpers.message(does_exist_msg);
	}
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
}

function setDefaultProcesses(parent, helpers) {
	const config_param = helpers.state.path.join('.');
	try {
		const num_processes = os.cpus().length;
		hdb_logger.info(`Detected ${num_processes} cores on this machine, defaulting ${config_param} to this value`);

		return num_processes;
	} catch (err) {
		hdb_logger.info(
			`Error detecting number of cores on machine for ${config_param}, defaulting to ${DEFAULT_CORES_IF_ERR}`
		);
		return DEFAULT_CORES_IF_ERR;
	}
}

/**
 * Sets a default root for a config param.
 * @param parent
 * @param helpers
 * @returns {string}
 */
function setDefaultRoot(parent, helpers) {
	const config_param = helpers.state.path.join('.');
	if (hdb_utils.isEmpty(hdb_root)) {
		throw new Error(`Error setting default root for: ${config_param}. HDB root is not defined`);
	}

	switch (config_param) {
		case 'customFunctions.root':
			return path.join(hdb_root, DEFAULT_CUSTOM_FUNCTIONS_FOLDER);
		case 'logging.root':
			return path.join(hdb_root, DEFAULT_LOG_FOLDER);
		case 'operationsApi.tls.certificate':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_HDB_CERT);
		case 'operationsApi.tls.privateKey':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_HDB_PRIVATE_KEY);
		case 'customFunctions.tls.certificate':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_CF_CERT);
		case 'customFunctions.tls.privateKey':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_CF_PRIVATE_KEY);
		case 'clustering.tls.certificate':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_CLUSTERING_CERT);
		case 'clustering.tls.privateKey':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_CLUSTERING_PRIVATE_KEY);
		case 'clustering.tls.certificateAuthority':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_CLUSTERING_CERT_AUTH);
		default:
			throw new Error(
				`Error setting default root for config parameter: ${config_param}. Unrecognized config parameter`
			);
	}
}
