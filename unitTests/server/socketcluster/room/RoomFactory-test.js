"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const RoomFactory = require('../../../../server/socketcluster/room/roomFactory');
const CoreRoom = require('../../../../server/socketcluster/room/CoreRoom');
const types = require('../../../../server/socketcluster/types');
const TOPIC = 'testTopic';

describe('Test RoomFactory', function() {
    let sandbox = sinon.createSandbox();
    beforeEach(() => {

    });
    afterEach(() => {
        sandbox.restore();
    });

    it('test createRoom, nominal', () => {
        let created = null;
        try {
            created = RoomFactory.createRoom(TOPIC, types.ROOM_TYPE.STANDARD);
        } catch(err) {
            created = err;
        }
        assert.notEqual(created, undefined, 'expected room to be created');
        assert.notEqual(created instanceof Error, true, 'expected no exception');
        assert.notEqual(created.decision_matrix, undefined, 'expected created room to have a decision matrix');
    });
    it('test createRoom with bad room type, expect core room default', () => {
        let created = null;
        try {
            created = RoomFactory.createRoom(TOPIC, 15);
        } catch(err) {
            created = err;
        }
        assert.equal(created instanceof CoreRoom, true, 'expected no exception');
    });
});