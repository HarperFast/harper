'use strict';

const { assert, expect } = require('chai');
const status = require('../../server/status');

describe('server.status', function () {

    const clearStatus = async () => Promise.all(['primary', 'test', 'maintenance'].map((id) => status.clear({id})));
    beforeEach(() => clearStatus());
    after(() => clearStatus());

    const assertAndOverrideTimestamps = (obj) => {
        assert.isDefined(obj.__updatedtime__);
        assert.isDefined(obj.__createdtime__);
        obj.__updatedtime__ = 42;
        obj.__createdtime__ = 42;
    };

    it('should set status', async function () {
        const statusObj = {
            status: 'starting',
        };
        const result = await status.set(statusObj);
        expect(result).to.be.undefined
    });

    // todo: needed?
    it('should get specific status', async function () {
        const statusObj = {
            id: 'primary',
            status: 'testing',
        };
        const expected = {
            id: 'primary',
            status: 'testing',
            __updatedtime__: 42,
            __createdtime__: 42,
        };
        await status.set(statusObj);
        const result = await status.get({ id: 'primary' });
        assertAndOverrideTimestamps(result);
        expect(result).to.deep.equal(expected);
    });

    // todo: update to 'also report any additional real-time information about current status'
    it('should get complete status with just primary set', async function () {
        const statusObj = {
            id: 'primary',
            status: 'testing',
        };
        const expected = [
            {
                id: 'primary',
                status: 'testing',
                __updatedtime__: 42,
                __createdtime__: 42,
            }
        ];
        await status.set(statusObj);
        const result = await status.get({});
        // Pull result iterator into an array
        const resultArray = [];
        for await (const item of result) {
            assertAndOverrideTimestamps(item);
            resultArray.push(item);
        }
        expect(resultArray).to.deep.equal(expected);
    });

    // todo: update to 'also report any additional real-time information about current status'
    it('should get complete status', async function () {
        const statusObjs = [
            {
                id: 'primary',
                status: 'testing',
            },
            {
                id: 'test',
                status: 'really testing',
            },
            {
                id: 'maintenance',
                status: 'testing will continue',
            }
        ];
        const expected = [
            {
                id: 'primary',
                status: 'testing',
                __updatedtime__: 42,
                __createdtime__: 42,
            },
            {
                id: 'test',
                status: 'really testing',
                __updatedtime__: 42,
                __createdtime__: 42,
            },
            {
                id: 'maintenance',
                status: 'testing will continue',
                __updatedtime__: 42,
                __createdtime__: 42,
            }
        ];
        await Promise.all(statusObjs.map(sO => status.set(sO)));
        const result = await status.get({});
        // Pull result iterator into an array
        const resultArray = [];
        for await (const item of result) {
            assertAndOverrideTimestamps(item);
            resultArray.push(item);
        }
        expect(resultArray).to.have.deep.members(expected);
    });
});
