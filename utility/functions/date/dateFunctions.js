'use strict';

const moment = require('moment');
const hdb_time_format = 'YYYY-MM-DDTHH:mm:ss.SSSZZ';

moment.suppressDeprecationWarnings = true;

module.exports = {
	current_date: () => {
		return moment().utc().format('YYYY-MM-DD');
	},
	current_time: () => {
		return moment().utc().format('HH:mm:ss.SSS');
	},
	extract: (date, date_part) => {
		switch (date_part.toLowerCase()) {
			case 'year':
				return moment(date).utc().format('YYYY');
			case 'month':
				return moment(date).utc().format('MM');
			case 'day':
				return moment(date).utc().format('DD');
			case 'hour':
				return moment(date).utc().format('HH');
			case 'minute':
				return moment(date).utc().format('mm');
			case 'second':
				return moment(date).utc().format('ss');
			case 'millisecond':
				return moment(date).utc().format('SSS');
			default:
				break;
		}
	},
	date: (date) => {
		return moment(date).utc().format(hdb_time_format);
	},
	date_format: (date, format) => {
		return moment(date).utc().format(format);
	},
	date_add: (date, value, interval) => {
		return moment(date).utc().add(value, interval).valueOf();
	},
	date_sub: (date, value, interval) => {
		return moment(date).utc().subtract(value, interval).valueOf();
	},
	date_diff: (date_1, date_2, interval) => {
		let first_date = moment(date_1).utc();
		let second_date = moment(date_2).utc();
		if (interval) {
			return first_date.diff(second_date, interval, true);
		} else {
			return first_date.diff(second_date);
		}
	},
	now: () => {
		return moment().utc().valueOf();
	},
	get_server_time: () => {
		return moment().format(hdb_time_format);
	},
	offset_utc: (date, offset) => {
		return moment(date).utc().utcOffset(offset).format(hdb_time_format);
	},
};
