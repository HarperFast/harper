import request from "supertest";
import assert from "node:assert";
import { setTimeout, setTimeout as sleep } from 'node:timers/promises';
import {envUrl, headers} from "../config/envConfig.js";


export async function getJobId(jsonData) {
    assert.ok(jsonData.hasOwnProperty('job_id'));
    assert.equal(jsonData.message.split(" ")[4], jsonData.job_id);
    let id_index = jsonData.message.indexOf("id ");
    let parsedId = jsonData.message.substring(id_index + 3, jsonData.message.length);
    return parsedId;
}

let errorMessage = "";

export async function checkJobCompleted(job_id, expectedErrorMessage, expectedCompletedMessage) {
    const response = await request(envUrl)
        .post('')
        .set(headers)
        .send({
            operation: 'get_job',
            id: job_id
        })
        .expect(200)

    const jsonData = await response.body;
    assert.equal(jsonData.length, 1);
    assert.ok(jsonData[0].hasOwnProperty('status'));
    let status = jsonData[0].status;
    switch (status) {
        case 'ERROR':
            if (expectedErrorMessage) {
                console.log(status + " (AS EXPECTED) job id: " + job_id);
                try {
                    assert.ok(jsonData[0].message.includes(expectedErrorMessage));
                } catch(err) {
                    assert.ok(jsonData[0].message.error.includes(expectedErrorMessage));
                }
                errorMessage = jsonData[0].message;
                console.log(errorMessage);
            } else {
                console.log(status + " job id: " + job_id);
                assert.fail('Status was ERROR');
            }
            break;
        case 'COMPLETE':
            console.log(status + " job id: " + job_id);
            if (expectedCompletedMessage) {
                console.log(JSON.stringify(jsonData));
                assert.ok(jsonData[0].message.includes(expectedCompletedMessage));
            }
            assert.equal(status, 'COMPLETE');
            errorMessage = "";
            break;
        case '0':
            assert.fail('Status was: ' + status);
        case 0:
            assert.fail('Status was: ' + status);
        case 'IN_PROGRESS':
            console.log(status + ' checking again');
            await sleep(1000);
            assert.ok(status == 'IN_PROGRESS' || status == 0 || status == '0');
            await checkJobCompleted(job_id, expectedErrorMessage, expectedCompletedMessage);
            break;
        default:
            console.log(status + " job id: " + job_id);
            assert.fail('Status was not one of the expected ones. Status was: ' + status + ' job id: ' + job_id);
            break;
    }
    return errorMessage;
}

export async function checkJob(job_id, timeoutInSeconds) {
	let jobResponse = null;
  let seconds = 0;
	do {
		jobResponse = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'get_job',
				id: job_id,
			})
			.expect(200);
		await setTimeout(1000);
    seconds++;
    console.log(seconds + ' ' + jobResponse.body[0].status);
	} while (jobResponse.body[0].status == 'IN_PROGRESS' && seconds < timeoutInSeconds);
	return jobResponse;
}
