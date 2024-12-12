import request from "supertest";
import assert from "node:assert";
import {checkJobCompleted, getJobId} from "./jobs.js";
import {envUrl} from "../config/envConfig.js";

export async function csvFileUpload(schemaName, tableName, filePath) {
    const response = await request(envUrl)
        .post('')
        .send({
            operation: 'csv_file_load',
            action: 'insert',
            schema: schemaName,
            table: tableName,
            file_path: filePath
        })
        .expect(200)
    const id = await getJobId(response.body);
    await checkJobCompleted(id);
}

export async function csvUrlLoad(schemaName, tableName, fileUrl, expectedErrorMessage, expectedCompletedMessage) {
    const response = await request(envUrl)
        .post('')
        .send({
            operation: 'csv_url_load',
            action: 'insert',
            schema: schemaName,
            table: tableName,
            csv_url: fileUrl
        })
        .expect(200)
    const id = await getJobId(response.body);
    await checkJobCompleted(id, expectedErrorMessage, expectedCompletedMessage);
}