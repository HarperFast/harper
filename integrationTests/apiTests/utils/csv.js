import request from "supertest";
import {checkJobCompleted, getJobId} from "./jobs.js";
import {envUrl, headers} from "../config/envConfig.js";

export async function csvFileUpload(schemaName, tableName, filePath, expectedErrorMessage, expectedCompletedMessage) {
    const response = await request(envUrl)
        .post('')
        .set(headers)
        .send({
            operation: 'csv_file_load',
            action: 'insert',
            schema: schemaName,
            table: tableName,
            file_path: filePath
        })
        .expect(200)
    const id = await getJobId(response.body);
    await checkJobCompleted(id, expectedErrorMessage, expectedCompletedMessage);
}

export async function csvUrlLoad(schemaName, tableName, fileUrl, expectedErrorMessage, expectedCompletedMessage) {
    const response = await request(envUrl)
        .post('')
        .set(headers)
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

export async function csvDataLoad(customHeaders, action, schemaName, tableName, data, expectedErrorMessage, expectedCompletedMessage) {
  const response = await request(envUrl)
    .post('')
    .set(customHeaders)
    .send({
      operation: 'csv_data_load',
      action: action,
      schema: schemaName,
      table: tableName,
      data: data
    })
    .expect(200)
  const id = await getJobId(response.body);
  const message = await checkJobCompleted(id, expectedErrorMessage, expectedCompletedMessage);
  return message;
}