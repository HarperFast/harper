'use strict';
/**
 * Test that SQL functions are being correctly monkey patched in alasql
 * TODO: this file currently is only testing the date functions - add others
 */

const chai = require('chai');
const { expect } = chai;
const moment = require('moment');

const alasql = require('alasql');
const alasql_function_importer = require('../../sqlTranslator/alasqlFunctionImporter');
alasql_function_importer(alasql);

const expected_formats = {
	DATE: 'YYYY-MM-DD',
	TIME: 'HH:mm:ss.SSS',
	DATE_TIME: 'YYYY-MM-DDTHH:mm:ss.SSSZZ',
};

const format_regex = {
	date_time_regex:
		/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}T[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}[+|-][0-1][0-9][0-5][0-9]$/,
	date_regex: /\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/,
	time_regex: /[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/,
	unix_regex: /\d{13}$/,
};

const date_time_checks = {
	DATE_TIME: 'YYYY-MM-DDTHH:mm:sZZ',
	TIME: 'HH:mm:ss',
};

const stub_timestamp = '2020-03-26 15:13:02.041+000';
const timestamp_parts = {
	year: '2020',
	month: '03',
	day: '26',
	hour: '15',
	minutes: '13',
	seconds: '02',
	ms: '041',
};

function generateTestSelect(date_func) {
	return `SELECT ${date_func} AS [test_result]`;
}

