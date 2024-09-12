'use strict';

const common = require('../../../utility/lmdb/commonUtility');
const rewire = require('rewire');
const rw_common = rewire('../../../utility/lmdb/commonUtility');
const assert = require('assert');

const primitive_check = rw_common.__get__('primitiveCheck');
const { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH } = require('../../../utility/lmdb/terms');
const ONE_RECORD_ARRAY = [{ id: 1, name: 'Kyle', age: '46' }];

describe('Test commonUtility module', () => {
	describe('Test stringifyData function', () => {
		it('pass variables resolving to null', () => {
			let err;
			let response;
			let response1;
			let response2;
			let response3;
			try {
				response = common.stringifyData();
				response1 = common.stringifyData(undefined);
				response2 = common.stringifyData(null);
				response3 = common.stringifyData('');
			} catch (e) {
				err = e;
			}

			assert.deepStrictEqual(err, undefined);
			assert.deepStrictEqual(response, null);
			assert.deepStrictEqual(response1, null);
			assert.deepStrictEqual(response2, null);
			assert.deepStrictEqual(response3, '');
		});

		it('pass booleans', () => {
			let err;
			let response;
			let response1;
			try {
				response = common.stringifyData(true);
				response1 = common.stringifyData(false);
			} catch (e) {
				err = e;
			}

			assert.deepStrictEqual(err, undefined);
			assert.deepStrictEqual(response, 'true');
			assert.deepStrictEqual(response1, 'false');
		});

		it('pass arrays and object', () => {
			const string_array = ['a', 'bb', 'zz', 'aa111'];
			const numeric_array = [1, 100, 8.43, 7965, 22.6789];
			const mixed_type_array = [300, false, 'test', 55.532, 'stuff'];

			let err;
			let response;
			let response1;
			let response2;
			let response3;
			let response4;
			try {
				response = common.stringifyData(string_array);
				response1 = common.stringifyData(numeric_array);
				response2 = common.stringifyData(mixed_type_array);
				response3 = common.stringifyData(ONE_RECORD_ARRAY);
				response4 = common.stringifyData(ONE_RECORD_ARRAY[0]);
			} catch (e) {
				err = e;
			}

			assert.deepStrictEqual(err, undefined);
			assert.deepStrictEqual(response, JSON.stringify(string_array));
			assert.deepStrictEqual(response1, JSON.stringify(numeric_array));
			assert.deepStrictEqual(response2, JSON.stringify(mixed_type_array));
			assert.deepStrictEqual(response3, JSON.stringify(ONE_RECORD_ARRAY));
			assert.deepStrictEqual(response4, JSON.stringify(ONE_RECORD_ARRAY[0]));
		});

		it('test 254 character limit', () => {
			const string_254 =
				"Fam 3 wolf moon hammocks pinterest, man braid austin hoodie you probably haven't heard of them schlitz polaroid XOXO butcher. Flexitarian leggings cold-pressed live-edge jean shorts plaid, pickled vegan raclette 8-bit literally. Chambray you probably hav";
			const string_255 = string_254 + 'i';
			let err;
			let response;
			let response1;
			try {
				response = common.stringifyData(string_254);
				response1 = common.stringifyData(string_255);
			} catch (e) {
				err = e;
			}

			assert.deepStrictEqual(err, undefined);
			assert.deepStrictEqual(Buffer.byteLength(string_254), 254);
			assert.deepStrictEqual(Buffer.byteLength(string_255), 255);
			assert.deepStrictEqual(response, string_254);
			assert.deepStrictEqual(response1, string_255);
		});
	});

	describe('Test primitiveCheck function', () => {
		it('test int is primitive', () => {
			assert.deepStrictEqual(primitive_check(2), true);
			assert.deepStrictEqual(primitive_check(-22), true);
			assert.deepStrictEqual(primitive_check(Infinity), true);
			assert.deepStrictEqual(primitive_check(Number.MAX_VALUE), true);
			assert.deepStrictEqual(primitive_check(Date.now()), true);
		});
		it('test double is primitive', () => {
			assert.deepStrictEqual(primitive_check(2.22), true);
			assert.deepStrictEqual(primitive_check(-22.67678787), true);
		});
		it('test string is primitive', () => {
			assert.deepStrictEqual(primitive_check(''), true);
			assert.deepStrictEqual(primitive_check('this is some cool text'), true);
		});
		it('test Symbol is primitive', () => {
			assert.deepStrictEqual(primitive_check(Symbol.for('test')), true);
		});
		it('test bool is primitive', () => {
			assert.deepStrictEqual(primitive_check(true), true);
			assert.deepStrictEqual(primitive_check(false), true);
		});
		it('test bigint is primitive', () => {
			assert.deepStrictEqual(primitive_check(BigInt(34)), true);
		});
		it('test buffer is primitive', () => {
			assert.deepStrictEqual(primitive_check(Buffer.from('test')), true);
		});
		it('test null is not primitive', () => {
			assert.deepStrictEqual(primitive_check(null), false);
		});
		it('test undefined is not primitive', () => {
			assert.deepStrictEqual(primitive_check(undefined), false);
		});
		it('test object is not primitive', () => {
			assert.deepStrictEqual(primitive_check({ cool: 'test' }), false);
			assert.deepStrictEqual(primitive_check({}), false);
		});
		it('test array is not primitive', () => {
			assert.deepStrictEqual(primitive_check([2, 'test']), false);
			assert.deepStrictEqual(primitive_check([]), false);
		});
		it('test Date is not primitive', () => {
			assert.deepStrictEqual(primitive_check(new Date()), false);
		});
	});

	describe('Test convertKeyValueToWrite function', () => {
		it('test int returns int', () => {
			assert.deepStrictEqual(common.convertKeyValueToWrite(2), 2);
			assert.deepStrictEqual(common.convertKeyValueToWrite(-22), -22);
			assert.deepStrictEqual(common.convertKeyValueToWrite(Infinity), Infinity);
			assert.deepStrictEqual(common.convertKeyValueToWrite(Number.MAX_VALUE), Number.MAX_VALUE);
			let now = Date.now();
			assert.deepStrictEqual(common.convertKeyValueToWrite(now), now);
		});
		it('test double return double', () => {
			assert.deepStrictEqual(common.convertKeyValueToWrite(2.22), 2.22);
			assert.deepStrictEqual(common.convertKeyValueToWrite(-22.67678787), -22.67678787);
		});
		it('test string returns string', () => {
			assert.deepStrictEqual(common.convertKeyValueToWrite(''), '');
			assert.deepStrictEqual(common.convertKeyValueToWrite('this is some cool text'), 'this is some cool text');
		});
		it('test Symbol return Symbol', () => {
			assert.deepStrictEqual(common.convertKeyValueToWrite(Symbol.for('test')), Symbol.for('test'));
		});
		it('test bool returns bool', () => {
			assert.deepStrictEqual(common.convertKeyValueToWrite(true), true);
			assert.deepStrictEqual(common.convertKeyValueToWrite(false), false);
		});
		it('test buffer returns buffer', () => {
			assert.deepStrictEqual(common.convertKeyValueToWrite(Buffer.from('test')), Buffer.from('test'));
		});
		it('test null returns null', () => {
			assert.deepStrictEqual(common.convertKeyValueToWrite(null), null);
		});
		it('test undefined returns undefined', () => {
			assert.deepStrictEqual(common.convertKeyValueToWrite(undefined), undefined);
		});
		it('test array of primitives returns array of primitives', () => {
			let buff = Buffer.from('test');
			let arr = [2, 'test', 2.22, buff, false, null, Symbol.for('cool')];
			assert.deepStrictEqual(common.convertKeyValueToWrite(arr), arr);
			assert.deepStrictEqual(common.convertKeyValueToWrite([]), []);
		});

		it('test array with non-primitive returns string', () => {
			let arr = [2, 'test', 2.22, undefined, false, null, Symbol.for('cool')];
			assert.deepStrictEqual(common.convertKeyValueToWrite(arr), arr);
		});

		it('test Date returns number', () => {
			let date = new Date();
			assert.deepStrictEqual(common.convertKeyValueToWrite(date), date.valueOf());
		});
	});

	describe('test getIndexedValues function', () => {
		it('test int returns int', () => {
			assert.deepStrictEqual(common.getIndexedValues(2), [2]);
			assert.deepStrictEqual(common.getIndexedValues(-22), [-22]);
		});
		it('test double return double', () => {
			assert.deepStrictEqual(common.getIndexedValues(2.22), [2.22]);
			assert.deepStrictEqual(common.getIndexedValues(-22.67678787), [-22.67678787]);
		});
		it('test string returns string', () => {
			assert.deepStrictEqual(common.getIndexedValues(''), ['']);
			assert.deepStrictEqual(common.getIndexedValues('this is some cool text'), ['this is some cool text']);
		});
		it('test long string returns overflowed string', () => {
			let str = '';
			for (let i = 0; i < 400; i++) {
				str += 'a';
			}
			assert.deepStrictEqual(common.getIndexedValues(str), [str.slice(0, MAX_SEARCH_KEY_LENGTH) + OVERFLOW_MARKER]);
		});
		it('test bool returns bool', () => {
			assert.deepStrictEqual(common.getIndexedValues(true), [true]);
			assert.deepStrictEqual(common.getIndexedValues(false), [false]);
		});
		it('test buffer returns nothing', () => {
			assert.deepStrictEqual(common.getIndexedValues(Buffer.from('test')), undefined);
		});
		it('test null returns nothing', () => {
			assert.deepStrictEqual(common.getIndexedValues(null), undefined);
		});
		it('test object returns nothing', () => {
			assert.deepStrictEqual(common.getIndexedValues({ cool: 'test' }), undefined);
			assert.deepStrictEqual(common.getIndexedValues({}), undefined);
		});
		it('test array of primitives returns array of primitives', () => {
			let buff = Buffer.from('test');
			let arr = [2, 'test', 2.22, buff, false, null, Symbol.for('cool')];
			assert.deepStrictEqual(common.getIndexedValues(arr), [2, 'test', 2.22, false, Symbol.for('cool')]);
			assert.deepStrictEqual(common.getIndexedValues([]), []);
		});

		it('test array with non-primitive returns string', () => {
			let arr = [2, {}, { foo: 'bar' }];
			assert.deepStrictEqual(common.getIndexedValues(arr), [2]);
		});
	});
});
