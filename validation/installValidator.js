'use strict';

const Joi = require('joi');
const { boolean, string, number } = Joi.types();
const fs = require('fs-extra');
const hdb_terms = require('../utility/hdbTerms');
const path = require('path');
const validator = require('../validation/validationWrapper');

module.exports = installValidator;

/**
 * Used to validate any command or environment variables used passed to install.
 * @param param
 * @returns {*}
 */
function installValidator(param) {
	const nats_term_constraints = string
		.pattern(/^[^\s.,*>]+$/)
		.messages({ 'string.pattern.base': '{:#label} invalid, must not contain ., * or >' })
		.empty(null);

	const install_schema = Joi.object({
		[hdb_terms.INSTALL_PROMPTS.ROOTPATH]: Joi.custom(validateRootAvailable),
		[hdb_terms.INSTALL_PROMPTS.OPERATIONSAPI_NETWORK_PORT]: Joi.alternatives([number.min(0), string]).allow(
			'null',
			null
		),
		[hdb_terms.INSTALL_PROMPTS.TC_AGREEMENT]: string.valid('yes', 'YES', 'Yes'),
		[hdb_terms.INSTALL_PROMPTS.CLUSTERING_NODENAME]: nats_term_constraints,
		[hdb_terms.INSTALL_PROMPTS.CLUSTERING_ENABLED]: boolean,
	});

	return validator.validateBySchema(param, install_schema);
}

function validateRootAvailable(value, helpers) {
	if (
		fs.existsSync(path.join(value, 'system/hdb_user/data.mdb')) ||
		fs.existsSync(path.join(value, 'system/hdb_user.mdb'))
	) {
		return helpers.message(`'${value}' is already in use. Please enter a different path.`);
	}
}