describe('Test functions from alasqlFunctionImporter w/ alasql', () => {
	it('should return CURRENT_DATE() value in YYYY-MM-DD format', () => {
		const test_function = 'CURRENT_DATE()';

		const { test_result } = alasql(generateTestSelect(test_function))[0];
		const expected_result = moment().utc().format(expected_formats.DATE);

		expect(test_result).to.equal(expected_result);
		expect(test_result).to.match(format_regex.date_regex);
	});

	it('should return CURRENT_TIME() value in HH:mm:ss.SSS format', () => {
		const test_function = 'CURRENT_TIME()';

		const { test_result } = alasql(generateTestSelect(test_function))[0];
		const expected_result = moment().utc().format(date_time_checks.TIME);
		const test_result_check = moment(test_result, expected_formats.TIME).format(date_time_checks.TIME);

		expect(test_result_check).to.equal(expected_result);
		expect(test_result).to.match(format_regex.time_regex);
	});

	it('should EXTRACT the correct date parts', () => {
		const generate_statement = (date_part) =>
			`SELECT EXTRACT('${stub_timestamp}', '${date_part}') as [${date_part.toLowerCase()}_test_result]`;

		const year_statement = generate_statement('YEAR');
		const month_statement = generate_statement('month');
		const day_statement = generate_statement('Day');
		const hour_statement = generate_statement('hour');
		const minute_statement = generate_statement('mINute');
		const second_statement = generate_statement('SECOND');
		const millisecond_statement = generate_statement('milliSECOND');

		const { year_test_result } = alasql(year_statement)[0];
		const { month_test_result } = alasql(month_statement)[0];
		const { day_test_result } = alasql(day_statement)[0];
		const { hour_test_result } = alasql(hour_statement)[0];
		const { minute_test_result } = alasql(minute_statement)[0];
		const { second_test_result } = alasql(second_statement)[0];
		const { millisecond_test_result } = alasql(millisecond_statement)[0];

		expect(year_test_result).to.equal(timestamp_parts.year);
		expect(month_test_result).to.equal(timestamp_parts.month);
		expect(day_test_result).to.equal(timestamp_parts.day);
		expect(hour_test_result).to.equal(timestamp_parts.hour);
		expect(minute_test_result).to.equal(timestamp_parts.minutes);
		expect(second_test_result).to.equal(timestamp_parts.seconds);
		expect(millisecond_test_result).to.equal(timestamp_parts.ms);
	});

	it('should return DATE() value in YYYY-MM-DDTHH:mm:ss.SSSZZ format', () => {
		const test_function = `DATE('${stub_timestamp}')`;

		const { test_result } = alasql(generateTestSelect(test_function))[0];

		const expected_result = moment(test_result).utc().format(expected_formats.DATE_TIME);
		expect(test_result).to.equal(expected_result);
		expect(test_result).to.match(format_regex.date_time_regex);
	});

	it('should return DATE_FORMAT() value in provided format', () => {
		const generate_statement = (date_format, key) =>
			`SELECT DATE_FORMAT('${stub_timestamp}', '${date_format}') as [test_result_${key}]`;

		const test_formats = {
			a: 'MM.DD.YYYY',
			b: 'YYYY',
			c: 'X',
		};

		const statement_a = generate_statement(test_formats.a, 'a');
		const statement_b = generate_statement(test_formats.b, 'b');
		const statement_c = generate_statement(test_formats.c, 'c');

		const { test_result_a } = alasql(statement_a)[0];
		const { test_result_b } = alasql(statement_b)[0];
		const { test_result_c } = alasql(statement_c)[0];

		const expected_result_a = moment(stub_timestamp).format(test_formats.a);
		expect(test_result_a).to.equal(expected_result_a);

		const expected_result_b = moment(stub_timestamp).format(test_formats.b);
		expect(test_result_b).to.equal(expected_result_b);

		const expected_result_c = moment(stub_timestamp).format(test_formats.c);
		expect(test_result_c).to.equal(expected_result_c);
	});

	it('should return correct new date after time is added in DATE_ADD()', () => {
		const generate_statement = (value, interval) =>
			`SELECT DATE_ADD('${stub_timestamp}', '${value}', '${interval}') as [test_result_${interval}]`;

		const test_intervals = {
			days: 2,
			hours: 14,
			months: 23,
		};

		const statement_days = generate_statement(test_intervals.days, 'days');
		const statement_hours = generate_statement(test_intervals.hours, 'hours');
		const statement_months = generate_statement(test_intervals.months, 'months');

		const { test_result_days } = alasql(statement_days)[0];
		const { test_result_hours } = alasql(statement_hours)[0];
		const { test_result_months } = alasql(statement_months)[0];

		const expected_result_days = moment(stub_timestamp).utc().add(test_intervals.days, 'days').valueOf();
		expect(test_result_days).to.equal(expected_result_days);

		const expected_result_hours = moment(stub_timestamp).utc().add(test_intervals.hours, 'hours').valueOf();
		expect(test_result_hours).to.equal(expected_result_hours);

		const expected_result_months = moment(stub_timestamp).utc().add(test_intervals.months, 'months').valueOf();
		expect(test_result_months).to.equal(expected_result_months);
	});

	it('should return correct new date after time is subtracted in DATE_SUB()', () => {
		const generate_statement = (value, interval) =>
			`SELECT DATE_SUB('${stub_timestamp}', '${value}', '${interval}') as [test_result_${interval}]`;

		const test_intervals = {
			days: 2,
			hours: 14,
			months: 23,
		};

		const statement_days = generate_statement(test_intervals.days, 'days');
		const statement_hours = generate_statement(test_intervals.hours, 'hours');
		const statement_months = generate_statement(test_intervals.months, 'months');

		const { test_result_days } = alasql(statement_days)[0];
		const { test_result_hours } = alasql(statement_hours)[0];
		const { test_result_months } = alasql(statement_months)[0];

		const expected_result_days = moment(stub_timestamp).utc().subtract(test_intervals.days, 'days').valueOf();
		expect(test_result_days).to.equal(expected_result_days);

		const expected_result_hours = moment(stub_timestamp).utc().subtract(test_intervals.hours, 'hours').valueOf();
		expect(test_result_hours).to.equal(expected_result_hours);

		const expected_result_months = moment(stub_timestamp).utc().subtract(test_intervals.months, 'months').valueOf();
		expect(test_result_months).to.equal(expected_result_months);
	});

	it('should return correct difference between the two dates provided to DATE_DIFF()', () => {
		const generate_statement = (date1, date2) => `SELECT DATE_DIFF('${date1}', '${date2}') as [test_result]`;

		const date_1 = stub_timestamp;
		const date_2 = moment(stub_timestamp).add(14, 'days').format(expected_formats.DATE_TIME);

		const { test_result } = alasql(generate_statement(date_1, date_2))[0];

		const expected_result = moment(date_1).diff(date_2);
		expect(test_result).to.equal(expected_result);
	});

	it('should return correct difference between the two dates based on interval provided to DATE_DIFF()', () => {
		const generate_statement = (date1, date2, interval) =>
			`SELECT DATE_DIFF('${date1}', '${date2}', '${interval}') as [test_result_${interval}]`;

		const date_1 = stub_timestamp;
		const date_2 = moment(stub_timestamp).utc().subtract(25, 'months').format(expected_formats.DATE_TIME);

		const expected_results = {
			days: 759,
			months: 25,
			years: 2.0833333333333335,
		};

		const { test_result_days } = alasql(generate_statement(date_1, date_2, 'days'))[0];
		const { test_result_months } = alasql(generate_statement(date_1, date_2, 'months'))[0];
		const { test_result_years } = alasql(generate_statement(date_1, date_2, 'years'))[0];

		expect(test_result_days).to.equal(expected_results.days);
		expect(test_result_months).to.equal(expected_results.months);
		expect(test_result_years).to.equal(expected_results.years);
	});

	it('should return NOW() value in unix epoch format', () => {
		const test_function = 'NOW()';

		const { test_result } = alasql(generateTestSelect(test_function))[0];
		const test_result_date = moment(test_result).utc().format(expected_formats.DATE);
		const current_date = moment().utc().format(expected_formats.DATE);

		expect(test_result).to.match(format_regex.unix_regex);
		expect(test_result_date).to.equal(current_date);
	});

	it('should return GETDATE() value in unix epoch format', () => {
		const test_function = 'GETDATE()';

		const { test_result } = alasql(generateTestSelect(test_function))[0];
		const test_result_date = moment(test_result).utc().format(expected_formats.DATE);
		const current_date = moment().utc().format(expected_formats.DATE);

		expect(test_result).to.match(format_regex.unix_regex);
		expect(test_result_date).to.equal(current_date);
	});

	it('should return CURRENT_TIMESTAMP value in unix epoch format', () => {
		const test_function = 'CURRENT_TIMESTAMP';

		const { test_result } = alasql(generateTestSelect(test_function))[0];
		const test_result_date = moment(test_result).utc().format(expected_formats.DATE);
		const current_date = moment().utc().format(expected_formats.DATE);

		expect(test_result).to.match(format_regex.unix_regex);
		expect(test_result_date).to.equal(current_date);
	});

	it('should return GET_SERVER_TIME value as local timestamp in YYYY-MM-DDTHH:mm:ss.SSSZZ format', () => {
		const test_function = 'GET_SERVER_TIME()';

		const { test_result } = alasql(generateTestSelect(test_function))[0];
		const test_result_date = moment(test_result).format(date_time_checks.DATE_TIME);
		const current_date = moment().format(date_time_checks.DATE_TIME);

		expect(test_result).to.match(format_regex.date_time_regex);
		expect(test_result_date).to.equal(current_date);
	});

	it('should return OFFSET_UTC value in YYYY-MM-DDTHH:mm:ss.SSSZZ format', () => {
		const test_function = `OFFSET_UTC(NOW(), -4)`;

		const { test_result } = alasql(generateTestSelect(test_function))[0];

		expect(test_result).to.include('-0400');
		expect(test_result).to.match(format_regex.date_time_regex);
	});
});
