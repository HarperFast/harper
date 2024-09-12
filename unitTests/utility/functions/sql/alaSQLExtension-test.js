'use strict';

const alasql_extension = require('../../../../utility/functions/sql/alaSQLExtension');
const assert = require('assert');

const LIBRARY_JSON = {
	library: {
		books: [
			{
				title: 'Structure and Interpretation of Computer Programs',
				authors: ['Abelson', 'Sussman'],
				isbn: '9780262510875',
				price: 38.9,
				copies: 2,
			},
			{
				title: 'The C Programming Language',
				authors: ['Kernighan', 'Richie'],
				isbn: '9780131103627',
				price: 33.59,
				copies: 3,
			},
			{
				title: 'The AWK Programming Language',
				authors: ['Aho', 'Kernighan', 'Weinberger'],
				isbn: '9780201079814',
				copies: 1,
			},
			{
				title: 'Compilers: Principles, Techniques, and Tools',
				authors: ['Aho', 'Lam', 'Sethi', 'Ullman'],
				isbn: '9780201100884',
				price: 23.38,
				copies: 1,
			},
		],
		loans: [
			{
				customer: '10001',
				isbn: '9780262510875',
				return: '2016-12-05',
			},
			{
				customer: '10003',
				isbn: '9780201100884',
				return: '2016-10-22',
			},
			{
				customer: '10003',
				isbn: '9780262510875',
				return: '2016-12-22',
			},
		],
		customers: [
			{
				id: '10001',
				name: 'Joe Doe',
				address: {
					street: '2 Long Road',
					city: 'Winchester',
					postcode: 'SO22 5PU',
				},
			},
			{
				id: '10002',
				name: 'Fred Bloggs',
				address: {
					street: '56 Letsby Avenue',
					city: 'Winchester',
					postcode: 'SO22 4WD',
				},
			},
			{
				id: '10003',
				name: 'Jason Arthur',
				address: {
					street: '1 Preddy Gate',
					city: 'Southampton',
					postcode: 'SO14 0MG',
				},
			},
		],
	},
};

const SEARCH_JSON_ERROR_MSG1 = 'search json expression must be a non-empty string';

describe('test alaSQLExtension module', () => {
	describe('test searchJSON function', () => {
		before(() => {
			alasql_extension.__ala__ = {};
			alasql_extension.__ala__.res = {};
		});

		it('pass no args', () => {
			let error;
			try {
				alasql_extension.searchJSON();
			} catch (e) {
				error = e;
			}

			assert.deepStrictEqual(error, new Error(SEARCH_JSON_ERROR_MSG1));
		});

		it('pass null to first arg', () => {
			let error;
			try {
				alasql_extension.searchJSON(null);
			} catch (e) {
				error = e;
			}

			assert.deepStrictEqual(error, new Error(SEARCH_JSON_ERROR_MSG1));
		});

		it('pass empty string to first arg', () => {
			let error;
			try {
				alasql_extension.searchJSON('');
			} catch (e) {
				error = e;
			}

			assert.deepStrictEqual(error, new Error(SEARCH_JSON_ERROR_MSG1));
		});

		it('pass number to first arg', () => {
			let error;
			try {
				alasql_extension.searchJSON(555);
			} catch (e) {
				error = e;
			}

			assert.deepStrictEqual(error, new Error(SEARCH_JSON_ERROR_MSG1));
		});

		it('pass no value to 2nd arg', () => {
			let error;
			let result;
			try {
				result = alasql_extension.searchJSON('library');
			} catch (e) {
				error = e;
			}

			assert.deepStrictEqual(error, undefined);
			assert.deepStrictEqual(result, undefined);
		});

		it('pass null value to 2nd arg', () => {
			let error;
			let result;
			try {
				result = alasql_extension.searchJSON('library', null);
			} catch (e) {
				error = e;
			}

			assert.deepStrictEqual(error, undefined);
			assert.deepStrictEqual(result, undefined);
		});

		it('pass number to 2nd arg', () => {
			let error;
			let result;
			try {
				result = alasql_extension.searchJSON('library', 22);
			} catch (e) {
				error = e;
			}

			assert.deepStrictEqual(error, undefined);
			assert.deepStrictEqual(result, undefined);
		});

		it('basic test', () => {
			let error;
			let result;

			let expected = {
				title: 'Structure and Interpretation of Computer Programs',
				authors: ['Abelson', 'Sussman'],
				isbn: '9780262510875',
				price: 38.9,
				copies: 2,
			};

			try {
				result = alasql_extension.searchJSON('library.books[0]', LIBRARY_JSON);
			} catch (e) {
				error = e;
			}

			assert.deepStrictEqual(error, undefined);
			assert.deepStrictEqual(result, expected);
		});
	});
});
