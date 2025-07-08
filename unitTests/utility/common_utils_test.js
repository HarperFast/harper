'use strict';
/**
 * Test the common_utils_test module.
 */

const assert = require('assert');
const chai = require('chai');
const cu = require('../../utility/common_utils');
const test_utils = require('../test_utils');
const stream = require('stream');
const papa_parse = require('papaparse');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.changeProcessToBinDir();
const rewire = require('rewire');
const cu_rewire = rewire('../../utility/common_utils');
const upgrade_directive = require('../../upgrade/UpgradeDirective');
const { expect } = chai;
const ALL_SPACES = '     ';
const SEP = require('path').sep;

const USERS = new Map([
	[
		'HDB_ADMIN',
		{
			active: true,
			role: {
				id: 'd2742e06-e7cc-4a90-9f10-205ac5fa5621',
				permission: {
					super_user: true,
				},
				role: 'super_user',
			},
			username: 'HDB_ADMIN',
		},
	],
	[
		'sgoldberg',
		{
			active: true,
			role: {
				id: 'd2742e06-e7cc-4a90-9f10-205ac5fa5621',
				permission: {
					super_user: true,
				},
				role: 'super_user',
			},
			username: 'sgoldberg',
		},
	],
	[
		'cluster_test',
		{
			active: true,
			role: {
				id: '916c9ce1-1411-4341-9c0a-7b7bd182a4c9',
				permission: {
					cluster_user: true,
				},
				role: 'cluster_user3',
			},
			username: 'cluster_test',
		},
	],
]);

const PSLIST_HELIUM_RETURN = [
	{
		pid: 30112,
		name: 'helium',
		cmd: 'helium --server',
		ppid: 1,
		uid: 1000,
		cpu: 0.2,
		memory: 0,
	},
];

const CLUSTER_USER_NAME = 'cluster_test';

