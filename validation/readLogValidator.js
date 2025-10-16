'use strict';

const envMangr = require('../utility/environment/environmentManager.js');
const Joi = require('joi');
const validator = require('./validationWrapper.js');
const moment = require('moment');
const fs = require('fs-extra');
const path = require('path');
const _ = require('lodash');
const hdbTerms = require('../utility/hdbTerms.ts');
const { LOG_LEVELS } = require('../utility/hdbTerms.ts');

const LOG_DATE_FORMAT = 'YYYY-MM-DD hh:mm:ss';
const INSTALL_LOG_LOCATION = path.resolve(__dirname, `../logs`);

module.exports = function (object) {
	return validator.validateBySchema(object, readLogSchema);
};

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
});

function validateDatetime(value, helpers) {
	if (moment(value, moment.ISO_8601).format(LOG_DATE_FORMAT) === 'Invalid date') {
		return helpers.message(`'${helpers.state.path[0]}' date '${value}' is invalid.`);
	}
}

function validateReadLogPath(value, helpers) {
	const processLogName = _.invert(hdbTerms.LOG_NAMES);
	if (processLogName[value] === undefined) {
		return helpers.message(`'log_name' '${value}' is invalid.`);
	}

	const logPath = envMangr.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
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
