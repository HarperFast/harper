"use strict";

const test_utils = require('../../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.preTestPrep();

const chai = require('chai');
const { expect } = chai;
const rewire = require('rewire');

let harperBridge_rw;
let getBridge_rw;
let getDataStoreType_rw;
const terms = require('../../../utility/hdbTerms');

const FileSystemBridge = require('../../../data_layer/harperBridge/fsBridge/FileSystemBridge');
const HeliumBridge = require('../../../data_layer/harperBridge/heliumBridge/HeliumBridge');

const returnFS = () => terms.HDB_DATA_STORE_TYPES.FILE_SYSTEM;
const returnHelium = () => terms.HDB_DATA_STORE_TYPES.HELIUM;
const returnUndefined = () => undefined;

describe('Test harperBridge', () => {
    beforeEach(() => {
        harperBridge_rw = rewire('../../../data_layer/harperBridge/harperBridge');
        getBridge_rw = harperBridge_rw.__get__('getBridge');
        getDataStoreType_rw = harperBridge_rw.__get__('getDataStoreType');
    });

    //High level tests for harperBridge will get updated as we have a dynamic mechanism for determining the correct store to enable
    it("should export the correct instantiated bridge methods class based on the enabled data store", () => {
        const enabled_bridge_class = getBridge_rw();
        expect(harperBridge_rw.__get__('harper_bridge')).to.deep.equal(enabled_bridge_class);
    });

    describe('getBridge()', () => {
        it("should return the FS bridge methods class if the enabled data store is FS", () => {
            harperBridge_rw.__set__('harper_bridge', undefined);
            harperBridge_rw.__set__('getDataStoreType', returnFS);
            const test_result = getBridge_rw();
            expect(test_result instanceof FileSystemBridge).to.equal(true);
        });

        it("should return the Helium bridge methods class if the enabled data store is Helium", () => {
            harperBridge_rw.__set__('harper_bridge', undefined);
            harperBridge_rw.__set__('getDataStoreType', returnHelium);
            const test_result = getBridge_rw();
            expect(test_result instanceof HeliumBridge).to.equal(true);
        });

        it("should return the FS bridge methods class if the enabled data store is undefined", () => {
            harperBridge_rw.__set__('harper_bridge', undefined);
            harperBridge_rw.__set__('getDataStoreType', returnUndefined);
            const test_result = getBridge_rw();
            expect(test_result instanceof FileSystemBridge).to.equal(true);
        });
    });

    describe('getDataStoreType()', () => {
        //this test will get updated as more logic is added to this method for determining the correct data store
        it("should return the FILE_SYSTEM data store type", () => {
            const enabled_data_store = getDataStoreType_rw();
            expect(enabled_data_store).to.equal(terms.HDB_DATA_STORE_TYPES.FILE_SYSTEM);
        });
    });

});