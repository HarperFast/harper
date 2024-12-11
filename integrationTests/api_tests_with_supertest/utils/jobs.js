import request from "supertest";
import assert from "node:assert";
import {sleep} from "./general.js";


export async function get_job_id(url, jsonData){
    assert.ok(jsonData.hasOwnProperty('job_id'));
    assert.equal(jsonData.message.split(" ")[4], jsonData.job_id);
    let id_index = jsonData.message.indexOf("id ");
    let parsedId = jsonData.message.substring(id_index + 3, jsonData.message.length);
    return parsedId;
}

export async function check_job_completed(url, job_id, expectedErrorMessage, expectedCompletedMessage){
    const response = await request(url)
        .post('')
        .send({
            operation: 'get_job',
            id: job_id
        })
        .expect(200)

    const jsonData = await response.body;
    assert.equal(jsonData.length, 1);
    assert.ok(jsonData[0].hasOwnProperty('status'));
    let status = jsonData[0].status;
    switch(status){
        case 'ERROR':
            if(expectedErrorMessage) {
                console.log(status + " (AS EXPECTED) job id: " + job_id);
                assert.ok(jsonData[0].message.includes(expectedErrorMessage));
            }
            else {
                console.log(status + " job id: " + job_id);
                assert.fail('Status was ERROR');
            }
            break;
        case 'COMPLETE':
            console.log(status + " job id: " + job_id);
            if(expectedCompletedMessage)
                assert.ok(jsonData[0].message.includes(expectedCompletedMessage));
            assert.equal(status, 'COMPLETE');
            break;
        case '0':
            assert.fail('Status was: ' + status);
        case 0:
            assert.fail('Status was: ' + status);
        case 'IN_PROGRESS':
            console.log(status + ' checking again');
            await sleep(1000);
            assert.ok(status == 'IN_PROGRESS' || status == 0 || status == '0');
            await check_job_completed(url, job_id, expectedErrorMessage, expectedCompletedMessage);
            break;
        default:
            console.log(status + " job id: " + job_id);
            assert.fail('Status was not one of the expected ones. Status was: ' + status + ' job id: ' + job_id);
            break;
    }
}
