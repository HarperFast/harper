import { callOperation } from './utility.js';
import axios from 'axios';
import { setupTestApp } from './setupTestApp.mjs';
import { assert, expect } from 'chai';

describe('test declared role', () => {
	before(async () => {
		await setupTestApp();
	});

	it('Add user to a declared role', async function () {
		let response = await callOperation({
			operation: 'add_user',
			role: 'declared-role',
			username: 'test-user-for-declared-role',
			password: 'test-password',
			active: true,
		});
		if (response.status !== 409)
			// if user already exists, probably from previous test run, that's ok
			expect(response.status).to.eq(200);
		const headers = {
			'Content-Type': 'application/json',
			'Authorization': 'Basic ' + btoa('test-user-for-declared-role:test-password'),
		};
		response = await callOperation(
			{
				operation: 'insert',
				table: 'SimpleRecord',
				records: [{ name: 'test', id: '6' }],
			}, headers
		);
		expect(response.status).to.eq(200);
		response = await axios('http://localhost:9926/SimpleRecord/6', {
			headers
		});
		expect(response.status).to.eq(200);
		let perm_error;
		try {
			response = await axios.put('http://localhost:9926/SimpleRecord/6', { name: 'test change' }, { headers });
		} catch (error) {
			perm_error = error;
		}
		expect(perm_error.response.status).to.eq(403);
	});
});
