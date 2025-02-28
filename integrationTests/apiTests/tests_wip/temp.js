import {describe, it, after, before} from 'node:test';
import {setTimeout} from 'node:timers/promises';
import {checkJobCompleted, getJobId} from "../utils/jobs.js";
import {envUrl, generic, headers} from "../config/envConfig.js";
import {csvFileUpload} from "../utils/csv.js";
import {setTimeout as sleep} from 'node:timers/promises';
import * as path from "node:path";
import {fileURLToPath} from 'url';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const myPath = path.resolve(__dirname + '/..' + generic.files_location) + '/';
// const myPath = path.resolve(process.cwd() + generic.files_location);


it('csv_file_load with invalid attributes', async () => {
    console.log(myPath + 'InvalidAttributes.csv');
    await csvFileUpload(generic.schema_dev, 'invalid_attribute',
        myPath + 'InvalidAttributes.csv');
});