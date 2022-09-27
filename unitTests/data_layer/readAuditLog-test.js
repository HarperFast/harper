'use strict';

const rewire = require('rewire');
const read_audit_log = require('../../data_layer/readAuditLog');
const rw_read_audit_log = rewire('../../data_layer/readAuditLog');
const ReadAuditLogObject = require('../../data_layer/ReadAuditLogObject');
const env_mgr = require('../../utility/environment/environmentManager');
const hdb_terms = require('../../utility/hdbTerms');

const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const assert = require('assert');
const TEST_ERROR_MSGS = require('../commonTestErrors');

describe('test readAuditLog module', () => {
	before(() => {
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_AUDITLOG, true);
		global.hdb_schema = {
			dev: {
				test: {
					hash_attribute: 'id',
				},
			},
		};
	});

	after(() => {
		delete global.hdb_schema;
	});

	it('test no schema', async () => {
		let obj = new ReadAuditLogObject();

		let error = undefined;
		try {
			await read_audit_log(obj);
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error, new Error(TEST_ERROR_MSGS.TEST_SCHEMA_OP_ERROR.SCHEMA_REQUIRED_ERR));
	});

	it('test no table', async () => {
		let obj = new ReadAuditLogObject('schema');

		let error = undefined;
		try {
			await read_audit_log(obj);
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error, new Error(TEST_ERROR_MSGS.TEST_SCHEMA_OP_ERROR.TABLE_REQUIRED_ERR));
	});

	it('test invalid search type', async () => {
		let obj = new ReadAuditLogObject('dev', 'test', 'wrong');

		let error = undefined;
		try {
			await read_audit_log(obj);
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error, new Error(`Invalid search_type '${obj.search_type}'`));
	});

	it('test happy path', async () => {
		let stub = sandbox.stub().resolves([]);
		let rw_stub = rw_read_audit_log.__set__('harperBridge', {
			readAuditLog: stub,
		});

		let obj = new ReadAuditLogObject('dev', 'test', 'timestamp');

		let error = undefined;
		try {
			await rw_read_audit_log(obj);
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error, undefined);

		rw_stub();
	});

	it('Test table validation error returned', async () => {
		let error = undefined;
		try {
			await rw_read_audit_log(new ReadAuditLogObject('dev', 'test_me', 'timestamp'));
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error.message, "Table 'dev.test_me' does not exist");
	});

	it('Test auditLog not set in config err', async () => {
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_AUDITLOG, false);
		let error = undefined;
		try {
			await rw_read_audit_log(new ReadAuditLogObject('dev', 'test_me', 'timestamp'));
		} catch (e) {
			error = e;
		}

		assert.deepStrictEqual(error.message, 'To use this operation audit log must be enabled in harperdb.conf');
	});
});
