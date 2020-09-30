'use strict';

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const rewire = require('rewire');
let AWSConnector_rw;

const test_s3_obj = {
    s3: {
        aws_access_key_id: '12345key',
        aws_secret_access_key: '54321key',
        bucket: 'test_bucket',
        key: 'test_file.csv'
    }
}

describe('Test AWSConnector module', () => {
    let get_auth_stub;
    let sandbox;

    before(() => {
        sandbox = sinon.createSandbox();
    })

    afterEach(() => {
        sandbox.reset();
    })

    after(() => {
        rewire('../../../utility/AWS/AWSConnector');
    })

    describe('Test getS3AuthObj function', () => {
        let stub_func;
        const auth_success = 'auth success';
        const s3_fail = 'auth fail';

        beforeEach(() => {
            AWSConnector_rw = rewire('../../../utility/AWS/AWSConnector');
        })
        it('should return value from call to new S3 object returned from getS3AuthObj ', () => {
            stub_func = () => ({ getObject: () => ({createReadStream: () => auth_success})});
            get_auth_stub = sandbox.stub(AWSConnector_rw, 'getS3AuthObj').callsFake(stub_func);
            AWSConnector_rw.__set__('getS3AuthObj', get_auth_stub);

            let result = AWSConnector_rw.getFileStreamFromS3(test_s3_obj);
            expect(result).to.equal(auth_success);
        });

        it('should throw an error if returned from new S3 object when invoked ', () => {
            stub_func = () => ({ getObject: () => ({createReadStream: () => {throw new Error(s3_fail)}})});
            get_auth_stub = sandbox.stub(AWSConnector_rw, 'getS3AuthObj').callsFake(stub_func);
            AWSConnector_rw.__set__('getS3AuthObj', get_auth_stub);
            let result;
            try {
                AWSConnector_rw.getFileStreamFromS3(test_s3_obj);
            } catch(err) {
                result = err;
            }
            expect(result).to.be.instanceof(Error);
            expect(result.message).to.equal(s3_fail);
        });
    });
});
