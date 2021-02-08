'use strict';

const rewire = require('rewire');
const search_util = rewire('../../../utility/lmdb/searchUtility');
const fs = require('fs-extra');
const environment_utility = rewire('../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../utility/lmdb/writeUtility');
const test_utils = require('../../test_utils');
const path = require('path');
const assert = require('assert');
const test_data = require('../../personData.json');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'lmdbTest');
const TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';

const PERSON_ATTRIBUTES = ['id', 'first_name', 'state', 'age', 'alive', 'birth_month'];

const TIMESTAMP = Date.now();

describe('test startsWith function', ()=> {
    let env;
    let date_stub;
    before(async () => {
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        await fs.mkdirp(BASE_TEST_PATH);
        global.lmdb_map = undefined;
        env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
        await environment_utility.createDBI(env, 'id', false, true);
        await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(PERSON_ATTRIBUTES), test_utils.deepClone(test_data));
    });

    after(async () => {
        date_stub.restore();
        env.close();
        await fs.remove(BASE_TEST_PATH);
        global.lmdb_map = undefined;
    });

    it("test search on first_name limit 20", () => {
        let expected = { "0": { "first_name": "Jerrold", "id": 0 }, "10": { "first_name": "Jerrell", "id": 10 }, "14": { "first_name": "Cierra", "id": 14 }, "18": { "first_name": "Xander", "id": 18 }, "21": { "first_name": "Frederik", "id": 21 }, "28": { "first_name": "Maverick", "id": 28 }, "46": { "first_name": "Jerrod", "id": 46 }, "49": { "first_name": "Jerrod", "id": 49 }, "51": { "first_name": "Herta", "id": 51 }, "67": { "first_name": "Spencer", "id": 67 }, "74": { "first_name": "Pierce", "id": 74 }, "75": { "first_name": "Alverta", "id": 75 }, "83": { "first_name": "Kameron", "id": 83 }, "92": { "first_name": "Gerhard", "id": 92 }, "95": { "first_name": "Terrance", "id": 95 }, "108": { "first_name": "Everette", "id": 108 }, "127": { "first_name": "Bernardo", "id": 127 }, "136": { "first_name": "Meredith", "id": 136 }, "146": { "first_name": "Mervin", "id": 146 }, "161": { "first_name": "Berta", "id": 161 } };

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', false, 20], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name offset 20", () => {
        let expected = { "166": { "first_name": "Gilberto", "id": 166 }, "174": { "first_name": "Schuyler", "id": 174 }, "175": { "first_name": "Deron", "id": 175 }, "191": { "first_name": "Gerry", "id": 191 }, "199": { "first_name": "Gerard", "id": 199 }, "204": { "first_name": "Jermaine", "id": 204 }, "218": { "first_name": "Piper", "id": 218 }, "223": { "first_name": "Frederik", "id": 223 }, "230": { "first_name": "Derrick", "id": 230 }, "252": { "first_name": "Jermaine", "id": 252 }, "282": { "first_name": "Rupert", "id": 282 }, "285": { "first_name": "Laverna", "id": 285 }, "291": { "first_name": "Vern", "id": 291 }, "306": { "first_name": "Cierra", "id": 306 }, "314": { "first_name": "Theresia", "id": 314 }, "328": { "first_name": "Hertha", "id": 328 }, "349": { "first_name": "Everardo", "id": 349 }, "371": { "first_name": "Kiera", "id": 371 }, "376": { "first_name": "Gerhard", "id": 376 }, "382": { "first_name": "Hermann", "id": 382 }, "393": { "first_name": "Zackery", "id": 393 }, "398": { "first_name": "Zackery", "id": 398 }, "417": { "first_name": "Rodger", "id": 417 }, "423": { "first_name": "Sylvester", "id": 423 }, "424": { "first_name": "Jerrod", "id": 424 }, "451": { "first_name": "Gerhard", "id": 451 }, "453": { "first_name": "Maverick", "id": 453 }, "461": { "first_name": "Terrance", "id": 461 }, "465": { "first_name": "Cicero", "id": 465 }, "470": { "first_name": "Webster", "id": 470 }, "475": { "first_name": "Everette", "id": 475 }, "491": { "first_name": "Jeromy", "id": 491 }, "516": { "first_name": "Verna", "id": 516 }, "518": { "first_name": "Abner", "id": 518 }, "523": { "first_name": "Albert", "id": 523 }, "546": { "first_name": "Norbert", "id": 546 }, "556": { "first_name": "Jerry", "id": 556 }, "560": { "first_name": "Perry", "id": 560 }, "561": { "first_name": "Javier", "id": 561 }, "570": { "first_name": "Vernon", "id": 570 }, "581": { "first_name": "Porter", "id": 581 }, "584": { "first_name": "Jermey", "id": 584 }, "612": { "first_name": "Beryl", "id": 612 }, "645": { "first_name": "Zachery", "id": 645 }, "646": { "first_name": "Bernice", "id": 646 }, "653": { "first_name": "Sheridan", "id": 653 }, "655": { "first_name": "Hunter", "id": 655 }, "662": { "first_name": "Adelbert", "id": 662 }, "679": { "first_name": "Anderson", "id": 679 }, "686": { "first_name": "Meredith", "id": 686 }, "697": { "first_name": "Katheryn", "id": 697 }, "707": { "first_name": "Buster", "id": 707 }, "712": { "first_name": "Jerry", "id": 712 }, "726": { "first_name": "Jerrell", "id": 726 }, "740": { "first_name": "Avery", "id": 740 }, "741": { "first_name": "Gilbert", "id": 741 }, "745": { "first_name": "Roderick", "id": 745 }, "779": { "first_name": "Teresa", "id": 779 }, "790": { "first_name": "Bernice", "id": 790 }, "809": { "first_name": "Ferne", "id": 809 }, "830": { "first_name": "Tanner", "id": 830 }, "848": { "first_name": "Verner", "id": 848 }, "851": { "first_name": "Spencer", "id": 851 }, "858": { "first_name": "Alvera", "id": 858 }, "864": { "first_name": "Teresa", "id": 864 }, "868": { "first_name": "Terence", "id": 868 }, "908": { "first_name": "Everette", "id": 908 }, "924": { "first_name": "Jennyfer", "id": 924 }, "935": { "first_name": "Casper", "id": 935 }, "938": { "first_name": "Verlie", "id": 938 }, "939": { "first_name": "Jenifer", "id": 939 }, "961": { "first_name": "Norbert", "id": 961 }, "965": { "first_name": "Katherine", "id": 965 }, "979": { "first_name": "Delbert", "id": 979 } };

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', false, undefined, 20], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 74);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name limit 20 offset 20", () => {
        let expected = { "166": { "first_name": "Gilberto", "id": 166 }, "174": { "first_name": "Schuyler", "id": 174 }, "175": { "first_name": "Deron", "id": 175 }, "191": { "first_name": "Gerry", "id": 191 }, "199": { "first_name": "Gerard", "id": 199 }, "204": { "first_name": "Jermaine", "id": 204 }, "218": { "first_name": "Piper", "id": 218 }, "223": { "first_name": "Frederik", "id": 223 }, "230": { "first_name": "Derrick", "id": 230 }, "252": { "first_name": "Jermaine", "id": 252 }, "282": { "first_name": "Rupert", "id": 282 }, "285": { "first_name": "Laverna", "id": 285 }, "291": { "first_name": "Vern", "id": 291 }, "306": { "first_name": "Cierra", "id": 306 }, "314": { "first_name": "Theresia", "id": 314 }, "328": { "first_name": "Hertha", "id": 328 }, "349": { "first_name": "Everardo", "id": 349 }, "371": { "first_name": "Kiera", "id": 371 }, "376": { "first_name": "Gerhard", "id": 376 }, "382": { "first_name": "Hermann", "id": 382 } };

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', false, 20, 20], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse", () => {
        let expected = { "0": { "first_name": "Jerrold", "id": 0 }, "10": { "first_name": "Jerrell", "id": 10 }, "14": { "first_name": "Cierra", "id": 14 }, "18": { "first_name": "Xander", "id": 18 }, "21": { "first_name": "Frederik", "id": 21 }, "28": { "first_name": "Maverick", "id": 28 }, "46": { "first_name": "Jerrod", "id": 46 }, "49": { "first_name": "Jerrod", "id": 49 }, "51": { "first_name": "Herta", "id": 51 }, "67": { "first_name": "Spencer", "id": 67 }, "74": { "first_name": "Pierce", "id": 74 }, "75": { "first_name": "Alverta", "id": 75 }, "83": { "first_name": "Kameron", "id": 83 }, "92": { "first_name": "Gerhard", "id": 92 }, "95": { "first_name": "Terrance", "id": 95 }, "108": { "first_name": "Everette", "id": 108 }, "127": { "first_name": "Bernardo", "id": 127 }, "136": { "first_name": "Meredith", "id": 136 }, "146": { "first_name": "Mervin", "id": 146 }, "161": { "first_name": "Berta", "id": 161 }, "166": { "first_name": "Gilberto", "id": 166 }, "174": { "first_name": "Schuyler", "id": 174 }, "175": { "first_name": "Deron", "id": 175 }, "191": { "first_name": "Gerry", "id": 191 }, "199": { "first_name": "Gerard", "id": 199 }, "204": { "first_name": "Jermaine", "id": 204 }, "218": { "first_name": "Piper", "id": 218 }, "223": { "first_name": "Frederik", "id": 223 }, "230": { "first_name": "Derrick", "id": 230 }, "252": { "first_name": "Jermaine", "id": 252 }, "282": { "first_name": "Rupert", "id": 282 }, "285": { "first_name": "Laverna", "id": 285 }, "291": { "first_name": "Vern", "id": 291 }, "306": { "first_name": "Cierra", "id": 306 }, "314": { "first_name": "Theresia", "id": 314 }, "328": { "first_name": "Hertha", "id": 328 }, "349": { "first_name": "Everardo", "id": 349 }, "371": { "first_name": "Kiera", "id": 371 }, "376": { "first_name": "Gerhard", "id": 376 }, "382": { "first_name": "Hermann", "id": 382 }, "393": { "first_name": "Zackery", "id": 393 }, "398": { "first_name": "Zackery", "id": 398 }, "417": { "first_name": "Rodger", "id": 417 }, "423": { "first_name": "Sylvester", "id": 423 }, "424": { "first_name": "Jerrod", "id": 424 }, "451": { "first_name": "Gerhard", "id": 451 }, "453": { "first_name": "Maverick", "id": 453 }, "461": { "first_name": "Terrance", "id": 461 }, "465": { "first_name": "Cicero", "id": 465 }, "470": { "first_name": "Webster", "id": 470 }, "475": { "first_name": "Everette", "id": 475 }, "491": { "first_name": "Jeromy", "id": 491 }, "516": { "first_name": "Verna", "id": 516 }, "518": { "first_name": "Abner", "id": 518 }, "523": { "first_name": "Albert", "id": 523 }, "546": { "first_name": "Norbert", "id": 546 }, "556": { "first_name": "Jerry", "id": 556 }, "560": { "first_name": "Perry", "id": 560 }, "561": { "first_name": "Javier", "id": 561 }, "570": { "first_name": "Vernon", "id": 570 }, "581": { "first_name": "Porter", "id": 581 }, "584": { "first_name": "Jermey", "id": 584 }, "612": { "first_name": "Beryl", "id": 612 }, "645": { "first_name": "Zachery", "id": 645 }, "646": { "first_name": "Bernice", "id": 646 }, "653": { "first_name": "Sheridan", "id": 653 }, "655": { "first_name": "Hunter", "id": 655 }, "662": { "first_name": "Adelbert", "id": 662 }, "679": { "first_name": "Anderson", "id": 679 }, "686": { "first_name": "Meredith", "id": 686 }, "697": { "first_name": "Katheryn", "id": 697 }, "707": { "first_name": "Buster", "id": 707 }, "712": { "first_name": "Jerry", "id": 712 }, "726": { "first_name": "Jerrell", "id": 726 }, "740": { "first_name": "Avery", "id": 740 }, "741": { "first_name": "Gilbert", "id": 741 }, "745": { "first_name": "Roderick", "id": 745 }, "779": { "first_name": "Teresa", "id": 779 }, "790": { "first_name": "Bernice", "id": 790 }, "809": { "first_name": "Ferne", "id": 809 }, "830": { "first_name": "Tanner", "id": 830 }, "848": { "first_name": "Verner", "id": 848 }, "851": { "first_name": "Spencer", "id": 851 }, "858": { "first_name": "Alvera", "id": 858 }, "864": { "first_name": "Teresa", "id": 864 }, "868": { "first_name": "Terence", "id": 868 }, "908": { "first_name": "Everette", "id": 908 }, "924": { "first_name": "Jennyfer", "id": 924 }, "935": { "first_name": "Casper", "id": 935 }, "938": { "first_name": "Verlie", "id": 938 }, "939": { "first_name": "Jenifer", "id": 939 }, "961": { "first_name": "Norbert", "id": 961 }, "965": { "first_name": "Katherine", "id": 965 }, "979": { "first_name": "Delbert", "id": 979 } };

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', true], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 94);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse limit 20", () => {
        let expected = { "740": { "first_name": "Avery", "id": 740 }, "741": { "first_name": "Gilbert", "id": 741 }, "745": { "first_name": "Roderick", "id": 745 }, "779": { "first_name": "Teresa", "id": 779 }, "790": { "first_name": "Bernice", "id": 790 }, "809": { "first_name": "Ferne", "id": 809 }, "830": { "first_name": "Tanner", "id": 830 }, "848": { "first_name": "Verner", "id": 848 }, "851": { "first_name": "Spencer", "id": 851 }, "858": { "first_name": "Alvera", "id": 858 }, "864": { "first_name": "Teresa", "id": 864 }, "868": { "first_name": "Terence", "id": 868 }, "908": { "first_name": "Everette", "id": 908 }, "924": { "first_name": "Jennyfer", "id": 924 }, "935": { "first_name": "Casper", "id": 935 }, "938": { "first_name": "Verlie", "id": 938 }, "939": { "first_name": "Jenifer", "id": 939 }, "961": { "first_name": "Norbert", "id": 961 }, "965": { "first_name": "Katherine", "id": 965 }, "979": { "first_name": "Delbert", "id": 979 } };

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', true, 20], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 20);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse offset 20", () => {
        let expected = { "0": { "first_name": "Jerrold", "id": 0 }, "10": { "first_name": "Jerrell", "id": 10 }, "14": { "first_name": "Cierra", "id": 14 }, "18": { "first_name": "Xander", "id": 18 }, "21": { "first_name": "Frederik", "id": 21 }, "28": { "first_name": "Maverick", "id": 28 }, "46": { "first_name": "Jerrod", "id": 46 }, "49": { "first_name": "Jerrod", "id": 49 }, "51": { "first_name": "Herta", "id": 51 }, "67": { "first_name": "Spencer", "id": 67 }, "74": { "first_name": "Pierce", "id": 74 }, "75": { "first_name": "Alverta", "id": 75 }, "83": { "first_name": "Kameron", "id": 83 }, "92": { "first_name": "Gerhard", "id": 92 }, "95": { "first_name": "Terrance", "id": 95 }, "108": { "first_name": "Everette", "id": 108 }, "127": { "first_name": "Bernardo", "id": 127 }, "136": { "first_name": "Meredith", "id": 136 }, "146": { "first_name": "Mervin", "id": 146 }, "161": { "first_name": "Berta", "id": 161 }, "166": { "first_name": "Gilberto", "id": 166 }, "174": { "first_name": "Schuyler", "id": 174 }, "175": { "first_name": "Deron", "id": 175 }, "191": { "first_name": "Gerry", "id": 191 }, "199": { "first_name": "Gerard", "id": 199 }, "204": { "first_name": "Jermaine", "id": 204 }, "218": { "first_name": "Piper", "id": 218 }, "223": { "first_name": "Frederik", "id": 223 }, "230": { "first_name": "Derrick", "id": 230 }, "252": { "first_name": "Jermaine", "id": 252 }, "282": { "first_name": "Rupert", "id": 282 }, "285": { "first_name": "Laverna", "id": 285 }, "291": { "first_name": "Vern", "id": 291 }, "306": { "first_name": "Cierra", "id": 306 }, "314": { "first_name": "Theresia", "id": 314 }, "328": { "first_name": "Hertha", "id": 328 }, "349": { "first_name": "Everardo", "id": 349 }, "371": { "first_name": "Kiera", "id": 371 }, "376": { "first_name": "Gerhard", "id": 376 }, "382": { "first_name": "Hermann", "id": 382 }, "393": { "first_name": "Zackery", "id": 393 }, "398": { "first_name": "Zackery", "id": 398 }, "417": { "first_name": "Rodger", "id": 417 }, "423": { "first_name": "Sylvester", "id": 423 }, "424": { "first_name": "Jerrod", "id": 424 }, "451": { "first_name": "Gerhard", "id": 451 }, "453": { "first_name": "Maverick", "id": 453 }, "461": { "first_name": "Terrance", "id": 461 }, "465": { "first_name": "Cicero", "id": 465 }, "470": { "first_name": "Webster", "id": 470 }, "475": { "first_name": "Everette", "id": 475 }, "491": { "first_name": "Jeromy", "id": 491 }, "516": { "first_name": "Verna", "id": 516 }, "518": { "first_name": "Abner", "id": 518 }, "523": { "first_name": "Albert", "id": 523 }, "546": { "first_name": "Norbert", "id": 546 }, "556": { "first_name": "Jerry", "id": 556 }, "560": { "first_name": "Perry", "id": 560 }, "561": { "first_name": "Javier", "id": 561 }, "570": { "first_name": "Vernon", "id": 570 }, "581": { "first_name": "Porter", "id": 581 }, "584": { "first_name": "Jermey", "id": 584 }, "612": { "first_name": "Beryl", "id": 612 }, "645": { "first_name": "Zachery", "id": 645 }, "646": { "first_name": "Bernice", "id": 646 }, "653": { "first_name": "Sheridan", "id": 653 }, "655": { "first_name": "Hunter", "id": 655 }, "662": { "first_name": "Adelbert", "id": 662 }, "679": { "first_name": "Anderson", "id": 679 }, "686": { "first_name": "Meredith", "id": 686 }, "697": { "first_name": "Katheryn", "id": 697 }, "707": { "first_name": "Buster", "id": 707 }, "712": { "first_name": "Jerry", "id": 712 }, "726": { "first_name": "Jerrell", "id": 726 } };

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', true, undefined, 20], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 74);
        assert.deepEqual(results, expected);
    });

    it("test search on first_name reverse offset 20 limit 20", () => {
        let expected = { "523": { "first_name": "Albert", "id": 523 }, "546": { "first_name": "Norbert", "id": 546 }, "556": { "first_name": "Jerry", "id": 556 }, "560": { "first_name": "Perry", "id": 560 }, "561": { "first_name": "Javier", "id": 561 }, "570": { "first_name": "Vernon", "id": 570 }, "581": { "first_name": "Porter", "id": 581 }, "584": { "first_name": "Jermey", "id": 584 }, "612": { "first_name": "Beryl", "id": 612 }, "645": { "first_name": "Zachery", "id": 645 }, "646": { "first_name": "Bernice", "id": 646 }, "653": { "first_name": "Sheridan", "id": 653 }, "655": { "first_name": "Hunter", "id": 655 }, "662": { "first_name": "Adelbert", "id": 662 }, "679": { "first_name": "Anderson", "id": 679 }, "686": { "first_name": "Meredith", "id": 686 }, "697": { "first_name": "Katheryn", "id": 697 }, "707": { "first_name": "Buster", "id": 707 }, "712": { "first_name": "Jerry", "id": 712 }, "726": { "first_name": "Jerrell", "id": 726 } };

        let results = test_utils.assertErrorSync(search_util.contains, [env, 'id', 'first_name', 'er', true, 20, 20], undefined, 'all arguments');
        assert.deepStrictEqual(Object.keys(results).length, 20);
        assert.deepEqual(results, expected);
    });
});