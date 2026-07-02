'use strict';

const Joi = require('joi');
const fs = require('fs-extra');
const path = require('path');
const validator = require('../validation/validationWrapper.ts');
const hdbTerms = require('../utility/hdbTerms.ts');
const hdbLogger = require('../utility/logging/harper_logger.ts');
const configUtils = require('../config/configUtils.ts');
const { hdbErrors } = require('../utility/errors/hdbError.ts');
const { HDB_ERROR_MSGS } = hdbErrors;
const { ENV_ENCRYPTED_PREFIX } = require('../utility/envFile.ts');

// File name can only be alphanumeric, dash and underscores
const PROJECT_FILE_NAME_REGEX = /^[a-zA-Z0-9-_]+$/;

// dotenv's accepted key character set. Restricting keys to this prevents a crafted key (e.g. one
// containing `=` or a newline) from injecting extra assignments into a .env file.
const ENV_KEY_REGEX = /^[\w.-]+$/;

module.exports = {
	getDropCustomFunctionValidator,
	setCustomFunctionValidator,
	addComponentValidator,
	dropCustomFunctionProjectValidator,
	packageComponentValidator,
	deployComponentValidator,
	setComponentFileValidator,
	getComponentFileValidator,
	dropComponentFileValidator,
	getEnvKeysValidator,
	setEnvValueValidator,
	deleteEnvValueValidator,
	setSecretValidator,
	grantSecretValidator,
	deleteSecretValidator,
};

/**
 * Check to see if a project dir exists in the custom functions dir.
 * @param checkExists - determine if validator returns error if exists or vice versa
 * @param project
 * @param helpers
 * @returns {*}
 */
function checkProjectExists(checkExists, project, helpers) {
	try {
		const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
		const projectDir = path.join(cfDir, project);

		if (!fs.existsSync(projectDir)) {
			if (checkExists) {
				return helpers.message(HDB_ERROR_MSGS.NO_PROJECT);
			}

			return project;
		}

		if (checkExists) {
			return project;
		}

		return helpers.message(HDB_ERROR_MSGS.PROJECT_EXISTS);
	} catch (err) {
		hdbLogger.error(err);
		return helpers.message(HDB_ERROR_MSGS.VALIDATION_ERR);
	}
}

function checkFilePath(path, helpers) {
	if (path.includes('..')) return helpers.message('Invalid file path');
	return path;
}

/**
 * Check the custom functions dir to see if a file exists.
 * @param project
 * @param type
 * @param file
 * @param helpers
 * @returns {*}
 */
function checkFileExists(project, type, file, helpers) {
	try {
		const cfDir = configUtils.getConfigPath(hdbTerms.CONFIG_PARAMS.COMPONENTSROOT);
		const filePath = path.join(cfDir, project, type, file + '.js');
		if (!fs.existsSync(filePath)) {
			return helpers.message(HDB_ERROR_MSGS.NO_FILE);
		}

		return file;
	} catch (err) {
		hdbLogger.error(err);
		return helpers.message(HDB_ERROR_MSGS.VALIDATION_ERR);
	}
}

/**
 * Used to validate getCustomFunction and dropCustomFunction
 * @param req
 * @returns {*}
 */
function getDropCustomFunctionValidator(req) {
	const getFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, true))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		type: Joi.string().valid('helpers', 'routes').required(),
		file: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkFileExists.bind(null, req.project, req.type))
			.custom(checkFilePath)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_FILE_NAME }),
	});

	return validator.validateBySchema(req, getFuncSchema);
}

/**
 * Validate setCustomFunction requests.
 * @param req
 * @returns {*}
 */
function setCustomFunctionValidator(req) {
	const setFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, true))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		type: Joi.string().valid('helpers', 'routes').required(),
		file: Joi.string().custom(checkFilePath).required(),
		function_content: Joi.string().required(),
	});

	return validator.validateBySchema(req, setFuncSchema);
}

/**
 * Validate set_component_file requests.
 * @param req
 * @returns {*}
 */
function setComponentFileValidator(req) {
	const setCompSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		file: Joi.string().custom(checkFilePath).required(),
		payload: Joi.string().allow('').optional(),
		encoding: Joi.string().valid('utf8', 'ASCII', 'binary', 'hex', 'base64', 'utf16le', 'latin1', 'ucs2').optional(),
	});

	return validator.validateBySchema(req, setCompSchema);
}

function dropComponentFileValidator(req) {
	const dropCompSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		file: Joi.string().custom(checkFilePath).optional(),
	});

	return validator.validateBySchema(req, dropCompSchema);
}

function getComponentFileValidator(req) {
	const getCompSchema = Joi.object({
		project: Joi.string().required(),
		file: Joi.string().custom(checkFilePath).required(),
		encoding: Joi.string().valid('utf8', 'ASCII', 'binary', 'hex', 'base64', 'utf16le', 'latin1', 'ucs2').optional(),
	});

	return validator.validateBySchema(req, getCompSchema);
}

/**
 * Validate get_env_keys requests. `file` is optional and defaults to `.env` in the handler.
 * @param req
 * @returns {*}
 */
function getEnvKeysValidator(req) {
	const schema = Joi.object({
		// Patterned like the env writers (not the looser getComponentFile) so a `project` containing
		// `..` can't traverse out of the components root when joined in resolveEnvFilePath.
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		file: Joi.string().custom(checkFilePath).optional(),
	});

	return validator.validateBySchema(req, schema);
}

/**
 * Validate set_env_value requests: exactly one of (`key` + `value`) or `values` (a key→value map).
 * @param req
 * @returns {*}
 */
