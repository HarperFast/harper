'use strict';

const moment = require('moment');
const hdbTimeFormat = 'YYYY-MM-DDTHH:mm:ss.SSSZZ';

moment.suppressDeprecationWarnings = true;

module.exports = {
	current_date: () => {
		return moment().utc().format('YYYY-MM-DD');
	},
	current_time: () => {
		return moment().utc().format('HH:mm:ss.SSS');
	},
	extract: (date, datePart) => {
		switch (datePart.toLowerCase()) {
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
		return moment(date).utc().format(hdbTimeFormat);
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
	date_diff: (date1, date2, interval) => {
		let firstDate = moment(date1).utc();
		let secondDate = moment(date2).utc();
		if (interval) {
			return firstDate.diff(secondDate, interval, true);
		} else {
			return firstDate.diff(secondDate);
		}
	},
	now: () => {
		return moment().utc().valueOf();
	},
	get_server_time: () => {
		return moment().format(hdbTimeFormat);
	},
	offset_utc: (date, offset) => {
		return moment(date).utc().utcOffset(offset).format(hdbTimeFormat);
	},
};
