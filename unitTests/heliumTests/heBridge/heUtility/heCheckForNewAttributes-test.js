'use strict';

'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const heCheckForNewAttributes = rewire('../../../../../data_layer/harperBridge/heBridge/heUtility/heCheckForNewAttributes');
const log = require('../../../../utility/logging/harper_logger');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: "dev",
    table: "dog",
    records: [
        {
            name: "Harper",
            breed: "Mutt",
            id: "8",
            age: 5
        },
        {
            name: "Penny",
            breed: "Mutt",
            id: "9",
            age: 5,
            height: 145
        },
        {
            name: "David",
            breed: "Mutt",
            id: "12"
        },
        {
            name: "Rob",
            breed: "Mutt",
            id: "10",
            age: 5,
            height: 145
        }
    ]
};

const NO_NEW_ATTR_TEST = [
    {
        attribute: "name"
    },
    {
        attribute: "breed"
    },
    {
        attribute: "age"
    },
    {
        attribute: "id"
    },
    {
        attribute: "height"
    },
    {
        attribute: "__createdtime__"
    },
    {
        attribute: "__updatedtime__"
    }
];

const SCHEMA_TABLE_TEST = {
    id: "c43762be-4943-4d10-81fb-1b857ed6cf3a",
    name: "dog",
    hash_attribute: "id",
    schema: "dev",
    attributes: []
};

let ATTR_OBJ_TEST = {
    "schema": "dev",
    "table": "dog",
    "attribute": [
        {
            "attribute": "name"
        },
        {
            "attribute": "breed"
        },
        {
            "attribute": "age"
        },
        {
            "attribute": "id"
        },
        {
            "attribute": "height"
        },
        {
            "attribute": "__createdtime__"
        },
        {
            "attribute": "__updatedtime__"
        }
    ],
    "hdb_auth_header": "auth-header"
};

describe('Test Helium utility function heCheckForNewAttributes', () => {
    let sandbox = sinon.createSandbox();

    context('Test checkAttributes function', () => {
        let create_new_attr_stub = sandbox.stub();
        let check_for_new_attr_stub = sandbox.stub();

        before(() => {
            heCheckForNewAttributes.__set__('createNewAttribute', create_new_attr_stub);
            heCheckForNewAttributes.__set__('checkForNewAttributes', check_for_new_attr_stub);
        });

        after(() => {
            sandbox.restore();
        });

        it('Test that it returns if no new attributes present', () => {
            check_for_new_attr_stub.returns([]);
            let result = heCheckForNewAttributes('auth-header', SCHEMA_TABLE_TEST, NO_NEW_ATTR_TEST);

            expect(result).to.be.undefined;
            expect(create_new_attr_stub).to.have.not.been.called;
        });

        it('Test that it calls createNewAttribute if new attributes found', () => {
            let new_attr = ['height'];
            check_for_new_attr_stub.returns(new_attr);
            heCheckForNewAttributes('auth-header', SCHEMA_TABLE_TEST, NO_NEW_ATTR_TEST);

            expect(create_new_attr_stub).to.have.been.called;
        });
    });

    context('Test createNewAttribute function', () => {
        let create_new_attribute = heCheckForNewAttributes.__get__('createNewAttribute');
        let create_attribute_stub = sandbox.stub();
        let log_warn_spy;

        before(() => {
            heCheckForNewAttributes.__set__('createAttribute', create_attribute_stub);
            log_warn_spy = sandbox.spy(log, 'warn');
        });

        after(() => {
            sandbox.restore();
        });

        it('Test nominal behaviour, createAttribute is called as expected', () => {
            create_new_attribute('auth-header', INSERT_OBJECT_TEST.schema, INSERT_OBJECT_TEST.table, NO_NEW_ATTR_TEST);

            expect(create_attribute_stub).to.have.been.calledWith(ATTR_OBJ_TEST);
        });

        it('Test that attribute already exists error is caught and not thrown', () => {
            create_attribute_stub.throws(new Error('attribute already exists'));
            create_new_attribute('auth-header', INSERT_OBJECT_TEST.schema, INSERT_OBJECT_TEST.table, NO_NEW_ATTR_TEST);

            expect(log_warn_spy).to.have.been.called;
        });
    });

    context('Test createAttribute function', () => {
        let create_attribute = heCheckForNewAttributes.__get__('createAttribute');
        let he_create_attr_stub = sandbox.stub();

        before(() => {
            heCheckForNewAttributes.__set__('heCreateAttribute', he_create_attr_stub);
        });

        it('Test for nominal behaviour, heCreateAttribute called as expected', () => {
            create_attribute(ATTR_OBJ_TEST);

            expect(he_create_attr_stub).to.have.been.calledWith(ATTR_OBJ_TEST);
        });

        it('Test that error from heCreateAttribute is caught and thrown', () => {
            let error_msg = 'Error creating attribute in Helium';
            he_create_attr_stub.throws(new Error(error_msg));
            let error;
            try {
                create_attribute(ATTR_OBJ_TEST);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(error_msg);
        });
    });
});