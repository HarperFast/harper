'use strict';

const env_mangr = require('../utility/environment/environmentManager');
const Joi = require('joi');
const validator = require('./validationWrapper');
const moment = require('moment');
const fs = require('fs-extra');
const path = require('path');
const _ = require('lodash');
const hdb_terms = require('../utility/hdbTerms');
const { LOG_LEVELS } = require('../utility/hdbTerms');

const LOG_DATE_FORMAT = 'YYYY-MM-DD hh:mm:ss';
const INSTALL_LOG_LOCATION = path.resolve(__dirname, `../logs`);

module.exports = function (object) {
	return validator.validateBySchema(object, read_log_schema);
};

const read_log_schema = Joi.object({
	from: Joi.custom(validateDatetime),
	until: Joi.custom(validateDatetime),
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
	const process_log_name = _.invert(hdb_terms.PROCESS_LOG_NAMES);
	if (process_log_name[value] === undefined) {
		return helpers.message(`'log_name' '${value}' is invalid.`);
	}

	const log_path = env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
	const log_name = value === undefined ? hdb_terms.PROCESS_LOG_NAMES.HDB : value;
	const read_log_path =
		log_name === hdb_terms.PROCESS_LOG_NAMES.INSTALL
			? path.join(INSTALL_LOG_LOCATION, hdb_terms.PROCESS_LOG_NAMES.INSTALL)
			: path.join(log_path, log_name);

	let exists = fs.existsSync(read_log_path);
	if (exists) {
		return null;
	}
	return helpers.message(`'log_name' '${value}' does not exist.`);
}
