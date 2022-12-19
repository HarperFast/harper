'use strict';

const fs = require('fs-extra');
const Joi = require('joi');
const os = require('os');
const { boolean, string, number, array } = Joi.types();
const path = require('path');
const hdb_logger = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const certificates_terms = require('../utility/terms/certificates');
const validator = require('./validationWrapper');

const DEFAULT_KEY_DIR = 'keys';
const DEFAULT_HDB_CERT = certificates_terms.CERTIFICATE_PEM_NAME;
const DEFAULT_HDB_PRIVATE_KEY = certificates_terms.PRIVATEKEY_PEM_NAME;
const DEFAULT_HDB_CERT_AUTH = certificates_terms.CA_PEM_NAME;
const DEFAULT_CF_CERT = certificates_terms.CERTIFICATE_PEM_NAME;
const DEFAULT_CF_PRIVATE_KEY = certificates_terms.PRIVATEKEY_PEM_NAME;
const DEFAULT_CF_CERT_AUTH = certificates_terms.CA_PEM_NAME;
const DEFAULT_CLUSTERING_CERT = certificates_terms.CERTIFICATE_PEM_NAME;
const DEFAULT_CLUSTERING_PRIVATE_KEY = certificates_terms.PRIVATEKEY_PEM_NAME;
const DEFAULT_CLUSTERING_CERT_AUTH = certificates_terms.CA_PEM_NAME;
const DEFAULT_LOG_FOLDER = 'log';
const DEFAULT_CUSTOM_FUNCTIONS_FOLDER = 'custom_functions';
const DEFAULT_CORES_IF_ERR = 4;
const INVALID_SIZE_UNIT_MSG = 'Invalid logging.rotation.maxSize unit. Available units are G, M or K';
const INVALID_MAX_SIZE_VALUE_MSG =
	"Invalid logging.rotation.maxSize value. Value should be a number followed by unit e.g. '10M'";
const UNDEFINED_OPS_API = 'rootPath config parameter is undefined';
const UNDEFINED_NATS_ENABLED = 'clustering.enabled config parameter is undefined';

const port_constraints = number.min(0).required();
const route_constraints = array
	.items({
		host: string.required(),
		port: port_constraints,
	})
	.empty(null);

let hdb_root;

module.exports = {
	configValidator,
	routesValidator,
	route_constraints,
};

function configValidator(config_json) {
	hdb_root = config_json.rootPath;
	if (hdb_utils.isEmpty(hdb_root)) {
		throw UNDEFINED_OPS_API;
	}

	const enabled_constraints = boolean.required();
	const node_env_constraints = Joi.valid('production', 'development').required();
	const threads_constraints = number.min(1).max(1000).empty(null).default(setDefaultThreads);
	const root_constraints = string
		.pattern(/^[\\\/]$|([\\\/][a-zA-Z_0-9\:-]+)+$/, 'directory path')
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
						routes: route_constraints,
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
			leafServer: Joi.object({
				network: Joi.object({
					port: port_constraints,
					routes: route_constraints,
				}).required(),
				streams: Joi.object({
					// Max age must be above duplicate_window stream setting
					maxAge: number.min(120).allow(null).required(),
					maxBytes: number.min(1).allow(null).required(),
					maxMsgs: number.min(1).allow(null).required(),
				}).required(),
			}).required(),
			nodeName: nats_term_constraints,
			tls: Joi.object({
				certificate: pem_file_constraints,
				certificateAuthority: pem_file_constraints,
				privateKey: pem_file_constraints,
				insecure: boolean.required(),
			}),
			user: Joi.string().required(),
		}).required();
	} else {
		clustering_validation_schema = Joi.object({
			enabled: enabled_constraints,
			// tls needs to be here to set defaults if clustering disabled
			tls: Joi.object({
				certificate: pem_file_constraints,
				certificateAuthority: pem_file_constraints,
				privateKey: pem_file_constraints,
				insecure: boolean.required(),
			}),
		}).required();
	}

	const config_schema = Joi.object({
		clustering: clustering_validation_schema,
		customFunctions: Joi.object({
			enabled: enabled_constraints,
			network: Joi.object({
				cors: boolean.required(),
				corsAccessList: array.required(),
				headersTimeout: number.min(1).required(),
				https: boolean.required(),
				keepAliveTimeout: number.min(1).required(),
				port: port_constraints,
				timeout: number.min(1).required(),
			}),
			nodeEnv: node_env_constraints,
			root: root_constraints,
			tls: Joi.object({
				certificate: pem_file_constraints,
				certificateAuthority: pem_file_constraints,
				privateKey: pem_file_constraints,
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
				corsAccessList: array.required(),
				headersTimeout: number.min(1).required(),
				https: boolean.required(),
				keepAliveTimeout: number.min(1).required(),
				port: port_constraints,
				timeout: number.min(1).required(),
			}).required(),
			nodeEnv: node_env_constraints,
			tls: Joi.object({
				certificate: pem_file_constraints,
				certificateAuthority: pem_file_constraints,
				privateKey: pem_file_constraints,
			}),
		}).required(),
		rootPath: string.pattern(/^[\\\/]$|([\\\/][a-zA-Z_0-9\:-]+)+$/, 'directory path').required(),
		http: Joi.object({
			threads: threads_constraints,
		}).required(),
		storage: Joi.object({
			writeAsync: boolean.required(),
			overlappingSync: boolean.optional(),
			caching: boolean.optional(),
			compression: boolean.optional(),
			noReadAhead: boolean.optional(),
			prefetchWrites: boolean.optional(),
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
			.pattern(/^[\\\/]$|([\\\/][a-zA-Z_0-9\:-]+)+\.pem+$/)
			.messages({ 'string.pattern.base': 'must be a valid directory path and specify a .pem file' })
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

function setDefaultThreads(parent, helpers) {
	const config_param = helpers.state.path.join('.');
	let processors = os.cpus().length;
	// default to one less than the number of logical CPU/processors so we can have good concurrency with the
	// ingest process and any extra processes (jobs, reply, etc.).
	let num_processes = processors - 1;
	// But if only two processors, keep two processes so we have some level of concurrency fairness
	if (num_processes === 1 && processors === 2) num_processes = processors;
	hdb_logger.info(`Detected ${processors} cores on this machine, defaulting ${config_param} to ${num_processes}`);
	return num_processes;
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
	if (!hdb_utils.isEmpty(helpers.original)) {
		return helpers.original;
	}

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
		case 'operationsApi.tls.certificateAuthority':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_HDB_CERT_AUTH);
		case 'customFunctions.tls.certificate':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_CF_CERT);
		case 'customFunctions.tls.privateKey':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_CF_PRIVATE_KEY);
		case 'customFunctions.tls.certificateAuthority':
			return path.join(hdb_root, DEFAULT_KEY_DIR, DEFAULT_CF_CERT_AUTH);
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

/**
 * Validates just the routes array.
 * @param routes_array
 * @returns {*}
 */
function routesValidator(routes_array) {
	const schema = Joi.object({
		routes: route_constraints,
	});
	return validator.validateBySchema({ routes: routes_array }, schema);
}
