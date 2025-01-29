'use strict';

process.on('unhandledRejection', (reason, promise) => {
	console.log('Unhandled Rejection at:', promise, 'reason:', reason);
	throw new Error(`Unhandled Rejection at:', ${promise}, 'reason:', ${reason}`);
});

require('../test_utils');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);
const { expect } = chai;
const sinon = require('sinon');
const configUtils = require('../../config/configUtils');
const env_mgr = require('../../utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('../../utility/hdbTerms');
const { databases } = require('../../resources/databases');
let user = require('../../security/user');

const TEST_PASSWORD = 'test1234!';

async function dropTestUsers() {
	await user.dropUser({ username: 'test_user' }).catch(() => {});
	await user.dropUser({ username: 'test_user_undefined' }).catch(() => {});
	await user.dropUser({ username: 'test_user_md5' }).catch(() => {});
	await user.dropUser({ username: 'test_user_sha256' }).catch(() => {});
	await user.dropUser({ username: 'test_user_argon2id' }).catch(() => {});
}

async function addTestUser() {
	await user.addUser({
		operation: 'add_user',
		role: 'super_user',
		username: 'test_user',
		password: TEST_PASSWORD,
		active: true,
	});
}

function setHashFunction(hashFunction) {
	delete require.cache[require.resolve('../../security/user')];
	delete require.cache[require.resolve('../../utility/password')];
	env_mgr.setProperty(CONFIG_PARAMS.AUTHENTICATION_HASHFUNCTION, hashFunction);
	require('../../utility/password');
	user = require('../../security/user');
}

describe('user.js Unit Tests', () => {
	before(async () => {
		await user.setUsersWithRolesCache();
	});

	afterEach(async () => {
		await dropTestUsers();
	});

	describe('Test addUser', () => {
		it('should add four new users each with the correct hash function', async () => {
			const addUserObj = {
				operation: 'add_user',
				role: 'super_user',
				active: true,
			};

			setHashFunction(undefined);
			addUserObj.username = 'test_user_undefined';
			addUserObj.password = 'pass-undefined';
			const result = await user.addUser(addUserObj);
			expect(result).to.equal('test_user_undefined successfully added');

			setHashFunction('md5');
			addUserObj.username = 'test_user_md5';
			addUserObj.password = 'pass-md5';
			await user.addUser(addUserObj);

			setHashFunction('sha256');
			addUserObj.username = 'test_user_sha256';
			addUserObj.password = 'pass-sha256';
			await user.addUser(addUserObj);

			setHashFunction('argon2id');
			addUserObj.username = 'test_user_argon2id';
			addUserObj.password = 'pass-argon2id';
			await user.addUser(addUserObj);

			const allUsers = await user.listUsers();

			expect(allUsers.get('test_user_undefined')?.hash_function).to.equal('sha256');
			expect(allUsers.get('test_user_undefined')?.role.role).to.equal('super_user');
			expect(allUsers.get('test_user_undefined')?.username).to.equal('test_user_undefined');
			const foundMd5Undefined = await user.findAndValidateUser('test_user_undefined', 'pass-undefined');
			expect(foundMd5Undefined.username).to.equal('test_user_undefined');

			expect(allUsers.get('test_user_md5')?.hash_function).to.equal('md5');
			expect(allUsers.get('test_user_md5')?.role.role).to.equal('super_user');
			expect(allUsers.get('test_user_md5')?.username).to.equal('test_user_md5');
			const foundMd5User = await user.findAndValidateUser('test_user_md5', 'pass-md5');
			expect(foundMd5User.username).to.equal('test_user_md5');

			expect(allUsers.get('test_user_sha256')?.hash_function).to.equal('sha256');
			expect(allUsers.get('test_user_sha256')?.role.role).to.equal('super_user');
			expect(allUsers.get('test_user_sha256')?.username).to.equal('test_user_sha256');
			const foundsha256User = await user.findAndValidateUser('test_user_sha256', 'pass-sha256');
			expect(foundsha256User.username).to.equal('test_user_sha256');

			expect(allUsers.get('test_user_argon2id')?.hash_function).to.equal('argon2id');
			expect(allUsers.get('test_user_argon2id')?.role.role).to.equal('super_user');
			expect(allUsers.get('test_user_argon2id')?.username).to.equal('test_user_argon2id');
			const foundArgon2idUser = await user.findAndValidateUser('test_user_argon2id', 'pass-argon2id');
			expect(foundArgon2idUser.username).to.equal('test_user_argon2id');
		});

		it('should throw an error if role is not found', async () => {
			await expect(
				user.addUser({
					operation: 'add_user',
					role: 'bread_roll',
					username: 'test_user',
					password: 'test1234!',
					active: true,
				})
			).to.be.rejectedWith('bread_roll role not found');
		});
	});

	describe('Test alterUser', () => {
		it('should alter a user password successfully', async () => {
			setHashFunction(undefined);
			await addTestUser();
			const result = await user.alterUser({
				username: 'test_user',
				password: 'new-password',
			});
			expect(result.message).to.equal('updated 1 of 1 records');

			const foundUser = await user.findAndValidateUser('test_user', 'new-password');
			expect(foundUser.username).to.equal('test_user');

			await expect(user.findAndValidateUser('test_user', TEST_PASSWORD)).to.be.rejectedWith('Login failed');
		});

		it('should throw an error if validation fails', async () => {
			await expect(
				user.alterUser({
					username: 'test_user',
				})
			).to.be.rejectedWith('nothing to update, must supply active, role or password to update');
		});
	});

	describe('Test dropUser', () => {
		it('should drop a user successfully', async () => {
			await addTestUser();
			const result = await user.dropUser({ username: 'test_user' });
			expect(result).to.equal('test_user successfully deleted');
			const allUsers = await user.listUsers();
			expect(allUsers.get('test_user')).to.be.undefined;
		});

		it('should throw an error if user does not exist', async () => {
			await expect(
				user.dropUser({
					username: 'test_user',
				})
			).to.be.rejectedWith('User test_user does not exist');
		});
	});

	describe('Test findAndValidateUser', () => {
		it('should find and validate a user successfully', async () => {
			await addTestUser();
			const result = await user.findAndValidateUser('test_user', TEST_PASSWORD);
			expect(result.username).to.equal('test_user');
			await expect(user.findAndValidateUser('test_user', 'test1234')).to.be.rejectedWith('Login failed');
		});

		it('should throw an error if user is inactive', async () => {
			await user.addUser({
				operation: 'add_user',
				role: 'super_user',
				username: 'test_user_undefined',
				password: TEST_PASSWORD,
				active: false,
			});
			await expect(user.findAndValidateUser('test_user_undefined', TEST_PASSWORD)).to.be.rejectedWith(
				'Cannot complete request: User is inactive'
			);
		});

		it('should validate a user with no hash_function value', async () => {
			setHashFunction('md5');
			await addTestUser();
			await databases.system.hdb_user.patch('test_user', { hash_function: undefined });
			await user.setUsersWithRolesCache();
			setHashFunction(undefined);
			const foundUser = await user.findAndValidateUser('test_user', TEST_PASSWORD);
			expect(foundUser.username).to.equal('test_user');
		});
	});

	describe('Test userInfo, listUsersExternal, getSuperUser and getClusterUser', () => {
		it('should return user info', async () => {
			const result = await user.userInfo({
				hdb_user: {
					role: { id: 'super_user' },
					password: '123Abc',
					refresh_token: '34124sdfas',
					hash: '83b3dj3',
					hash_function: 'argon2id',
					username: 'test_user',
				},
			});
			expect(result.username).to.equal('test_user');
			expect(result.password).to.be.undefined;
			expect(result.refresh_token).to.be.undefined;
			expect(result.hash).to.be.undefined;
			expect(result.hash_function).to.be.undefined;
		});

		it('should return a list of users', async () => {
			await addTestUser();
			const result = await user.listUsersExternal();
			let testUser;
			result.forEach((user) => {
				if (user.username === 'test_user') testUser = user;
			});
			expect(testUser.username).to.equal('test_user');
			expect(testUser.role.role).to.equal('super_user');
			expect(testUser.refresh_token).to.be.undefined;
			expect(testUser.hash).to.be.undefined;
			expect(testUser.hash_function).to.be.undefined;
			await dropTestUsers();
		});

		it.skip('should return the super user', async () => {
			await addTestUser();
			const result = await user.getSuperUser();
			expect(result.role.role).to.equal('super_user');
			await dropTestUsers();
		});

		it('should return the cluster user', async () => {
			await user.addUser({
				operation: 'add_user',
				role: 'cluster_user',
				username: 'test_user',
				password: TEST_PASSWORD,
				active: true,
			});

			const getConfigStub = sinon.stub(configUtils, 'getConfigFromFile').returns('test_user');
			const result = await user.getClusterUser();
			expect(result.username).to.equal('test_user');
			expect(result.decrypt_hash).to.equal(TEST_PASSWORD);
			expect(result.role.role).to.equal('cluster_user');
			getConfigStub.restore();
		});
	});
});