function setEnvValueValidator(req) {
	const schema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		file: Joi.string().custom(checkFilePath).optional(),
		key: Joi.string().pattern(ENV_KEY_REGEX),
		value: Joi.string().allow(''),
		// `.unknown(false)` rejects keys that don't match ENV_KEY_REGEX. Without it the schema-wide
		// `allowUnknown: true` (see validateBySchema) would let an invalid key (e.g. with a space or
		// newline) pass through unvalidated and corrupt the file.
		values: Joi.object().pattern(ENV_KEY_REGEX, Joi.string().allow('')).unknown(false),
	})
		.with('key', 'value')
		.with('value', 'key')
		.xor('key', 'values');

	return validator.validateBySchema(req, schema);
}

/**
 * Validate delete_env_value requests: exactly one of `key` or `keys` (an array of key names).
 * @param req
 * @returns {*}
 */
function deleteEnvValueValidator(req) {
	const schema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		file: Joi.string().custom(checkFilePath).optional(),
		key: Joi.string().pattern(ENV_KEY_REGEX),
		keys: Joi.array().items(Joi.string().pattern(ENV_KEY_REGEX)).min(1),
	}).xor('key', 'keys');

	return validator.validateBySchema(req, schema);
}

// A secret name doubles as an env key when materialized, so it is held to the same character set.
const SECRET_NAME = Joi.string()
	.pattern(ENV_KEY_REGEX)
	.required()
	.messages({ 'string.pattern.base': `'name' must only contain word characters, dots and dashes` });

// The encrypted-value marker followed by a base64url envelope body (structural validation of the
// decoded JSON happens in the handler via parseEnvelopeFields). Derived from the shared prefix
// constant so validator and handler can't drift; the prefix contains no regex metacharacters.
const SECRET_ENVELOPE_REGEX = new RegExp(`^${ENV_ENCRYPTED_PREFIX}[A-Za-z0-9_-]+$`);

// Size cap for secret values and envelopes: rows live forever in a replicated, audited system
// table, so unbounded payloads are a storage/replication hazard, not a feature.
const SECRET_MAX_LENGTH = 256 * 1024;

/**
 * Validate set_secret requests: `name` plus exactly one of `value` (plaintext) or `envelope`
 * (`enc:v1:` ciphertext), with optional `metadata` and `grants`.
 * @param req
 * @returns {*}
 */
function setSecretValidator(req) {
	const schema = Joi.object({
		name: SECRET_NAME,
		value: Joi.string().allow('').max(SECRET_MAX_LENGTH),
		envelope: Joi.string()
			.max(SECRET_MAX_LENGTH)
			.pattern(SECRET_ENVELOPE_REGEX)
			.messages({ 'string.pattern.base': `'envelope' must be an '${ENV_ENCRYPTED_PREFIX}' base64url envelope` }),
		// Modest structural caps: metadata is a small free-form label object, not a payload store,
		// and grants is a set (explicit duplicates rejected here; write paths also dedupe dirty state).
		metadata: Joi.object().max(100),
		grants: Joi.array().items(Joi.string().min(1)).max(100).unique(),
	}).xor('value', 'envelope');

	return validator.validateBySchema(req, schema);
}

/**
 * Validate grant_secret / revoke_secret requests (same shape: `name` + `component`).
 * @param req
 * @returns {*}
 */
function grantSecretValidator(req) {
	const schema = Joi.object({
		name: SECRET_NAME,
		component: Joi.string().min(1).required(),
	});

	return validator.validateBySchema(req, schema);
}

/**
 * Validate delete_secret requests.
 * @param req
 * @returns {*}
 */
function deleteSecretValidator(req) {
	const schema = Joi.object({
		name: SECRET_NAME,
	});

	return validator.validateBySchema(req, schema);
}

/**
 * Validate addCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function addComponentValidator(req) {
	const addFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, false))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		template: Joi.string().optional(),
		install_command: Joi.string().optional(),
		install_timeout: Joi.number().optional(),
		install_allow_scripts: Joi.boolean().optional(),
	});

	return validator.validateBySchema(req, addFuncSchema);
}

/**
 * Validate dropCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function dropCustomFunctionProjectValidator(req) {
	const dropFuncSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.custom(checkProjectExists.bind(null, true))
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
	});

	return validator.validateBySchema(req, dropFuncSchema);
}

/**
 * Validate packageCustomFunctionProject requests.
 * @param req
 * @returns {*}
 */
function packageComponentValidator(req) {
	const packageProjSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		skip_node_modules: Joi.boolean(),
		skip_symlinks: Joi.boolean(),
	});

	return validator.validateBySchema(req, packageProjSchema);
}

/**
 * Validate deployComponent requests.
 * @param req
 * @returns {*}
 */
function deployComponentValidator(req) {
	const deployProjSchema = Joi.object({
		project: Joi.string()
			.pattern(PROJECT_FILE_NAME_REGEX)
			.required()
			.messages({ 'string.pattern.base': HDB_ERROR_MSGS.BAD_PROJECT_NAME }),
		package: Joi.string().optional(),
		restart: Joi.alternatives().try(Joi.boolean(), Joi.string().valid('rolling')).optional(),
		install_command: Joi.string().optional(),
		install_timeout: Joi.number().optional(),
		install_allow_scripts: Joi.boolean().optional(),
		deployment_timeout: Joi.number().min(0).optional(),
		force: Joi.boolean().optional(),
		ignore_replication_errors: Joi.boolean().optional(),
		urlPath: Joi.string()
			.min(1)
			.custom((value, helpers) => {
				if (value.includes('..')) return helpers.error('any.invalid');
				return value;
			})
			.optional()
			.messages({ 'any.invalid': 'urlPath must not contain ".."' }),
	}).with('urlPath', 'package');

	return validator.validateBySchema(req, deployProjSchema);
}
