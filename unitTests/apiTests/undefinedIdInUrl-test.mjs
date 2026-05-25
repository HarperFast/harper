'use strict';

import { assert } from 'chai';
import axios from 'axios';
import { setupTestApp } from './setupTestApp.mjs';

// A common client bug is template-stringifying an `undefined` value into a URL
// path: PATCH /<Resource>/undefined. Pre-fix behavior depended on the PK type:
//   • numeric PK: "undefined"/"NaN"/"true" → 400 via coerceType regex (OK),
//                 but "null" silently coerced to null and surfaced as 500.
//   • Any PK:     "undefined"/"null"/"true" → 500 (autoCast then checkValidId).
//                 "NaN" was even saved with NaN id (data corruption).
//   • String PK:  all literals are valid string ids and remain accepted.
//
// Fix: checkValidId now throws ClientError(400) instead of Error, and also
// rejects NaN.
describe('Invalid primary keys from URL paths return 400', () => {
	before(async function () {
		this.timeout(5000);
		await setupTestApp();
	});

	const request = (method, path, body) =>
		axios.request({
			method,
			url: `http://localhost:9926${path}`,
			data: body,
			validateStatus: () => true,
		});

	describe('numeric primary keys', () => {
		// DogIntPK: id: Int @primaryKey
		for (const literal of ['undefined', 'null', 'NaN', 'true']) {
			it(`PATCH /DogIntPK/${literal} → 400`, async function () {
				const response = await request('patch', `/DogIntPK/${literal}`, { name: 'Fido' });
				assert.equal(response.status, 400);
				assert.notExists(
					await request('get', `/DogIntPK/${literal}`).then((r) => (r.status === 200 ? r.data : undefined)),
					'no record should have been persisted'
				);
			});

			it(`PUT /DogIntPK/${literal} → 400`, async function () {
				const response = await request('put', `/DogIntPK/${literal}`, { name: 'Fido' });
				assert.equal(response.status, 400);
			});
		}

		it('PUT /DogIntPK/42 still works (sanity check)', async function () {
			const response = await request('put', '/DogIntPK/42', { name: 'Rex' });
			assert.equal(response.status, 204);
			const fetched = await request('get', '/DogIntPK/42');
			assert.equal(fetched.status, 200);
			assert.equal(fetched.data.name, 'Rex');
		});
	});

	describe('Any-typed primary keys', () => {
		// DogAnyPK: id: Any @primaryKey — autoCast can turn "undefined"/"null" into
		// null and "true" into a boolean; without the fix, all surfaced as 500.
		// "NaN" was even silently persisted as a record keyed by NaN.
		for (const literal of ['undefined', 'null', 'NaN', 'true']) {
			it(`PATCH /DogAnyPK/${literal} → 400`, async function () {
				const response = await request('patch', `/DogAnyPK/${literal}`, { name: 'Fido' });
				assert.equal(response.status, 400);
			});
		}

		it('no records were persisted to DogAnyPK', async function () {
			// All literal-id requests above should have rejected before any write.
			const list = await request('get', '/DogAnyPK/');
			assert.equal(list.status, 200);
			assert.deepEqual(list.data, []);
		});
	});

	describe('String-typed primary keys still accept literal strings', () => {
		// DogStringPK: id: String @primaryKey — "undefined"/"null"/etc. are
		// legitimate string ids and should round-trip.
		for (const literal of ['undefined', 'null', 'NaN', 'true']) {
			it(`PUT /DogStringPK/${literal} round-trips`, async function () {
				const put = await request('put', `/DogStringPK/${literal}`, { name: `Fido-${literal}` });
				assert.equal(put.status, 204);
				const fetched = await request('get', `/DogStringPK/${literal}`);
				assert.equal(fetched.status, 200);
				assert.equal(fetched.data.name, `Fido-${literal}`);
			});
		}
	});
});
