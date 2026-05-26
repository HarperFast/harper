'use strict';

import Joi from 'joi';
const { string, number } = Joi.types();
import * as fs from 'fs-extra';
import * as hdbTerms from '../utility/hdbTerms.ts';
import * as path from 'path';
import * as validator from './validationWrapper.ts';

export default installValidator;

/**
 * Used to validate any command or environment variables used passed to install.
 * @param param
 * @returns {*}
 */
function installValidator(param) {
	const installSchema = Joi.object({
		[hdbTerms.INSTALL_PROMPTS.ROOTPATH]: Joi.custom(validateRootAvailable),
		[(hdbTerms.INSTALL_PROMPTS as any).OPERATIONSAPI_NETWORK_PORT]: Joi.alternatives([number.min(0), string]).allow(
			'null',
			null
		),
		[(hdbTerms.INSTALL_PROMPTS as any).TC_AGREEMENT]: string.valid('yes', 'YES', 'Yes'),
	});

	return validator.validateBySchema(param, installSchema);
}

function validateRootAvailable(value, helpers) {
	if (
		fs.existsSync(path.join(value, 'system/hdb_user/data.mdb')) ||
		fs.existsSync(path.join(value, 'system/hdb_user.mdb'))
	) {
		return helpers.message(`'${value}' is already in use. Please enter a different path.`);
	}
}
