'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();
let hdb_helium = test_utils.buildHeliumTestVolume();

const rewire = require('rewire');
const heCreateAttribute = require('../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
const heDropAttribute = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heDropAttribute');
const heGenerateDataStoreName = require('../../../../data_layer/harperBridge/heBridge/heUtility/heGenerateDataStoreName');

const chai = require('chai');
const { expect } = chai;

const DROP_ATTR_OBJ_TEST = {
    operation: "drop_attribute",
    schema: "dropAttr",
    table: "dog",
    attribute: "weight"
};

const ATTRIBUTES = ['age', 'height', 'weight', 'address', 'id', 'owner'];
const DATASTORES = ['dropAttr/dog/age', 'dropAttr/dog/height', 'dropAttr/dog/weight', 'dropAttr/dog/address', 'dropAttr/dog/id', 'dropAttr/dog/owner'];

function setupTest() {
    try {
        ATTRIBUTES.forEach((attr) => {
            let create_attr = {
                operation: "create_attribute",
                schema: "dropAttr",
                table: "dog",
                attribute: attr,
            };
            heCreateAttribute(create_attr);
        });
        hdb_helium.createDataStores(DATASTORES);
    } catch(err) {
        throw err;
    }
}

describe('Tests for Helium method heDropAttribute', () => {

    before(() => {


        global.hdb_schema = {
            [DROP_ATTR_OBJ_TEST.schema]: {
                [DROP_ATTR_OBJ_TEST.table]: {
                    attributes: [{attribute: 'test'}]
                }
            },
            system: {
                hdb_attribute: {
                    hash_attribute:"id",
                    name:"hdb_attribute",
                    schema:"system",
                    residence:["*"],
                    attributes: [
                        {
                            attribute: "id"
                        },
                        {
                            attribute: "schema"
                        },
                        {
                            attribute: "table"
                        },
                        {
                            attribute: "attribute"
                        },
                        {
                            attribute: "schema_table"
                        }
                    ]
                }
            }
        };
        setupTest();
    });

    after(() => {
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
        global.hdb_schema = {};
    });

    context('Test heDropAttribute function', () => {

        it('Test dropping a single attribute', () => {
            let result;
            let list_ds_result;
            let search_result;

            try {
                result = heDropAttribute(DROP_ATTR_OBJ_TEST);
                list_ds_result = hdb_helium.listDataStores();
                search_result = hdb_helium.searchByValues('system/hdb_attribute/attribute', 'exact', ['weight'], ['system/hdb_attribute/attribute']);
            } catch(err) {
                console.log(err);
            }

            expect(result.message).to.equal('1 record successfully deleted');
            expect(list_ds_result.includes(heGenerateDataStoreName(DROP_ATTR_OBJ_TEST.schema, DROP_ATTR_OBJ_TEST.table, DROP_ATTR_OBJ_TEST.attribute))).to.be.false;
            expect(search_result.length).to.equal(0);
        });

        it('Test dropping an attribute that does not exist', () => {
            let error;
            try {
                heDropAttribute(DROP_ATTR_OBJ_TEST);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal('HE_ERR_DATASTORE_NOT_FOUND');
        });

        it('Test dropping another attribute', () => {
            let drop_attr_obj = test_utils.deepClone(DROP_ATTR_OBJ_TEST);
            drop_attr_obj.attribute = 'owner';
            let result;
            let list_ds_result;
            let search_result;

            try {
                result = heDropAttribute(drop_attr_obj);
                list_ds_result = hdb_helium.listDataStores();
                search_result = hdb_helium.searchByValues('system/hdb_attribute/attribute', 'exact', ['owner'], ['system/hdb_attribute/attribute']);
            } catch(err) {
                console.log(err);
            }

            expect(result.message).to.equal('1 record successfully deleted');
            expect(list_ds_result.includes(heGenerateDataStoreName(drop_attr_obj.schema, drop_attr_obj.table, drop_attr_obj.attribute))).to.be.false;
            expect(search_result.length).to.equal(0);
        });
    });

    context('Test dropAttributeFromSystem function', () => {
        let drop_attr_from_system = heDropAttribute.__get__('dropAttributeFromSystem');

        it('Test that an attribute is removed from the system attribute table', () => {
            let drop_attr_obj = test_utils.deepClone(DROP_ATTR_OBJ_TEST);
            drop_attr_obj.attribute = 'address';
            let result;
            let search_result;

            try {
                result = drop_attr_from_system(drop_attr_obj);
                search_result = hdb_helium.searchByValues('system/hdb_attribute/attribute', 'exact', ['address'], ['system/hdb_attribute/attribute']);
            } catch(err) {
                console.log(err);
            }

            expect(result.message).to.equal('1 record successfully deleted');
            expect(search_result.length).to.equal(0);
        });

        it('Test that an error is thrown if the attribute does not exist', () => {
            let drop_attr_obj = test_utils.deepClone(DROP_ATTR_OBJ_TEST);
            drop_attr_obj.attribute = 'notOne';
            let error;
            try {
                drop_attr_from_system(drop_attr_obj);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(`Attribute ${drop_attr_obj.attribute} was not found.`);
        });
    });
});