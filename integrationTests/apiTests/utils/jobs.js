import assert from 'node:assert/strict';
import { setTimeout, setTimeout as sleep } from 'node:timers/promises';
import { req } from './request.js';
import { testData } from '../config/envConfig.js';

export function getJobId(jsonData) {
	assert.ok(jsonData.hasOwnProperty('job_id'), JSON.stringify(jsonData));
	assert.equal(jsonData.message.split(' ')[4], jsonData.job_id, JSON.stringify(jsonData));
	let id_index = jsonData.message.indexOf('id ');
	return jsonData.message.substring(id_index + 3, jsonData.message.length);
}

export async function checkJobCompleted(job_id, expectedErrorMessage, expectedCompletedMessage) {
	const response = await req()
		.send({
			operation: 'get_job',
			id: job_id,
		})
		.expect(200);

	const jsonData = await response.body;
	assert.equal(jsonData.length, 1, response.text);
	assert.ok(jsonData[0].hasOwnProperty('status'), response.text);
	let status = jsonData[0].status;
	switch (status) {
		case 'ERROR':
			if (expectedErrorMessage) {
				console.log(status + ' (AS EXPECTED) job id: ' + job_id);
				try {
					assert.ok(jsonData[0].message.includes(expectedErrorMessage), response.text);
				} catch (err) {
					console.log(response.text);
					assert.ok(jsonData[0].message.error.includes(expectedErrorMessage), response.text);
				}
				testData.jobErrorMessage = jsonData[0].message;
				console.log(testData.jobErrorMessage);
			} else {
				console.log(status + ' job id: ' + job_id);
				assert.fail('Status was ERROR. ' + response.text);
			}
			break;
		case 'COMPLETE':
			console.log(status + ' job id: ' + job_id);
			if (expectedCompletedMessage) {
				console.log(JSON.stringify(jsonData));
				assert.ok(jsonData[0].message.includes(expectedCompletedMessage), response.text);
			}
			assert.equal(status, 'COMPLETE', response.text);
			testData.jobErrorMessage = '';
			break;
		case '0':
			assert.fail('Status was: ' + response.text);
			break;
		case 0:
			assert.fail('Status was: ' + response.text);
			break;
		case 'IN_PROGRESS':
			console.log(status + ' checking again');
			await sleep(500);
			assert.ok(status == 'IN_PROGRESS' || status == 0 || status == '0', response.text);
			await checkJobCompleted(job_id, expectedErrorMessage, expectedCompletedMessage);
			break;
		default:
			console.log(status + ' job id: ' + job_id);
			assert.fail(
				'Status was not one of the expected ones. Status was: ' + status + ' job id: ' + job_id + ' ' + response.text
			);
			break;
	}
	return testData.jobErrorMessage;
}

export async function checkJob(job_id, timeoutInSeconds) {
	let jobResponse = null;
	let seconds = 0;
	do {
		jobResponse = await req()
			.send({
				operation: 'get_job',
				id: job_id,
			})
			.expect(200);
		await setTimeout(1000);
		seconds++;
	} while (jobResponse.body[0].status == 'IN_PROGRESS' && seconds < timeoutInSeconds);
	return jobResponse;
}
