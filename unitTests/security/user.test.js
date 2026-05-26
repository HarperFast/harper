'use strict';

process.on('unhandledRejection', (reason, promise) => {
	console.log('Unhandled Rejection at:', promise, 'reason:', reason);
	throw new Error(`Unhandled Rejection at:', ${promise}, 'reason:', ${reason}`);
});

require('../testUtils.js');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised').default;
chai.use(chaiAsPromised);
const { expect } = chai;
const env_mgr = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { databases } = require('#src/resources/databases');
const password = require('#src/utility/password');
let user = require('#src/security/user');

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
	delete require.cache[require.resolve('#src/security/user')];
	delete require.cache[require.resolve('#src/utility/password')];
	env_mgr.setProperty(CONFIG_PARAMS.AUTHENTICATION_HASHFUNCTION, hashFunction);
	require('#src/utility/password');
	user = require('#src/security/user');
}

describe('user.ts Unit Tests', () => {
	before(async () => {
		const testUtils = require('../testUtils.js');
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		const mountHdb = require('#src/utility/mount_hdb').default;
		const { addRole } = require('#src/security/role');
		await mountHdb(env_mgr.getHdbBasePath());
		try {
			await addRole({
				role: 'super_user',
				id: 'super_user',
				permission: {
					super_user: true,
				},
			});
		} catch {}
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
			await user.addUser(addUserObj);

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

			const users = await user.listUsers();
			expect(users.get('test_user_undefined').password.length).to.be.greaterThan(10);
			expect(users.get('test_user_md5').password.length).to.be.greaterThan(10);
			expect(users.get('test_user_sha256').password.length).to.be.greaterThan(10);
			expect(users.get('test_user_argon2id').password.length).to.be.greaterThan(10);
		});

		it('should throw an error if role is not found', async () => {
			const addUserObj = {
				operation: 'add_user',
				role: 'non-existent-role',
				username: 'test_user',
				password: TEST_PASSWORD,
				active: true,
			};

			await expect(user.addUser(addUserObj)).to.be.rejectedWith('non-existent-role role not found');
		});
	});

	describe('Test alterUser', () => {
		it('should alter a user password successfully', async () => {
			await addTestUser();
			const alterUserObj = {
				operation: 'alter_user',
				username: 'test_user',
				password: 'new-password',
			};

			await user.alterUser(alterUserObj);
			const findUser = await user.userInfo({ hdb_user: { username: 'test_user' } });
			expect(findUser.username).to.equal('test_user');
		});

		it('should throw an error if validation fails', async () => {
			const alterUserObj = {
				operation: 'alter_user',
				username: 'test_user',
			};

			await expect(user.alterUser(alterUserObj)).to.be.rejected;
		});
	});

	describe('Test dropUser', () => {
		it('should drop a user successfully', async () => {
			await addTestUser();
			await user.dropUser({ username: 'test_user' });
			const users = await user.listUsers();
			expect(users.has('test_user')).to.be.false;
		});

		it('should throw an error if user does not exist', async () => {
			await expect(user.dropUser({ username: 'non-existent-user' })).to.be.rejectedWith(
				'User non-existent-user does not exist'
			);
		});
	});

	describe('Test findAndValidateUser', () => {
		it('should find and validate a user successfully', async () => {
			await addTestUser();
			const result = await user.findAndValidateUser('test_user', TEST_PASSWORD);
			expect(result.username).to.equal('test_user');
		});

		it('should throw an error if user is inactive', async () => {
			await addTestUser();
			await user.alterUser({ operation: 'alter_user', username: 'test_user', active: false });
			await expect(user.findAndValidateUser('test_user', TEST_PASSWORD)).to.be.rejectedWith('User is inactive');
		});

		it('should validate a user with no hash_function value', async () => {
			await addTestUser();
			// Manually remove hash_function from the database record and use MD5 hash
			const hashedPassword = await password.hash(TEST_PASSWORD, 'md5');
			await databases.system.hdb_user.put({
				username: 'test_user',
				password: hashedPassword,
				role: 'super_user',
				active: true,
			});
			await user.setUsersWithRolesCache();
			const result = await user.findAndValidateUser('test_user', TEST_PASSWORD);
			expect(result.username).to.equal('test_user');
		});
	});

	describe('Test userInfo, listUsersExternal, getSuperUser and getClusterUser', () => {
		it('should return user info', async () => {
			const result = await user.userInfo({
				hdb_user: {
					username: 'test_user',
					role: { id: 'super_user' },
					password: '123Abc',
					refresh_token: '34124sdfas',
					hash: '83b3dj3',
				},
			});
			expect(result.username).to.equal('test_user');
		});

		it('should return a list of users', async () => {
			await addTestUser();
			const result = await user.listUsersExternal();
			expect(result.some((u) => u.username === 'test_user')).to.be.true;
		});

		it('should return the super user', async () => {
			await addTestUser();
			const result = await user.getSuperUser();
			expect(result.role.role).to.equal('super_user');
			await dropTestUsers();
		});
	});
});
