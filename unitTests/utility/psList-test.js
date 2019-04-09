"use strict";
const chai = require('chai');
const rewire = require('rewire');

let find_ps = rewire('../../utility/psList');
const { expect } = chai;

describe('Test ps_list', () => {
    let execFunc = async () => {
        return {stdout:'PID COMM\n 280 /harperdb/server/hdb_express.js\n'};
    };

    afterEach(() => {
        find_ps = rewire('../../utility/psList');
    });

    it('should return an array of objects', async () => {
        let result = await find_ps.findPs('');
        expect(result).to.be.a('array');
        expect(result[0]).to.be.a('object');
        expect(result[0]).to.have.property('pid');
        expect(result[0]).to.have.property('name');
        expect(result[0]).to.have.property('cmd');
        expect(result[0]).to.have.property('ppid');
        expect(result[0]).to.have.property('uid');
        expect(result[0]).to.have.property('cpu');
        expect(result[0]).to.have.property('memory');
    });

    it('should return hdb_express process', async () => {
        find_ps.__set__('exec_file', execFunc);
        let result = await find_ps.findPs('');
        expect(result).to.be.a('array');
        expect(result[0]).to.be.a('object');
        expect(result[0]).to.have.property('pid');
        expect(result[0]).to.have.property('name');
        expect(result[0]).to.have.property('cmd');
        expect(result[0]).to.have.property('pid').equal(280);
        expect(result[0]).to.have.property('pid').not.equal(28);
        expect(result[0]).to.have.property('name').equal('hdb_express.js');
        expect(result[0]).to.have.property('cmd').equal('/harperdb/server/hdb_express.js');
    });
});
