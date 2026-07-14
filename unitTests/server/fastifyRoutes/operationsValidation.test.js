'use strict';

const chai = require('chai');
const sinon = require('sinon');
const fs = require('fs-extra');
const { expect } = chai;
const rewire = require('rewire');
const env_mangr = require('#src/utility/environment/environmentManager');
const validator = rewire('#js/components/operationsValidation');

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
			expect(result.message).to.equal('Project name can only contain alphanumeric, dash and underscores characters');
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
			const result = validator.addComponentValidator(req);
			expect(result.message).to.equal("'project' is not allowed to be empty");
		});

		it('Test alphanumeric validation messages are returned', () => {
			let req = {
				project: '../home',
			};
			const result = validator.addComponentValidator(req);
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

	describe('Test deployComponentValidator credentials', () => {
		it('accepts a valid credentials array', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				package: 'npm:@myorg/app@1.0.0',
				credentials: [{ registry: 'https://npm.pkg.github.com', token: 'tok', scope: '@myorg' }],
			});
			expect(result).to.equal(undefined);
		});

		it('rejects a credential entry missing a token', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ registry: 'https://npm.pkg.github.com' }],
			});
			expect(result.message).to.contain('token');
		});

		it('rejects an invalid scope', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ registry: 'https://npm.pkg.github.com', token: 'tok', scope: 'noatsign' }],
			});
			expect(result.message).to.contain('scope');
		});

		it('rejects credentials that is not an array', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				credentials: { registry: 'https://npm.pkg.github.com', token: 'tok' },
			});
			expect(result.message).to.contain('credentials');
		});

		it('rejects a token containing a newline (.npmrc line injection)', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ registry: 'https://npm.pkg.github.com', token: 'tok\nregistry=https://evil.example.com/' }],
			});
			expect(result.message).to.contain('token');
		});

		it('rejects a registry containing a newline (.npmrc line injection)', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ registry: 'https://npm.pkg.github.com\n//evil.example.com/:_authToken=x', token: 'tok' }],
			});
			expect(result.message).to.contain('registry');
		});

		it('still accepts a bare-host registry (newline guard must not over-restrict)', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				package: 'npm:@myorg/app@1.0.0',
				credentials: [{ registry: 'npm.pkg.github.com', token: 'tok' }],
			});
			expect(result).to.equal(undefined);
		});

		it('accepts a secret-reference entry (token resolved from hdb_secret at deploy time)', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				package: 'npm:@myorg/app@1.0.0',
				credentials: [{ registry: 'https://npm.pkg.github.com', secret: 'GH_TOKEN', scope: '@myorg' }],
			});
			expect(result).to.equal(undefined);
		});

		it('rejects an entry that supplies both token and secret (exactly one required)', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ registry: 'https://npm.pkg.github.com', token: 'tok', secret: 'GH_TOKEN' }],
			});
			expect(result.message).to.contain('secret');
		});

		it('rejects an entry supplying neither token nor secret', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ registry: 'https://npm.pkg.github.com' }],
			});
			expect(result.message).to.contain('secret');
		});

		it('rejects an invalid secret name', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ registry: 'https://npm.pkg.github.com', secret: 'bad name/with slash' }],
			});
			expect(result.message).to.contain('secret');
		});

		it('rejects the pre-rename registryAuth field (clean break, #1717 never shipped GA)', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				package: 'npm:@myorg/app@1.0.0',
				registryAuth: [{ registry: 'https://npm.pkg.github.com', token: 'tok' }],
			});
			expect(result.message).to.contain('registryAuth');
		});

		it('accepts a git-host entry, with a token or a secret reference (#1792)', () => {
			for (const entry of [
				{ host: 'github.com', token: 'ghp_tok' },
				{ host: 'github.com', secret: 'GH_TOKEN' },
				{ host: 'gitlab.com', token: 'glpat', username: 'oauth2' },
				{ host: 'git.example.com:8443', token: 'tok' },
			]) {
				const result = validator.deployComponentValidator({
					project: 'my_app',
					package: 'github:myorg/private-app',
					credentials: [entry],
				});
				expect(result, JSON.stringify(entry)).to.be.undefined;
			}
		});

		it('accepts npm and git entries in the same credentials array', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				package: 'github:myorg/private-app',
				credentials: [
					{ registry: 'https://npm.pkg.github.com', token: 'npm_tok', scope: '@myorg' },
					{ host: 'github.com', token: 'git_tok' },
				],
			});
			expect(result).to.be.undefined;
		});

		it('rejects a git entry supplying both a token and a secret', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ host: 'github.com', token: 'tok', secret: 'GH_TOKEN' }],
			});
			expect(result).to.be.ok;
		});

		it('rejects a git entry supplying neither a token nor a secret', () => {
			const result = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ host: 'github.com' }],
			});
			expect(result).to.be.ok;
		});

		it('rejects a host carrying a scheme, path, or userinfo (a credential is matched by host)', () => {
			for (const host of ['https://github.com', 'github.com/myorg/repo', 'user@github.com', 'git hub.com']) {
				const result = validator.deployComponentValidator({
					project: 'my_app',
					credentials: [{ host, token: 'tok' }],
				});
				expect(result, host).to.be.ok;
			}
		});

		it('rejects an entry that is neither kind, or that is ambiguously both', () => {
			const neither = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ proxy: 'example.com', token: 'tok' }],
			});
			expect(neither).to.be.ok;
			// `registry` and `host` are the kind discriminators; an entry carrying both has no single
			// kind, so it must not be silently treated as one of them.
			const both = validator.deployComponentValidator({
				project: 'my_app',
				credentials: [{ registry: 'https://npm.pkg.github.com', host: 'github.com', token: 'tok' }],
			});
			expect(both).to.be.ok;
		});
	});

	describe('Test deployComponentValidator function', () => {
		it('accepts valid package-based deploy request', () => {
			const result = validator.deployComponentValidator({ project: 'my-app', package: '@scope/pkg' });
			expect(result).to.be.undefined;
		});

		it('accepts urlPath alongside package', () => {
			const result = validator.deployComponentValidator({ project: 'my-app', package: '@scope/pkg', urlPath: '/api' });
			expect(result).to.be.undefined;
		});

		it('rejects urlPath without package', () => {
			const result = validator.deployComponentValidator({ project: 'my-app', urlPath: '/api' });
			expect(result).to.be.ok;
			expect(result.message).to.include('urlPath');
		});

		it('rejects urlPath containing ..', () => {
			const result = validator.deployComponentValidator({
				project: 'my-app',
				package: 'pkg',
				urlPath: '../etc/passwd',
			});
			expect(result).to.be.ok;
			expect(result.message).to.include('urlPath');
		});

		it('rejects empty urlPath', () => {
			const result = validator.deployComponentValidator({ project: 'my-app', package: 'pkg', urlPath: '' });
			expect(result).to.be.ok;
		});

		it('rejects missing project', () => {
			const result = validator.deployComponentValidator({ package: 'pkg' });
			expect(result).to.be.ok;
			expect(result.message).to.include('project');
		});

		it('accepts a numeric deployment_timeout', () => {
			const result = validator.deployComponentValidator({
				project: 'my-app',
				package: 'pkg',
				deployment_timeout: 180000,
			});
			expect(result).to.be.undefined;
		});

		it('rejects a non-numeric deployment_timeout', () => {
			const result = validator.deployComponentValidator({
				project: 'my-app',
				package: 'pkg',
				deployment_timeout: 'soon',
			});
			expect(result).to.be.ok;
			expect(result.message).to.include('deployment_timeout');
		});
	});
});
