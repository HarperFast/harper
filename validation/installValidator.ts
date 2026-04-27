'use strict';

import Joi from 'joi';
const { string, number } = Joi.types();
import fs from 'fs-extra';
import * as hdbTerms from '../utility/hdbTerms.js';
import path from 'path';
import * as validator from '../validation/validationWrapper.js';

export default installValidator;

/**
 * Used to validate any command or environment variables used passed to install.
 * @param param
 * @returns {*}
 */
function installValidator(param: any): Error | undefined {
	const installSchema = Joi.object({
		[hdbTerms.INSTALL_PROMPTS.ROOTPATH]: Joi.custom(validateRootAvailable),
		[hdbTerms.INSTALL_PROMPTS.OPERATIONSAPI_NETWORK_PORT]: Joi.alternatives([number.min(0), string]).allow(
			'null',
			null
		),
		[hdbTerms.INSTALL_PROMPTS.TC_AGREEMENT]: string.valid('yes', 'YES', 'Yes'),
	});

	return validator.validateBySchema(param, installSchema);
}

function validateRootAvailable(value: string, helpers: Joi.CustomHelpers): any {
	if (
		fs.existsSync(path.join(value, 'system/hdb_user/data.mdb')) ||
		fs.existsSync(path.join(value, 'system/hdb_user.mdb'))
	) {
		return helpers.message(`'${value}' is already in use. Please enter a different path.`);
	}
}
