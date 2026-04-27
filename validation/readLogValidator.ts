'use strict';;
import Joi from 'joi';
import * as validator from './validationWrapper.js';
import moment from 'moment';
import fs from 'fs-extra';
import path from 'path';
import _ from 'lodash';
import { getConfigPath } from '../config/configUtils.js';
import * as hdbTerms from '../utility/hdbTerms.js';
import { LOG_LEVELS } from '../utility/hdbTerms.js';




const LOG_DATE_FORMAT = 'YYYY-MM-DD hh:mm:ss';
const INSTALL_LOG_LOCATION = path.resolve(__dirname, `../logs`);

export default function (object: any): Error | undefined {
	return validator.validateBySchema(object, readLogSchema);
}

const readLogSchema = Joi.object({
	from: Joi.custom(validateDatetime),
	until: Joi.custom(validateDatetime),
	to: Joi.custom(validateDatetime),
	level: Joi.valid(
		LOG_LEVELS.NOTIFY,
		LOG_LEVELS.FATAL,
		LOG_LEVELS.ERROR,
		LOG_LEVELS.WARN,
		LOG_LEVELS.INFO,
		LOG_LEVELS.DEBUG,
		LOG_LEVELS.TRACE
	),
	order: Joi.valid('asc', 'desc'),
	limit: Joi.number().min(1),
	start: Joi.number().min(0),
	log_name: Joi.custom(validateReadLogPath),
	filter: Joi.string(),
});

function validateDatetime(value: string, helpers: Joi.CustomHelpers): any {
	if (moment(value, moment.ISO_8601).format(LOG_DATE_FORMAT) === 'Invalid date') {
		return helpers.message(`'${helpers.state.path[0]}' date '${value}' is invalid.`);
	}
}

function validateReadLogPath(value: string, helpers: Joi.CustomHelpers): any {
	const processLogName = _.invert(hdbTerms.LOG_NAMES);
	if (processLogName[value] === undefined) {
		return helpers.message(`'log_name' '${value}' is invalid.`);
	}

	const logPath = getConfigPath(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
	const logName = value === undefined ? hdbTerms.LOG_NAMES.HDB : value;
	const readLogPath =
		logName === hdbTerms.LOG_NAMES.INSTALL
			? path.join(INSTALL_LOG_LOCATION, hdbTerms.LOG_NAMES.INSTALL)
			: path.join(logPath, logName);

	let exists = fs.existsSync(readLogPath);
	if (exists) {
		return null;
	}
	return helpers.message(`'log_name' '${value}' does not exist.`);
}