describe('Test common_utils module', () => {
	describe(`Test errorizeMessage`, function () {
		it('Nominal, pass message', function () {
			let err = cu.errorizeMessage('This is an error');
			assert.equal(err instanceof Error, true);
		});

		it('Pass in null', function () {
			let err = cu.errorizeMessage(null);
			assert.equal(err instanceof Error, true);
		});

		it('Pass in undefined', function () {
			let err = cu.errorizeMessage(null);
			assert.equal(err instanceof Error, true);
		});
	});

	describe(`Test isEmpty`, function () {
		it('Pass in null value, expect true', function () {
			assert.equal(cu.isEmpty(null), true);
		});
		it('Pass in undefined value, expect true', function () {
			assert.equal(cu.isEmpty(undefined), true);
		});
		it('Pass in value, expect false', function () {
			assert.equal(cu.isEmpty(12), false);
		});
		it('Pass in empty value, expect false', function () {
			assert.equal(cu.isEmpty(''), false);
		});
	});

	describe(`Test isEmptyOrZeroLength`, function () {
		it('Pass in null value, expect true', function () {
			assert.equal(cu.isEmptyOrZeroLength(null), true);
		});
		it('Pass in undefined value, expect true', function () {
			assert.equal(cu.isEmptyOrZeroLength(undefined), true);
		});
		it('Pass in value, expect false', function () {
			assert.equal(cu.isEmptyOrZeroLength(12), false);
		});
		it('Pass in empty value, expect true', function () {
			assert.equal(cu.isEmptyOrZeroLength(''), true);
		});
		it('Pass in 0, expect true', function () {
			assert.equal(cu.isEmptyOrZeroLength(0), false);
		});
		it('Pass in string with all spaces, expect false', function () {
			assert.equal(cu.isEmptyOrZeroLength(ALL_SPACES), false);
		});
	});

	describe(`Test listHasEmptyValues`, function () {
		it('Pass in null value, expect true', function () {
			assert.equal(cu.arrayHasEmptyValues(null), true);
		});
		it('Pass in null value, expect true', function () {
			assert.equal(cu.arrayHasEmptyValues([null]), true);
		});
		it('Pass in undefined value, expect true', function () {
			assert.equal(cu.arrayHasEmptyValues([undefined]), true);
		});
		it('Pass in value, expect false', function () {
			assert.equal(cu.arrayHasEmptyValues([12]), false);
		});
		it('Pass in empty value, expect false', function () {
			assert.equal(cu.arrayHasEmptyValues(['']), false);
		});
	});

	describe(`Test listHasEmptyOrZeroLengthValues`, function () {
		it('Pass in null value, expect true', function () {
			assert.equal(cu.arrayHasEmptyOrZeroLengthValues([null]), true);
		});
		it('Pass in null value, expect true', function () {
			assert.equal(cu.arrayHasEmptyOrZeroLengthValues([null]), true);
		});
		it('Pass in undefined value, expect true', function () {
			assert.equal(cu.arrayHasEmptyOrZeroLengthValues([undefined]), true);
		});
		it('Pass in value, expect false', function () {
			assert.equal(cu.arrayHasEmptyOrZeroLengthValues([12]), false);
		});
		it('Pass in empty value, expect true', function () {
			assert.equal(cu.arrayHasEmptyOrZeroLengthValues(['']), true);
		});
	});

	describe(`Test buildFolderPath`, function () {
		it(`Pass in null, expect empty string`, function () {
			assert.equal(cu.buildFolderPath(null), '');
		});

		it(`Pass in empty string, expect empty string`, function () {
			assert.equal(cu.buildFolderPath(''), '');
		});

		it(`Pass in values with mixed null and empty string, expect double slashes where empty values would be`, function () {
			assert.equal(cu.buildFolderPath('opt', null, 'test', '', 'data'), `opt${SEP}${SEP}test${SEP}${SEP}data`);
		});

		it(`Pass in values mixed with numbers and strings, expect a path`, function () {
			assert.equal(
				cu.buildFolderPath('opt', 1, 'test', 45, 'data', '333-55'),
				`opt${SEP}1${SEP}test${SEP}45${SEP}data${SEP}333-55`
			);
		});
	});

	describe(`Test isBoolean`, function () {
		it(`Pass in null, expect false`, function () {
			assert.equal(cu.isBoolean(null), false);
		});

		it(`Pass in undefined, expect false`, function () {
			assert.equal(cu.isBoolean(undefined), false);
		});

		it(`Pass in empty string, expect false`, function () {
			assert.equal(cu.isBoolean(''), false);
		});

		it(`Pass in spaces, expect false`, function () {
			assert.equal(cu.isBoolean('   '), false);
		});

		it(`Pass in string, expect false`, function () {
			assert.equal(cu.isBoolean('am i false?'), false);
		});

		it(`Pass in 1, expect false`, function () {
			assert.equal(cu.isBoolean(1), false);
		});

		it(`Pass in 0, expect false`, function () {
			assert.equal(cu.isBoolean(0), false);
		});

		it(`Pass in number, expect false`, function () {
			assert.equal(cu.isBoolean(2.3455), false);
		});

		it(`Pass in array, expect false`, function () {
			assert.equal(cu.isBoolean([2, 'stuff']), false);
		});

		it(`Pass in object, expect false`, function () {
			assert.equal(cu.isBoolean({ active: true }), false);
		});

		it(`Pass in true, expect true`, function () {
			assert.equal(cu.isBoolean(true), true);
		});

		it(`Pass in false, expect true`, function () {
			assert.equal(cu.isBoolean(false), true);
		});

		it(`Pass in evaluation, expect true`, function () {
			assert.equal(cu.isBoolean(2 > 1), true);
		});
	});

	describe(`Test autoCast`, function () {
		it(`Pass in null, expect null`, function () {
			assert.equal(cu.autoCast(null), null);
		});

		it(`Pass in 0.10056344792246819, expect 0.10056344792246819 as number`, function () {
			let result = cu.autoCast('0.10056344792246819');
			assert.deepStrictEqual(typeof result, 'number');
			assert.deepStrictEqual(result, 0.10056344792246819);
		});

		it(`Pass in "0.059_111.519", expect "0.059_111.519" as string`, function () {
			let result = cu.autoCast('0.059_111.519');
			assert.deepStrictEqual(typeof result, 'string');
			assert.deepStrictEqual(result, '0.059_111.519');
		});

		it(`Pass in "0.059,111.519", expect "0.059,111.519" as string`, function () {
			let result = cu.autoCast('0.059,111.519');
			assert.deepStrictEqual(typeof result, 'string');
			assert.deepStrictEqual(result, '0.059,111.519');
		});

		it(`Pass in "0.059.111.519", expect "0.059.111.519" as string`, function () {
			let result = cu.autoCast('0.059.111.519');
			assert.deepStrictEqual(typeof result, 'string');
			assert.deepStrictEqual(result, '0.059.111.519');
		});

		it(`Pass in undefined, expect undefined`, function () {
			assert.strictEqual(cu.autoCast(undefined), undefined);
		});

		it(`Pass in empty string, expect empty string`, function () {
			assert.equal(cu.autoCast(''), '');
		});

		it(`Pass in spaces, expect spaces`, function () {
			assert.equal(cu.autoCast('   '), '   ');
		});

		it(`Pass in string of null, expect null`, function () {
			assert.strictEqual(cu.autoCast('null'), null);
		});

		it(`Pass in string of undefined, expect undefined`, function () {
			assert.strictEqual(cu.autoCast('undefined'), null);
		});

		it(`Pass in string of true, expect boolean true`, function () {
			assert.equal(cu.autoCast('true'), true);
		});

		it(`Pass in uppercase string of true, expect boolean true`, function () {
			assert.equal(cu.autoCast('TRUE'), true);
		});

		it(`Pass in uppercase string of false, expect boolean false`, function () {
			assert.equal(cu.autoCast('FALSE'), false);
		});

		it(`Pass in uppercase string of null, expect value of null`, function () {
			assert.equal(cu.autoCast('NULL'), null);
		});

		it(`Pass in string of 42, expect number 42`, function () {
			assert.equal(cu.autoCast('42'), 42);
		});

		it(`Pass in string of 0, expect number 0`, function () {
			assert.equal(cu.autoCast('0'), 0);
		});

		it(`Pass in string of 42.42, expect number 42.42`, function () {
			assert.equal(cu.autoCast('42.42'), 42.42);
		});

		it(`Pass in string of '0102', expect string '0102'`, function () {
			assert.deepStrictEqual(cu.autoCast('0102'), '0102');
		});

		it(`Pass in string surrounded by brackets, expect string surrounded by brackets`, function () {
			assert.equal(cu.autoCast('[1 2 3]'), '[1 2 3]');
		});

		it(`Pass in false, expect false`, function () {
			assert.strictEqual(cu.autoCast(false), false);
		});

		it(`Pass in true, expect true`, function () {
			assert.strictEqual(cu.autoCast(true), true);
		});

		it(`Pass in 1, expect 1`, function () {
			assert.strictEqual(cu.autoCast(1), 1);
		});

		it(`Pass in 0, expect 0`, function () {
			assert.strictEqual(cu.autoCast(0), 0);
		});

		it(`Pass in date , expect date back`, function () {
			assert.deepEqual(cu.autoCast(new Date('2019-01-01')), new Date('2019-01-01'));
		});

		it(`Pass in array , expect array back`, function () {
			let assert_array = ['sup', 'dude'];
			assert.deepEqual(cu.autoCast(assert_array), assert_array);
		});

		it(`Pass in array of various values , expect array back`, function () {
			let assert_array = [1, null, undefined, NaN, 2];
			assert.deepEqual(cu.autoCast(assert_array), assert_array);
		});

		it(`Pass in object , expect object back`, function () {
			let assert_object = { id: 1, stuff: 'here' };
			assert.deepEqual(cu.autoCast(assert_object), assert_object);
		});

		it(`Pass in number with e in it , string back`, function () {
			assert.strictEqual(cu.autoCast('89e15636'), '89e15636');
		});

		it(`Pass in number with e in it , string back 2`, function () {
			assert.strictEqual(cu.autoCast('3e+10'), '3e+10');
		});

		it(`Pass in number with e in it , string back 3`, function () {
			assert.strictEqual(cu.autoCast('3e-10'), '3e-10');
		});

		it(`Pass in number with a in it , string back 3`, function () {
			assert.strictEqual(cu.autoCast('3a-10'), '3a-10');
		});

		it(`Pass in number with E in it , string back`, function () {
			assert.strictEqual(cu.autoCast('89E15636'), '89E15636');
		});

		it(`Pass in number with E in it , string back 2`, function () {
			assert.strictEqual(cu.autoCast('3E+10'), '3E+10');
		});

		it(`Pass in number with E in it , string back 3`, function () {
			assert.strictEqual(cu.autoCast('3E-10'), '3E-10');
		});

		it(`Pass in number with A in it , string back 3`, function () {
			assert.strictEqual(cu.autoCast('3A-10'), '3A-10');
		});
	});

	describe('Test escapeRawValue', function () {
		it('Pass in null, expect null', function () {
			assert.equal(cu.escapeRawValue(null), null);
		});

		it('Pass in undefined, expect undefined', function () {
			assert.equal(cu.escapeRawValue(undefined), undefined);
		});

		it('Pass in "", expect ""', function () {
			assert.equal(cu.escapeRawValue(''), '');
		});

		it('Pass in ".", expect "U+002E"', function () {
			assert.equal(cu.escapeRawValue('.'), 'U+002E');
		});

		it('Pass in "..", expect "U+002EU+002E"', function () {
			assert.equal(cu.escapeRawValue('..'), 'U+002EU+002E');
		});

		it('Pass in "...", expect "..."', function () {
			assert.equal(cu.escapeRawValue('...'), '...');
		});

		it('Pass in "words..", expect "words.."', function () {
			assert.equal(cu.escapeRawValue('words..'), 'words..');
		});

		it('Pass in "word.s.", expect "word.s."', function () {
			assert.equal(cu.escapeRawValue('word.s.'), 'word.s.');
		});

		it('Pass in "hello/this/is/some/text", expect "helloU+002FthisU+002FisU+002FsomeU+002Ftext"', function () {
			assert.equal(cu.escapeRawValue('hello/this/is/some/text'), 'helloU+002FthisU+002FisU+002FsomeU+002Ftext');
		});
	});

	describe('Test unescapeValue', function () {
		it('Pass in null, expect null', function () {
			assert.equal(cu.unescapeValue(null), null);
		});

		it('Pass in undefined, expect undefined', function () {
			assert.equal(cu.unescapeValue(undefined), undefined);
		});

		it('Pass in "", expect ""', function () {
			assert.equal(cu.unescapeValue(''), '');
		});

		it('Pass in "U+002E", expect "."', function () {
			assert.equal(cu.unescapeValue('U+002E'), '.');
		});

		it('Pass in "U+002EU+002E", expect ".."', function () {
			assert.equal(cu.unescapeValue('U+002EU+002E'), '..');
		});

		it('Pass in "words..", expect "words.."', function () {
			assert.equal(cu.unescapeValue('words..'), 'words..');
		});

		it('Pass in "word.s.", expect "word.s."', function () {
			assert.equal(cu.unescapeValue('word.s.'), 'word.s.');
		});

		it('Pass in "wordsU+002EU+002E", expect "wordsU+002EU+002E"', function () {
			assert.equal(cu.unescapeValue('wordsU+002EU+002E'), 'wordsU+002EU+002E');
		});

		it('Pass in "wordU+002EsU+002E", expect "wordU+002EsU+002E"', function () {
			assert.equal(cu.unescapeValue('wordU+002EsU+002E'), 'wordU+002EsU+002E');
		});

		it('Pass in "hello/this/is/some/text", expect "hello/this/is/some/text"', function () {
			assert.equal(cu.unescapeValue('hello/this/is/some/text'), 'hello/this/is/some/text');
		});

		it('Pass in "helloU+002FthisU+002FisU+002FsomeU+002Ftext" , expect "hello/this/is/some/text"', function () {
			assert.equal(cu.unescapeValue('helloU+002FthisU+002FisU+002FsomeU+002Ftext'), 'hello/this/is/some/text');
		});
	});

	describe('Test compareVersions', function () {
		let versions = [
			new upgrade_directive('1.1.1'),
			new upgrade_directive('1.1.0'),
			new upgrade_directive('1.2.1'),
			new upgrade_directive('2.1.5'),
		];
		it('test matching lowest version number, should include 3 later versions', function () {
			let oldVersion = '1.1.0';
			let filtered_versions = versions.sort(cu.compareVersions).filter(function (curr_version) {
				return curr_version.version > oldVersion;
			});
			assert.equal(filtered_versions.length, 3, `expected 3 version numbers, found ${filtered_versions.length}`);
			assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not filtered out.');
		});

		it('test with greater version number, expect 0 returned.', function () {
			let oldVersion = '3.1.0';
			let filtered_versions = versions.sort(cu.compareVersions).filter(function (curr_version) {
				return curr_version.version > oldVersion;
			});
			assert.equal(filtered_versions.length, 0, `expected 0 version numbers, found ${filtered_versions.length}`);
			assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not filtered out.');
		});
		it('test with smaller version number, expect 4 returned.', function () {
			let oldVersion = '0.0.1';
			let filtered_versions = versions.sort(cu.compareVersions).filter(function (curr_version) {
				return curr_version.version > oldVersion;
			});
			assert.equal(filtered_versions.length, 4, `expected 4 version numbers, found ${filtered_versions.length}`);
			assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not found.');
		});
		it('test with middle version number, expect 1 returned.', function () {
			let oldVersion = '1.2.1';
			let filtered_versions = versions.sort(cu.compareVersions).filter(function (curr_version) {
				return curr_version.version > oldVersion;
			});
			assert.equal(filtered_versions.length, 1, `expected 1 version numbers, found ${filtered_versions.length}`);
			assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not found.');
		});
		it('test 4 number version sorting', function () {
			let oldVersion = '1.1.0';
			let copy = [...versions];
			copy.push(new upgrade_directive('1.1.1.22'));
			let filtered_versions = copy.sort(cu.compareVersions).filter(function (curr_version) {
				return curr_version.version > oldVersion;
			});
			assert.equal(filtered_versions.length, 4, `expected 4 version numbers, found ${filtered_versions.length}`);
			assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not filtered out.');
			assert.equal(
				filtered_versions[0].version,
				'1.1.1',
				`expected version number 1.1.1, found ${filtered_versions.length}`
			);
			assert.equal(
				filtered_versions[1].version,
				'1.1.1.22',
				`expected version number 1.1.1.22, found ${filtered_versions.length}`
			);
			assert.equal(
				filtered_versions[2].version,
				'1.2.1',
				`expected version number 1.2.1, found ${filtered_versions.length}`
			);
			assert.equal(
				filtered_versions[3].version,
				'2.1.5',
				`expected version number 2.1.5, found ${filtered_versions.length}`
			);
		});
		it('test comparing 2 versions resulting in an upgrade', function () {
			let oldVersion = '1.1.0';
			let new_version = '2.0.0';
			let should_upgrade = cu.compareVersions(oldVersion, new_version);
			assert.ok(should_upgrade < 0, `expected returned value less than than 0`);
		});
		it('test comparing 2 equal versions resulting in versions being up to date', function () {
			let oldVersion = '1.1.0';
			let new_version = '1.1.0';
			let should_upgrade = cu.compareVersions(oldVersion, new_version);
			assert.ok(should_upgrade === 0, `expected returned value should be 0`);
		});
		it('test comparing 2 versions with old version being greater than new version', function () {
			let oldVersion = '2.1.0';
			let new_version = '1.1.0';
			let should_upgrade = cu.compareVersions(oldVersion, new_version);
			assert.ok(should_upgrade > 0, `expected returned value greater than than 0`);
		});
		it('test comparing 2 versions with new version having 4 version', function () {
			let oldVersion = '1.1.0';
			let new_version = '1.1.0.1';
			let should_upgrade = cu.compareVersions(oldVersion, new_version);
			assert.ok(should_upgrade < 0, `expected returned value less than than 0`);
		});
		it('test comparing 2 versions with new and old version having 4 version', function () {
			let oldVersion = '1.1.0.1';
			let new_version = '1.1.0.122';
			let should_upgrade = cu.compareVersions(oldVersion, new_version);
			assert.ok(should_upgrade < 0, `expected returned value less than than 0`);
		});
	});

	describe('Test isClusterOperation', function () {
		it('Test nominal case of isClusterOperation', function () {
			assert.equal(cu.isClusterOperation('insert'), true, 'Expected true result');
		});
		it('Test strange casing in isClusterOperation', function () {
			assert.equal(cu.isClusterOperation('InserT'), true, 'Expected true result');
		});
		it('Test operation not in cluster ops, expect false', function () {
			assert.equal(cu.isClusterOperation('alter_user'), false, 'Expected false result');
		});
		it('Test case, expect true', function () {
			assert.equal(cu.isClusterOperation('INSERT'), true, 'Expected true result');
		});
		it('Test empty operation, expect false', function () {
			assert.equal(cu.isClusterOperation(null), false, 'Expected false result');
		});
		it('Test undefined operation, expect false', function () {
			assert.equal(cu.isClusterOperation(undefined), false, 'Expected false result');
		});
		it('Test numeric operation, expect false', function () {
			assert.equal(cu.isClusterOperation(42), false, 'Expected false result');
		});
	});

	describe('Test checkGlobalSchemaTable', function () {
		before(() => {
			global.hdb_schema = {
				dev: {
					perro: {},
				},
			};
		});

		after(() => {
			delete global.hdb_schema['dev'];
		});

		it('should throw schema does not exist message', function () {
			try {
				cu.checkGlobalSchemaTable('dogsOfHogwarts', 'wizards');
			} catch (err) {
				assert.equal(
					err,
					`schema dogsOfHogwarts does not exist`,
					'Expected "schema dogsOfHogwarts does not exist" result'
				);
			}
		});

		it('should throw table does not exist message', function () {
			try {
				cu.checkGlobalSchemaTable('dev', 'dumbledog');
			} catch (err) {
				assert.equal(err, `table dev.dumbledog does not exist`, 'Expected "table dev.dumbledog does not exist" result');
			}
		});
	});

	describe('Test getClusterUser', function () {
		it('Test nominal case of isClusterOperation', function () {
			assert.equal(cu.getClusterUser(USERS, CLUSTER_USER_NAME), USERS.get(CLUSTER_USER_NAME), 'Expected user');
		});
		it('Test non-existent cluster_user', function () {
			assert.equal(cu.getClusterUser(USERS, CLUSTER_USER_NAME + 1), undefined, 'Expected true result');
		});
		it('Test no cluster_user_name', function () {
			assert.equal(cu.getClusterUser(USERS, null), undefined, 'Expected undefined result');
		});
		it('Test no users', function () {
			assert.equal(cu.getClusterUser(null, CLUSTER_USER_NAME), undefined, 'Expected undefined result');
		});
	});

	describe('Test promisifyPapaParse', () => {
		let a_csv_string =
			'shipperid,companyname,phone\n' +
			'1,Speedy Express,(503) 555-9831\n' +
			'2,United Package,(503) 555-3199\n' +
			'3,Federal Shipping,(503) 555-9931';

		let expected_result = [
			[
				{ shipperid: 1, companyname: 'Speedy Express', phone: '(503) 555-9831' },
				{ shipperid: 2, companyname: 'United Package', phone: '(503) 555-3199' },
			],
			[{ shipperid: 3, companyname: 'Federal Shipping', phone: '(503) 555-9931' }],
		];

		let string_stream = new stream.Readable();
		string_stream.push(a_csv_string);
		string_stream.push(null);
		cu.promisifyPapaParse();
		let parsed_result = [];

		let chunk_function = (reject, results, parser) => {
			parsed_result.push(results.data);
		};

		let type_function = (value) => {
			//TODO test HDB attribute schema casting
			return cu.autoCast(value);
		};

		it('Test csv stream is parsed as expected', async () => {
			await papa_parse.parsePromise(string_stream, chunk_function, type_function);
			expect(parsed_result).to.eql(expected_result);
		});
	});

	describe('Test removeBOM function', () => {
		let string_with_bom = '\ufeffHey, I am a string used for a unit test.';
		let string_without_bom = 'Hey, I am a string used for a unit test.';
		let not_a_string = true;

		it('Test that the BOM is removed', () => {
			let result = cu.removeBOM(string_with_bom);
			expect(result).to.equal(string_without_bom);
		});

		it('Test if parameter not string error thrown', () => {
			let error;

			try {
				cu.removeBOM(not_a_string);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal('Expected a string, got boolean');
			expect(error).to.be.instanceof(Error);
		});
	});

	describe('Test checkProcessRunning', () => {
		it('Test happy path', async () => {
			let pslist_rewire = cu_rewire.__set__('psList', {
				findPs: async (name) => {
					return PSLIST_HELIUM_RETURN;
				},
			});

			let err = undefined;
			try {
				await cu_rewire.checkProcessRunning('helium');
			} catch (e) {
				err = e;
			}

			assert.equal(err, undefined);

			pslist_rewire();
		});

		it('Test no process running', async () => {
			let pslist_rewire = cu_rewire.__set__('psList', {
				findPs: async (name) => {
					return [];
				},
			});

			let err = undefined;
			try {
				await cu_rewire.checkProcessRunning('helium');
			} catch (e) {
				err = e;
			}

			assert.deepEqual(err, new Error('process helium was not started'));
			pslist_rewire();
		});
	});

	// we don't use hdb_schema anymore
	describe.skip('Test checkSchemaTableExist', () => {
		let test_obj = {
			schema: 'sensor_data',
			table: 'temperature',
		};

		it('Test no schema', () => {
			global.hdb_schema = 'test_no_schema';
			let result = cu_rewire.checkSchemaTableExist(test_obj.schema, test_obj.table);

			expect(result).to.equal(`Schema '${test_obj.schema}' does not exist`);
		});

		it('Test no table', () => {
			global.hdb_schema = {
				[test_obj.schema]: {
					test_no_table: {},
				},
			};
			let result = cu_rewire.checkSchemaTableExist(test_obj.schema, test_obj.table);

			expect(result).to.equal(`Table '${test_obj.schema}.${test_obj.table}' does not exist`);
		});
	});

	describe('Test isObject', () => {
		it('Should return true with simple object', () => {
			let result = cu_rewire.isObject({ id: 1, name: 'Harper' });
			expect(result).to.be.true;
		});

		it('Should return true with array', () => {
			let result = cu_rewire.isObject([1, 2, 3]);
			expect(result).to.be.true;
		});

		it('Should return false with string', () => {
			let result = cu_rewire.isObject('{id: 1}');
			expect(result).to.be.false;
		});

		it('Should return false with null', () => {
			let result = cu_rewire.isObject(null);
			expect(result).to.be.false;
		});
	});

	it('Test ms_to_time', () => {
		const a = cu_rewire.ms_to_time(123456);
		expect(a).to.equal('2m 3s');
		const b = cu_rewire.ms_to_time(123456345);
		expect(b).to.equal('1d 10h 17m 36s');
		const c = cu_rewire.ms_to_time(1672345634534);
		expect(c).to.equal('52y 27d 20h 27m 14s');
	});
});

// TODO: Commented this out for now due to it breaking tests on the CI server.  Will revisit later.
// https://harperdb.atlassian.net/browse/CORE-273
/*
describe('Test isHarperRunning', () => {
    let child;

    // on run of harperdb, if hdb is not running it will output 2 data events. First for the dog, second for the successfully started
    // we test to handle where it is already running to force a failure
    // we test the 2nd event to make sure we get the success started message.
    it('Should start HDB and return starting message', (done)=>{
        child = spawn('node', ['harperdb']);
        let x = 0;
describe('Test isServerRunning', () => {
    let ps_list_stub;

    before(() => {
        ps_list_stub = sinon.stub(ps_list, 'findPs');
    });

    after(() => {
        sinon.resetHistory();
        sinon.restore();
    });

    it('Test true is returned if ps list is returned', async () => {
        ps_list_stub.resolves('a process');
        const result = await cu_rewire.isServerRunning();
        expect(result).to.be.true;
    });

    it('Test false is returned if no ps list is returned', async () => {
        ps_list_stub.resolves('');
        const result = await cu_rewire.isServerRunning();
        expect(result).to.be.false;
    });
});


describe('Test stopProcess', () => {
    let user_info_stub;
    let find_ps_stub;
    let process_kill_stub;

    before(() => {
        user_info_stub = sinon.stub(os, 'userInfo');
        find_ps_stub = sinon.stub(ps_list, 'findPs');
        process_kill_stub = sinon.stub(process, 'kill');
    });

    after(() => {
        sinon.resetHistory();
        sinon.restore();
    });

    it('Test process kil is called for process', async () => {
        user_info_stub.returns({ uid: 123 });
        find_ps_stub.resolves([{ pid: 5839, uid: 123 }]);
        await cu_rewire.stopProcess('test123abc.js');
        expect(process_kill_stub.args[0][0]).to.equal(5839);
    });
});
*/
