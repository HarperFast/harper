import request from "supertest";
import assert from "node:assert";
import {check_job_completed, get_job_id} from "./jobs.js";

export async function csv_file_upload(url, schemaName, tableName, filePath) {
    const response = await request(url)
        .post('')
        .send({
            operation: 'csv_file_load',
            action: 'insert',
            schema: schemaName,
            table: tableName,
            file_path: filePath
        })
        .expect(200)
    const id = await get_job_id(url, response.body);
    await check_job_completed(url, id);
}

export async function csv_url_load(url, schemaName, tableName, fileUrl, expectedErrorMessage, expectedCompletedMessage) {
    const response = await request(url)
        .post('')
        .send({
            operation: 'csv_url_load',
            action: 'insert',
            schema: schemaName,
            table: tableName,
            csv_url: fileUrl
        })
        .expect(200)
    const id = await get_job_id(url, response.body);
    await check_job_completed(url, id, expectedErrorMessage, expectedCompletedMessage);
}