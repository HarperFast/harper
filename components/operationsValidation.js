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
// Trailing `=` padding is tolerated — some browser encoders emit padded base64url, and Node's
// base64url decoder accepts either form.
const SECRET_ENVELOPE_REGEX = new RegExp(`^${ENV_ENCRYPTED_PREFIX}[A-Za-z0-9_-]+={0,2}$`);

// Size cap for secret values and envelopes: rows live forever in a replicated, audited system
// table, so unbounded payloads are a storage/replication hazard, not a feature.
const SECRET_MAX_LENGTH = 256 * 1024;

/**
 * Validate set_secret requests: `name` plus exactly one of `value` (plaintext) or `envelope`
 * (`enc:v1:` ciphertext), with optional `metadata`, and a tier of either `processEnv` or `grants`
 * (the handler rejects the two together — a processEnv secret is global, so scoping it is meaningless).
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
		// process.env delivery tier; mutually exclusive with grants (enforced in the handler so the
		// check also covers a grants add against an already-processEnv stored row).
		processEnv: Joi.boolean(),
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

// An npm registry-auth credential entry, identified by its `registry` key. `host` is forbidden
// rather than merely unused: operation validation allows unknown keys, so without this an entry
// carrying both discriminators would validate as npm registry auth and its git half would be
// silently dropped.
const REGISTRY_CREDENTIAL_ENTRY = Joi.object({
	host: Joi.any().forbidden().messages({
		'any.unknown': `a credential entry is either npm registry auth ('registry') or git host auth ('host'), not both`,
	}),
	// registry and token are written verbatim into the transient .npmrc, which is line-based;
	// forbid CR/LF so a super_user can't inject extra npm config lines. (registry also accepts
	// bare hosts and //host/ forms, so a strict URI validator would reject supported inputs — the
	// newline guard is the right scope here.)
	registry: Joi.string()
		.pattern(/^[^\r\n]+$/)
		.required(),
	token: Joi.string().pattern(/^[^\r\n]+$/),
	// A reference into the hdb_secret store; same name grammar as set_secret's `name`.
	secret: Joi.string()
		.pattern(ENV_KEY_REGEX)
		.messages({ 'string.pattern.base': `'secret' must only contain word characters, dots and dashes` }),
	scope: Joi.string()
		.pattern(/^@[a-z0-9-_.]+$/)
		.optional(),
})
	.xor('token', 'secret')
	// The whole operation validates with allowUnknown, but a credential entry must not: an unknown
	// key here (a typo'd or future secret-bearing field like `password`) would pass through ingest
	// unchanged and be persisted to config/hdb_deployment and replicated, defeating reference-only.
	.unknown(false);

// A git-host credential entry, identified by its `host` key (#1792). Used to authenticate the
// `git clone`/`git ls-remote` npm runs for a git-reference `package` (e.g. `github:org/repo`); the
// token is served to git from memory, never written to a file or a URL.
const GIT_CREDENTIAL_ENTRY = Joi.object({
	// A bare host, optionally with a port — `github.com`, `git.example.com:8443`. A scheme or path is
	// tolerated and normalized away, but a credential is matched by host, so keep the grammar tight.
	host: Joi.string()
		.pattern(/^[^\s/@\\]+$/)
		.required()
		.messages({ 'string.pattern.base': `'host' must be a bare git host, e.g. 'github.com'` }),
	// The username half of git's HTTPS basic auth. Defaults to GitHub's `x-access-token` convention;
	// GitLab wants `oauth2` and Bitbucket `x-token-auth`.
	username: Joi.string()
		.pattern(/^[^\r\n:]+$/)
		.optional(),
	token: Joi.string().pattern(/^[^\r\n]+$/),
	secret: Joi.string()
		.pattern(ENV_KEY_REGEX)
		.messages({ 'string.pattern.base': `'secret' must only contain word characters, dots and dashes` }),
	// `registry` forbidden for symmetry with the npm entry: an entry carrying both discriminators has
	// no single kind and must be rejected, not silently treated as git auth.
	registry: Joi.any().forbidden().messages({
		'any.unknown': `a credential entry is either npm registry auth ('registry') or git host auth ('host'), not both`,
	}),
})
	.xor('token', 'secret')
	.unknown(false);

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
		// Deploy credentials. The array is kind-heterogeneous: an entry's kind is implied by its
		// identifying key rather than a separate discriminator field, so a new kind is added as
		// another item alternative here without reshaping the field. Today: npm registry auth
		// (`registry`) and git host auth for a git-reference package (`host`, #1792).
		//
		// Every kind supplies its credential exactly one of two ways:
		//   - `token`: a literal token, used only for this node's install and never persisted or
		//     replicated (stripped from req before replicateOperation).
		//   - `secret`: the name of an hdb_secret row (#1550); the token is resolved by decrypting
		//     that row on this node at deploy time, so the credential lives in the secrets store
		//     (reference, not embed) instead of travelling in the operation body.
		// Dispatched on the presence of `registry` rather than tried as alternatives, so a malformed
		// entry reports what is actually wrong with it (a newline in the token, an invalid scope) rather
		// than a generic "no alternative matched".
		credentials: Joi.array()
			.items(
				Joi.alternatives().conditional('.registry', {
					is: Joi.exist(),
					then: REGISTRY_CREDENTIAL_ENTRY,
					otherwise: GIT_CREDENTIAL_ENTRY,
				})
			)
			.optional(),
		// `registryAuth` was this field's name on the 5.2 dev line before it grew to carry other
		// credential kinds. Rejected rather than ignored: validation allows unknown keys, so a caller
		// still sending it would otherwise get a deploy that silently installs with no credentials.
		registryAuth: Joi.any().forbidden().messages({
			'any.unknown': `'registryAuth' has been renamed to 'credentials'`,
		}),
	}).with('urlPath', 'package');

	return validator.validateBySchema(req, deployProjSchema);
}
