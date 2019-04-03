"use strict"
/**
 * Test the common_utils_test module.
 */

const assert = require('assert');
const cu = require('../../utility/common_utils');
const test_utils = require('../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.changeProcessToBinDir();

const upgrade_directive = require('../../upgrade/UpgradeDirective');
const env_variable = require('../../upgrade/EnvironmentVariable');
const ALL_SPACES = '     ';

describe(`Test errorizeMessage`, function () {
    it('Nominal, pass message', function () {
        let err = cu.errorizeMessage('This is an error');
        assert.equal((err instanceof Error), true);
    });

    it('Pass in null', function () {
        let err = cu.errorizeMessage(null);
        assert.equal((err instanceof Error), true);
    });

    it('Pass in undefined', function () {
        let err = cu.errorizeMessage(null);
        assert.equal((err instanceof Error), true);
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

describe(`Test buildFolderPath`, function(){
    it(`Pass in null, expect empty string`, function(){
        assert.equal(cu.buildFolderPath(null), "");
    });

    it(`Pass in empty string, expect empty string`, function(){
        assert.equal(cu.buildFolderPath(''), "");
    });

    it(`Pass in values with mixed null and empty string, expect double slashes where empty values would be`, function(){
        assert.equal(cu.buildFolderPath('opt', null, 'test', '', 'data'), "opt//test//data");
    });

    it(`Pass in values mixed with numbers and strings, expect a path`, function(){
        assert.equal(cu.buildFolderPath('opt', 1, 'test', 45, 'data', '333-55'), 'opt/1/test/45/data/333-55');
    });
});


describe(`Test isBoolean`, function(){
    it(`Pass in null, expect false`, function(){
        assert.equal(cu.isBoolean(null), false);
    });

    it(`Pass in undefined, expect false`, function(){
        assert.equal(cu.isBoolean(undefined), false);
    });

    it(`Pass in empty string, expect false`, function(){
        assert.equal(cu.isBoolean(""), false);
    });

    it(`Pass in spaces, expect false`, function(){
        assert.equal(cu.isBoolean("   "), false);
    });

    it(`Pass in string, expect false`, function(){
        assert.equal(cu.isBoolean("am i false?"), false);
    });

    it(`Pass in 1, expect false`, function(){
        assert.equal(cu.isBoolean(1), false);
    });

    it(`Pass in 0, expect false`, function(){
        assert.equal(cu.isBoolean(0), false);
    });

    it(`Pass in number, expect false`, function(){
        assert.equal(cu.isBoolean(2.3455), false);
    });

    it(`Pass in array, expect false`, function(){
        assert.equal(cu.isBoolean([2,'stuff']), false);
    });

    it(`Pass in object, expect false`, function(){
        assert.equal(cu.isBoolean({active: true}), false);
    });

    it(`Pass in true, expect true`, function(){
        assert.equal(cu.isBoolean(true), true);
    });

    it(`Pass in false, expect true`, function(){
        assert.equal(cu.isBoolean(false), true);
    });

    it(`Pass in evaluation, expect true`, function(){
        assert.equal(cu.isBoolean(2>1), true);
    });
});

describe(`Test autoCast`, function(){
    it(`Pass in null, expect null`, function(){
        assert.equal(cu.autoCast(null), null);
    });

    it(`Pass in undefined, expect undefined`, function(){
        assert.equal(cu.autoCast(undefined), undefined);
    });

    it(`Pass in empty string, expect empty string`, function(){
        assert.equal(cu.autoCast(""), "");
    });

    it(`Pass in spaces, expect spaces`, function(){
        assert.equal(cu.autoCast("   "), "   ");
    });

    it(`Pass in string of null, expect null`, function(){
        assert.equal(cu.autoCast("null"), null);
    });

    it(`Pass in string of undefined, expect undefined`, function(){
        assert.equal(cu.autoCast("undefined"), undefined);
    });

    it(`Pass in string of true, expect boolean true`, function(){
        assert.equal(cu.autoCast("true"), true);
    });

    it(`Pass in string of 42, expect number 42`, function(){
        assert.equal(cu.autoCast("42"), 42);
    });

    it(`Pass in string of 42.42, expect number 42.42`, function(){
        assert.equal(cu.autoCast("42.42"), 42.42);
    });

    it(`Pass in string of '0102', expect number 102`, function(){
        assert.equal(cu.autoCast("0102"), 102);
    });

    it(`Pass in string of sigle entry number array, expect real array`, function(){
        assert.deepEqual(cu.autoCast("[1]"), [1]);
    });

    it(`Pass in string of number array, expect real array`, function(){
        assert.deepEqual(cu.autoCast("[1,2,3]"), [1,2,3]);
    });

    it(`Pass in string surrounded by brackets, expect string surrounded by brackets`, function(){
        assert.equal(cu.autoCast("[1 2 3]"), "[1 2 3]");
    });

    it(`Pass in string of json object, expect json object`, function(){
        assert.deepEqual(cu.autoCast('{"id":1, "name":"test"}'), {"id":1, "name":"test"});
    });

    it(`Pass in false, expect false`, function(){
        assert.strictEqual(cu.autoCast(false), false);
    });

    it(`Pass in true, expect true`, function(){
        assert.strictEqual(cu.autoCast(true), true);
    });

    it(`Pass in 1, expect 1`, function(){
        assert.strictEqual(cu.autoCast(1), 1);
    });

    it(`Pass in 0, expect 0`, function(){
        assert.strictEqual(cu.autoCast(0), 0);
    });

    it(`Pass in date , expect date back`, function(){
        assert.deepEqual(cu.autoCast(new Date('2019-01-01')), new Date('2019-01-01'));
    });

    it(`Pass in array , expect array back`, function(){
        let assert_array = ['sup', 'dude'];
        assert.deepEqual(cu.autoCast(assert_array), assert_array);
    });

    it(`Pass in array of various values , expect array back`, function(){
        let assert_array = [1, null, undefined, NaN, 2];
        assert.deepEqual(cu.autoCast(assert_array), assert_array);
    });

    it(`Pass in object , expect object back`, function(){
        let assert_object = {id:1, stuff: 'here'};
        assert.deepEqual(cu.autoCast(assert_object), assert_object);
    });
});

describe('Test escapeRawValue', function(){
    it('Pass in null, expect null', function(){
        assert.equal(cu.escapeRawValue(null), null);
    });

    it('Pass in undefined, expect undefined', function(){
        assert.equal(cu.escapeRawValue(undefined), undefined);
    });

    it('Pass in "", expect ""', function(){
        assert.equal(cu.escapeRawValue(""), "");
    });

    it('Pass in ".", expect "U+002E"', function(){
        assert.equal(cu.escapeRawValue("."), "U+002E");
    });

    it('Pass in "..", expect "U+002EU+002E"', function(){
        assert.equal(cu.escapeRawValue(".."), "U+002EU+002E");
    });

    it('Pass in "...", expect "..."', function(){
        assert.equal(cu.escapeRawValue("..."), "...");
    });

    it('Pass in "words..", expect "words.."', function(){
        assert.equal(cu.escapeRawValue("words.."), "words..");
    });

    it('Pass in "word.s.", expect "word.s."', function(){
        assert.equal(cu.escapeRawValue("word.s."), "word.s.");
    });

    it('Pass in "hello/this/is/some/text", expect "helloU+002FthisU+002FisU+002FsomeU+002Ftext"', function(){
        assert.equal(cu.escapeRawValue("hello/this/is/some/text"), "helloU+002FthisU+002FisU+002FsomeU+002Ftext");
    });
});

describe('Test unescapeValue', function(){
    it('Pass in null, expect null', function(){
        assert.equal(cu.unescapeValue(null), null);
    });

    it('Pass in undefined, expect undefined', function(){
        assert.equal(cu.unescapeValue(undefined), undefined);
    });

    it('Pass in "", expect ""', function(){
        assert.equal(cu.unescapeValue(""), "");
    });

    it('Pass in "U+002E", expect "."', function(){
        assert.equal(cu.unescapeValue("U+002E"), ".");
    });

    it('Pass in "U+002EU+002E", expect ".."', function(){
        assert.equal(cu.unescapeValue("U+002EU+002E"), "..");
    });

    it('Pass in "words..", expect "words.."', function(){
        assert.equal(cu.unescapeValue("words.."), "words..");
    });

    it('Pass in "word.s.", expect "word.s."', function(){
        assert.equal(cu.unescapeValue("word.s."), "word.s.");
    });

    it('Pass in "wordsU+002EU+002E", expect "wordsU+002EU+002E"', function(){
        assert.equal(cu.unescapeValue("wordsU+002EU+002E"), "wordsU+002EU+002E");
    });

    it('Pass in "wordU+002EsU+002E", expect "wordU+002EsU+002E"', function(){
        assert.equal(cu.unescapeValue("wordU+002EsU+002E"), "wordU+002EsU+002E");
    });

    it('Pass in "hello/this/is/some/text", expect "hello/this/is/some/text"', function(){
        assert.equal(cu.unescapeValue("hello/this/is/some/text"), "hello/this/is/some/text");
    });

    it('Pass in "helloU+002FthisU+002FisU+002FsomeU+002Ftext" , expect "hello/this/is/some/text"', function(){
        assert.equal(cu.unescapeValue("helloU+002FthisU+002FisU+002FsomeU+002Ftext"), "hello/this/is/some/text");
    });
});

describe('Test compareVersions', function() {
    let versions = [
        new upgrade_directive('1.1.1'),
        new upgrade_directive('1.1.0'),
        new upgrade_directive('1.2.1'),
        new upgrade_directive('2.1.5')
    ];
    it('test matching lowest version number, should include 3 later versions', function() {
        let oldVersion = '1.1.0';
        let filtered_versions = versions.sort(cu.compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 3, `expected 3 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not filtered out.');
    });

    it('test with greater version number, expect 0 returned.', function() {
        let oldVersion = '3.1.0';
        let filtered_versions = versions.sort(cu.compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 0, `expected 0 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not filtered out.');
    });
    it('test with smaller version number, expect 4 returned.', function() {
        let oldVersion = '0.0.1';
        let filtered_versions = versions.sort(cu.compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 4, `expected 4 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not found.');
    });
    it('test with middle version number, expect 1 returned.', function() {
        let oldVersion = '1.2.1';
        let filtered_versions = versions.sort(cu.compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 1, `expected 1 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not found.');
    });
    it('test 4 number version sorting', function() {
        let oldVersion = '1.1.0';
        let copy = [...versions];
        copy.push(new upgrade_directive('1.1.1.22'));
        let filtered_versions = copy.sort(cu.compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 4, `expected 4 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not filtered out.');
        assert.equal(filtered_versions[0].version, '1.1.1', `expected version number 1.1.1, found ${filtered_versions.length}`);
        assert.equal(filtered_versions[1].version, '1.1.1.22', `expected version number 1.1.1.22, found ${filtered_versions.length}`);
        assert.equal(filtered_versions[2].version, '1.2.1', `expected version number 1.2.1, found ${filtered_versions.length}`);
        assert.equal(filtered_versions[3].version, '2.1.5', `expected version number 2.1.5, found ${filtered_versions.length}`);
    });
    it('test comparing 2 versions resulting in an upgrade', function() {
        let oldVersion = '1.1.0';
        let new_version = '2.0.0';
        let should_upgrade = cu.compareVersions(oldVersion, new_version);
        assert.ok(should_upgrade < 0, `expected returned value less than than 0`);
    });
    it('test comparing 2 equal versions resulting in versions being up to date', function() {
        let oldVersion = '1.1.0';
        let new_version = '1.1.0';
        let should_upgrade = cu.compareVersions(oldVersion, new_version);
        assert.ok(should_upgrade === 0, `expected returned value should be 0`);
    });
    it('test comparing 2 versions with old version being greater than new version', function() {
        let oldVersion = '2.1.0';
        let new_version = '1.1.0';
        let should_upgrade = cu.compareVersions(oldVersion, new_version);
        assert.ok(should_upgrade > 0, `expected returned value greater than than 0`);
    });
    it('test comparing 2 versions with new version having 4 version', function() {
        let oldVersion = '1.1.0';
        let new_version = '1.1.0.1';
        let should_upgrade = cu.compareVersions(oldVersion, new_version);
        assert.ok(should_upgrade < 0, `expected returned value less than than 0`);
    });
    it('test comparing 2 versions with new and old version having 4 version', function() {
        let oldVersion = '1.1.0.1';
        let new_version = '1.1.0.122';
        let should_upgrade = cu.compareVersions(oldVersion, new_version);
        assert.ok(should_upgrade < 0, `expected returned value less than than 0`);
    });
});

describe('Test isClusterOperation', function() {
    it('Test nominal case of isClusterOperation', function() {
       assert.equal(cu.isClusterOperation('create_schema'), true, 'Expected true result');
    });
    it('Test strange casing in isClusterOperation', function() {
        assert.equal(cu.isClusterOperation('crEaTe_Schema'), true, 'Expected true result');
    });
    it('Test operation not in cluster ops, expect false', function() {
        assert.equal(cu.isClusterOperation('alter_user'), false, 'Expected false result');
    });
    it('Test case, expect true', function() {
        assert.equal(cu.isClusterOperation('CREATE_SCHEMA'), true, 'Expected true result');
    });
    it('Test empty operation, expect false', function() {
        assert.equal(cu.isClusterOperation(null), false, 'Expected false result');
    });
    it('Test undefined operation, expect false', function() {
        assert.equal(cu.isClusterOperation(undefined), false, 'Expected false result');
    });
    it('Test numeric operation, expect false', function() {
        assert.equal(cu.isClusterOperation(42), false, 'Expected false result');
    });
});