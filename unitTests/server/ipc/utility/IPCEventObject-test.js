'use strict';

const chai = require('chai');
const { expect } = chai;
const IPCEventObject = require('../../../../server/ipc/utility/IPCEventObject');

describe('Test IPCEventObject class', () => {
    it('Test new IPCEventObject is correct shape', () => {
        const message = {
            "operation":"create_schema",
            "schema": "unit_test"
        };
        const expected_event = {
            "type": "schema",
            "message": {
                "operation": "create_schema",
                "schema": "unit_test"
            }
        };
        const ipc_event = new IPCEventObject('schema', message);
        expect(ipc_event).to.eql(expected_event);
    });
});