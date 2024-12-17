import {after, describe, it} from 'node:test';
import assert from "node:assert";
import request from 'supertest';
import {checkTableInSchema, createSchema, describeSchema, dropSchema} from "../utils/schema.js";
import {envUrl, generic, headers} from "../config/envConfig.js";
import {createTable, dropTable} from "../utils/table.js";
import {csvFileUpload, csvUrlLoad} from "../utils/csv.js";
import {sleep} from "../utils/general.js";
import * as path from "node:path";
import { fileURLToPath } from 'url';
import {insert} from "../utils/insert.js";
import longTextJson from '../json/longText.json' with { type: "json" };
import dataBulkJson from '../json/dataBulk.json' with { type: "json" };
import remarksJson from '../json/remarks.json' with { type: "json" };
import dogJson from '../json/dog.json' with { type: "json" };
import breedJson from '../json/breed.json' with { type: "json" };
import ownerJson from '../json/owner.json' with { type: "json" };
import ownerOnlyJson from '../json/ownerOnly.json' with { type: "json" };
import {searchByHash} from "../utils/search.js";


describe('2. Data Load JSON', () => {

    //JSON Folder

    it('Import data bulk insert into dev.long_text table', async () => {
        await insert(generic.schema_dev, 'long_text',
            longTextJson.records, 'inserted 25');
    });

    it('Import data bulk confirm specific value exists', async () => {
        await searchByHash(generic.schema_dev, 'long_text',
            'id', [10], ['id', 'remarks'],
            '"id":10,"remarks":"Lovely updated home')
    });

    it('Import data bulk insert into call.aggr', async () => {
        await insert(generic.schema_call, 'aggr',
            dataBulkJson.records, 'inserted 10');
    });

    it('Insert dot & double dot data', async () => {
        await insert(generic.schema_call, 'aggr',
            [
                {
                    all: 11,
                    dog_name: ".",
                    owner_name: ".."
                }
            ],
            'inserted 1');
    });

    it('Insert confirm dot & double data', async () => {
        await searchByHash(generic.schema_call, 'aggr', 'all',
            [11], ['all', 'dog_name', 'owner_name'],
            '"all":11,"dog_name":".","owner_name":".."');

    });

    it('Insert attributes into DropAttributeTest', async () => {
        await insert(generic.schema_dev, 'AttributeDropTest',
            [
                {
                    hashid: 1,
                    some_attribute: "some_att1",
                    another_attribute: "1"
                },
                {
                    hashid: 2,
                    some_attribute: "some_att2",
                    another_attribute: "1"
                }
            ],
            'inserted 2');
    });

    it('Insert confirm attributes added', async () => {
        await searchByHash(generic.schema_dev, 'AttributeDropTest',
            'hashid', [1, 2],
            ['hashid', 'some_attribute', 'another_attribute'],
            '{"hashid":1,"some_attribute":"some_att1","another_attribute":"1"},' +
            '{"hashid":2,"some_attribute":"some_att2","another_attribute":"1"}');
    });

    it('Import data bulk insert into dev.remarks_blob table', async () => {
        await insert(generic.schema_dev, 'remarks_blob',
            remarksJson.records, 'inserted 11');
    });

    it('Insert data into dev.dog', async () => {
        await insert(generic.schema_dev, 'dog',
            dogJson.records, 'inserted 9');
    });

    it('Insert data into dev.breed', async () => {
        await insert(generic.schema_dev, 'breed',
            breedJson.records, 'inserted 350');
    });

    it('Insert data into dev.owner', async () => {
        await insert(generic.schema_dev, 'owner',
            ownerJson.records, 'inserted 4');
    });

    it('Insert data into other.owner', async () => {
        await insert(generic.schema_other, 'owner',
            ownerOnlyJson.records, 'inserted 4');
    });

    it('Insert data into another.breed', async () => {
        await insert(generic.schema_another, 'breed',
            breedJson.records, 'inserted 350');
    });


});
