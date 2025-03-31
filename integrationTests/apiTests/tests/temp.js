import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import {
	dateTomorrow,
	dateYesterday,
	envUrl,
	generic,
	getCsvPath,
	headers,
	headersTestUser,
} from '../config/envConfig.js';
import { checkJob, checkJobCompleted, getJobId } from '../utils/jobs.js';
import { setTimeout } from 'node:timers/promises';



it('Create schema for S3 test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ operation: 'create_schema', schema: 'S3_DATA' })
		.expect(200);
});

it('Create dogs table for S3 test', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ operation: 'create_table', schema: 'S3_DATA', table: 'dogs', hash_attribute: 'id' })
		.expect(200);
});

it('Import dogs.csv from S3', async () => {
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({
			operation: 'import_from_s3',
			action: 'insert',
			schema: 'S3_DATA',
			table: 'dogs',
			s3: {
				aws_access_key_id: `${generic.s3_key}`,
				aws_secret_access_key: `${generic.s3_secret}`,
				bucket: 'harperdb-integration-test-data',
				key: 'non_public_folder/dogs.csv',
				region: 'us-east-2',
			},
		})
		.expect((r) =>
			assert.ok(r.body.message.indexOf('Starting job') == 0, 'Expected to find "Starting job" in the response')
		)
		.expect(200);

	const id = await getJobId(response.body);
	await checkJobCompleted(id, '', 'successfully loaded 12 of 12 records');
});
