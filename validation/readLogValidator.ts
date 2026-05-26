'use strict';

import Joi from 'joi';
import * as validator from './validationWrapper.ts';
import moment from 'moment';
import * as fs from 'fs-extra';
import * as path from 'path';
import { getConfigPath } from '../config/configUtils.js';
import * as hdbTerms from '../utility/hdbTerms.ts';
import { LOG_LEVELS } from '../utility/hdbTerms.ts';

const LOG_DATE_FORMAT = 'YYYY-MM-DD hh:mm:ss';

export default function (object: any) {
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

function validateDatetime(value, helpers) {
	if (moment(value, moment.ISO_8601).format(LOG_DATE_FORMAT) === 'Invalid date') {
		return helpers.message(`'${helpers.state.path[0]}' date '${value}' is invalid.`);
	}
}

function validateReadLogPath(value, helpers) {
	if (path.posix.basename(value) !== value || path.win32.basename(value) !== value) {
		return helpers.message(`'log_name' '${value}' is invalid.`);
	}

	const ext = path.extname(value);
	if (ext && ext !== '.log') {
		return helpers.message(`'log_name' '${value}' is invalid.`);
	}

	const logName = ext === '.log' ? value : `${value}.log`;
	const logPath = getConfigPath(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
	const readLogPath = path.join(logPath, logName);

	if (fs.existsSync(readLogPath)) {
		return value;
	}
	return helpers.message(`'log_name' '${value}' does not exist.`);
}
