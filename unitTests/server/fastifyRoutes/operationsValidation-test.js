'use strict';

const chai = require('chai');
const sinon = require('sinon');
const fs = require('fs-extra');
const { expect } = chai;
const rewire = require('rewire');
const env_mangr = require('../../../utility/environment/environmentManager');
const validator = rewire('../../../components/operationsValidation');

describe('Test operationsValidation module', () => {
	const sandbox = sinon.createSandbox();
	const test_error = 'There is an error';
	let helpers_test = {
		message: (msg) => msg,
	};

	before(() => {
		env_mangr.initTestEnvironment();
	});

	after(() => {
		sandbox.restore();
	});

	describe('Test checkProjectExists function', () => {
		let fs_exists_stub;
		let checkProjectExists;

		before(() => {
			fs_exists_stub = sandbox.stub(fs, 'existsSync');
			checkProjectExists = validator.__get__('checkProjectExists');
		});

		after(() => {
			fs_exists_stub.restore();
		});

		it('Test message returned if project does not exist', () => {
			fs_exists_stub.returns(false);
			const result = checkProjectExists(true, 'unit_test', helpers_test);
			expect(result).to.equal("Project does not exist. Create one using 'add_custom_function_project'");
		});

		it('Test project is returned if project exists', () => {
			fs_exists_stub.returns(true);
			const result = checkProjectExists(true, 'unit_test', helpers_test);
			expect(result).to.equal('unit_test');
		});

		it('Test message is returned if fs exists throws error', () => {
			fs_exists_stub.throws(test_error);
			const result = checkProjectExists(true, 'unit_test', helpers_test);
			expect(result).to.equal('Error validating request, check the log for more details');
		});
	});

	describe('Test checkFileExists function', () => {
		let fs_exists_stub;
		let checkFileExists;

		before(() => {
			fs_exists_stub = sandbox.stub(fs, 'existsSync');
			checkFileExists = validator.__get__('checkFileExists');
		});

		after(() => {
			fs_exists_stub.restore();
		});

		it('Test message is returned if file does not exist', () => {
			fs_exists_stub.returns(false);
			const result = checkFileExists('unit_test', 'route', 'dogs', helpers_test);
			expect(result).to.equal('File does not exist');
		});

		it('Test file is returned if it does exist', () => {
			fs_exists_stub.returns(true);
			const result = checkFileExists('unit_test', 'route', 'dogs', helpers_test);
			expect(result).to.equal('dogs');
		});

		it('Test message is returned if fs exists throws error', () => {
			fs_exists_stub.throws(test_error);
			const result = checkFileExists('unit_test', 'route', 'dogs', helpers_test);
			expect(result).to.equal('Error validating request, check the log for more details');
		});
	});

	describe('Test getDropCustomFunctionValidator function', () => {
		let check_project_exists_stub = sandbox.stub().returns('unit_test');
		let check_project_exists_rw;
		let check_file_exists_stub = sandbox.stub().returns('dogs');
		let check_file_exists_rw;

		before(() => {
			check_project_exists_rw = validator.__set__('checkProjectExists', check_project_exists_stub);
			check_file_exists_rw = validator.__set__('checkFileExists', check_file_exists_stub);
		});

		after(() => {
			check_project_exists_rw();
			check_file_exists_rw();
		});

		it('Test validation messages are returned', () => {
			let req = {
				project: '',
				type: '',
				file: '',
			};
			const result = validator.getDropCustomFunctionValidator(req);
			expect(result.message).to.equal(
				"'project' is not allowed to be empty. 'type' must be one of [helpers, routes]. 'type' is not allowed to be empty. 'file' is not allowed to be empty"
			);
		});

		it('Test alphanumeric validation messages are returned', () => {
			let req = {
				project: 'home/',
				type: 'routes',
				file: 'file.js',
			};
			const result = validator.getDropCustomFunctionValidator(req);
			expect(result.message).to.equal(
				'Project name can only contain alphanumeric, dash and underscores characters. File name can only contain alphanumeric, dash and underscore characters'
			);
		});
	});

	describe('Test setCustomFunctionValidator function', () => {
		let check_project_exists_stub = sandbox.stub().returns('unit_test');
		let check_project_exists_rw;

		before(() => {
			check_project_exists_rw = validator.__set__('checkProjectExists', check_project_exists_stub);
		});

		after(() => {
			check_project_exists_rw();
		});

		it('Test validation messages are returned', () => {
			let req = {
				project: '',
				type: '',
				file: '',
				function_content: '',
			};
			const result = validator.setCustomFunctionValidator(req);
			expect(result.message).to.equal(
				"'project' is not allowed to be empty. 'type' must be one of [helpers, routes]. 'type' is not allowed to be empty. 'file' is not allowed to be empty. 'function_content' is not allowed to be empty"
			);
		});

		it('Test alphanumeric validation messages are returned', () => {
			let req = {
				project: 'home/',
				type: 'routes',
				file: 'file.exe',
				function_content: 'hello world',
			};
			const result = validator.setCustomFunctionValidator(req);
			expect(result.message).to.equal(
				'Project name can only contain alphanumeric, dash and underscores characters. File name can only contain alphanumeric, dash and underscore characters'
			);
		});
	});

	describe('Test addCustomFunctionProjectValidator function', () => {
		let check_project_exists_stub = sandbox.stub().returns('unit_test');
		let check_project_exists_rw;

		before(() => {
			check_project_exists_rw = validator.__set__('checkProjectExists', check_project_exists_stub);
		});

		after(() => {
			check_project_exists_rw();
		});

		it('Test validation messages are returned', () => {
			let req = {
				project: '',
			};
			const result = validator.addCustomFunctionProjectValidator(req);
			expect(result.message).to.equal("'project' is not allowed to be empty");
		});

		it('Test alphanumeric validation messages are returned', () => {
			let req = {
				project: '../home',
			};
			const result = validator.addCustomFunctionProjectValidator(req);
			expect(result.message).to.equal('Project name can only contain alphanumeric, dash and underscores characters');
		});
	});

	describe('Test dropCustomFunctionProjectValidator function', () => {
		let check_project_exists_stub = sandbox.stub().returns('unit_test');
		let check_project_exists_rw;

		before(() => {
			check_project_exists_rw = validator.__set__('checkProjectExists', check_project_exists_stub);
		});

		after(() => {
			check_project_exists_rw();
		});

		it('Test validation messages are returned', () => {
			let req = {
				project: '',
			};
			const result = validator.dropCustomFunctionProjectValidator(req);
			expect(result.message).to.equal("'project' is not allowed to be empty");
		});

		it('Test alphanumeric validation messages are returned', () => {
			let req = {
				project: '../home',
			};
			const result = validator.dropCustomFunctionProjectValidator(req);
			expect(result.message).to.equal('Project name can only contain alphanumeric, dash and underscores characters');
		});
	});
});
