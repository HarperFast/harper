'use strict';;
import moment from 'moment';
const hdbTimeFormat = 'YYYY-MM-DDTHH:mm:ss.SSSZZ';

moment.suppressDeprecationWarnings = true;

export const current_date = () => {
	return moment().utc().format('YYYY-MM-DD');
};
export const current_time = () => {
	return moment().utc().format('HH:mm:ss.SSS');
};
export const extract = (date, datePart) => {
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
};
export const date = (date) => {
	return moment(date).utc().format(hdbTimeFormat);
};
export const date_format = (date, format) => {
	return moment(date).utc().format(format);
};
export const date_add = (date, value, interval) => {
	return moment(date).utc().add(value, interval).valueOf();
};
export const date_sub = (date, value, interval) => {
	return moment(date).utc().subtract(value, interval).valueOf();
};
export const date_diff = (date1, date2, interval) => {
	let firstDate = moment(date1).utc();
	let secondDate = moment(date2).utc();
	if (interval) {
		return firstDate.diff(secondDate, interval, true);
	} else {
		return firstDate.diff(secondDate);
	}
};
export const now = () => {
	return moment().utc().valueOf();
};
export const get_server_time = () => {
	return moment().format(hdbTimeFormat);
};
export const offset_utc = (date, offset) => {
	return moment(date).utc().utcOffset(offset).format(hdbTimeFormat);
};
