import {describe, it, after, before} from 'node:test';
import {setTimeout} from 'node:timers/promises';
import {checkJobCompleted, getJobId} from "../utils/jobs.js";
import {envUrl, generic, headers} from "../config/envConfig.js";
import {csvFileUpload} from "../utils/csv.js";
import {setTimeout as sleep} from 'node:timers/promises';
import * as path from "node:path";
import {fileURLToPath} from 'url';
import request from 'supertest';
import assert from 'node:assert';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const myPath = path.resolve(__dirname + '/..' + generic.files_location) + '/';
// const myPath = path.resolve(process.cwd() + generic.files_location);



// it('csv_file_load with invalid attributes', async () => {
//     await csvFileUpload(generic.schema_dev, 'invalid_attribute',
//       myPath + 'InvalidAttributes.csv', 'Invalid column name');
// });


// it("Insert values into 'geo' table", async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send("{\n   \n\t\"operation\":\"insert\",\n\t\"table\":\"geo\",\n\t\"records\": [\n        {\n            \"id\": 1,\n            \"name\": \"Wellington\",\n            \"geo_point\" : {\n                \"type\": \"Point\",\n                \"coordinates\": [174.776230, -41.286461]\n            },\n            \"geo_poly\": {\n                \"type\": \"Polygon\",\n                \"coordinates\": [[ [174.615474867904,-41.34148585702194],\n                    [174.8800567396483,-41.31574371071801],\n                    [174.6896944170223,-41.19759744824616],\n                    [174.615474867904,-41.34148585702194]\n                ]]\n            },\n            \"geo_line\": {\n                \"type\": \"LineString\",\n                \"coordinates\": [\n                    [174.615474867904,-41.34148585702194],\n                    [174.8800567396483,-41.31574371071801]\n                ]\n            }\n        },\n        {\n            \"id\": 2,\n            \"name\": \"North Adams\",\n            \"geo_point\" : {\n                \"type\": \"Point\",\n                \"coordinates\": [-73.108704, 42.700539]\n            },\n            \"geo_poly\": {\n                \"type\": \"Polygon\",\n                \"coordinates\": [[                  [-73.12391499193579,42.70656096680374],\n                    [-73.12255557219314,42.69646774251972],\n                    [-73.09908993001123,42.6984753377431],\n                    [-73.10369107948782,42.70876034407737],\n                    [-73.12391499193579,42.70656096680374]\n                ]]\n            }\n        },\n        {\n            \"id\": 3,\n            \"name\": \"Denver\",\n            \"geo_point\" : {\n                \"type\": \"Point\",\n                \"coordinates\": [-104.990250, 39.739235]\n            },\n            \"geo_poly\": {\n                \"type\": \"Polygon\",\n                \"coordinates\": [[          [-105.0487835030464,39.77676227285275],\n                    [-105.0175466672944,39.68744341857906],\n                    [-104.9113967289065,39.74637288224356],\n                    [-105.0487835030464,39.77676227285275]\n                ]]\n            }\n        },\n        {\n            \"id\": 4,\n            \"name\": \"New York City\",\n            \"geo_point\" : {\n                \"type\": \"Point\",\n                \"coordinates\": [-74.005974, 40.712776]\n            },\n            \"geo_poly\": {\n                \"type\": \"Polygon\",\n                \"coordinates\": [[             [-74.00852603549784,40.73107908806126],\n                    [-74.03702059033735,40.70472625054263],\n                    [-73.98786450714653,40.70419899758365],\n                    [-74.00852603549784,40.73107908806126]\n                ]]\n            }\n        },\n        {\n            \"id\": 5,\n            \"name\": \"Salt Lake City\",\n            \"geo_point\" : {\n                \"type\": \"Point\",\n                \"coordinates\": [-111.920485, 40.7766079]\n            },\n            \"geo_poly\": {\n                \"type\": \"Polygon\",\n                \"coordinates\": [[           [-112.8291507578281,40.88206673094385],\n                    [-112.8956858211181,40.30332102898777],\n                    [-111.6032172200158,40.02757615254776],\n                    [-111.1456265349256,40.95908300700454],\n                    [-111.9047878338339,41.3291504973315],\n                    [-112.8291507578281,40.88206673094385]\n                ]]\n            },\n            \"geo_line\": {\n                \"type\": \"LineString\",\n                \"coordinates\": [        [-112.8291507578281,40.88206673094385],\n                    [-112.8956858211181,40.30332102898777],\n                    [-111.6032172200158,40.02757615254776],\n                    [-111.1456265349256,40.95908300700454],\n                    [-111.9047878338339,41.3291504973315],\n                    [-112.8291507578281,40.88206673094385]\n                ]\n            }\n        },\n        {\n            \"id\": 6,\n            \"name\": \"Null Island\",\n            \"geo_point\" : {\n                \"type\": \"Point\",\n                \"coordinates\": [null, null]\n            },\n            \"geo_poly\": null,\n            \"geo_line\": {\n                \"type\": \"LineString\",\n                \"coordinates\": [\n                    [-112.8291507578281,40.88206673094385],\n                    [null, null]\n                ]\n            }\n        },\n        {\n            \"id\": 7\n        },\n        {\n            \"id\": 8,\n            \"name\": \"Hobbiton\",\n            \"geo_point\" : [174.776230, -41.286461],\n            \"geo_poly\": \"Somewhere in the shire\",\n            \"geo_line\": {\n                \"type\": \"LineString\"\n            }\n        }\n    ]\n}\n")
//     .expect((r) => assert.ok(r.body.message == "inserted 8 of 8 records"))
//     .expect(200)
// });



it('Create table "geo"', async () => {
  const response = await request(envUrl)
    .post('')
    .set(headers)
    .send({ 'operation': 'create_table', 'table': 'geo', 'hash_attribute': 'id' })
    .expect(200)
    .expect((r) => assert.ok(r.body.message == 'table \'data.geo\' successfully created.'));
});

it('Insert values into "geo" table', async () => {
  const response = await request(envUrl)
    .post('')
    .set(headers)
    .send('{\n   \n\t"operation":"insert",\n\t"table":"geo",\n\t"records": [\n        {\n            "id": 1,\n            "name": "Wellington",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [174.776230, -41.286461]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[ [174.615474867904,-41.34148585702194],\n                    [174.8800567396483,-41.31574371071801],\n                    [174.6896944170223,-41.19759744824616],\n                    [174.615474867904,-41.34148585702194]\n                ]]\n            },\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [\n                    [174.615474867904,-41.34148585702194],\n                    [174.8800567396483,-41.31574371071801]\n                ]\n            }\n        },\n        {\n            "id": 2,\n            "name": "North Adams",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-73.108704, 42.700539]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[                  [-73.12391499193579,42.70656096680374],\n                    [-73.12255557219314,42.69646774251972],\n                    [-73.09908993001123,42.6984753377431],\n                    [-73.10369107948782,42.70876034407737],\n                    [-73.12391499193579,42.70656096680374]\n                ]]\n            }\n        },\n        {\n            "id": 3,\n            "name": "Denver",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-104.990250, 39.739235]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[          [-105.0487835030464,39.77676227285275],\n                    [-105.0175466672944,39.68744341857906],\n                    [-104.9113967289065,39.74637288224356],\n                    [-105.0487835030464,39.77676227285275]\n                ]]\n            }\n        },\n        {\n            "id": 4,\n            "name": "New York City",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-74.005974, 40.712776]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[             [-74.00852603549784,40.73107908806126],\n                    [-74.03702059033735,40.70472625054263],\n                    [-73.98786450714653,40.70419899758365],\n                    [-74.00852603549784,40.73107908806126]\n                ]]\n            }\n        },\n        {\n            "id": 5,\n            "name": "Salt Lake City",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [-111.920485, 40.7766079]\n            },\n            "geo_poly": {\n                "type": "Polygon",\n                "coordinates": [[           [-112.8291507578281,40.88206673094385],\n                    [-112.8956858211181,40.30332102898777],\n                    [-111.6032172200158,40.02757615254776],\n                    [-111.1456265349256,40.95908300700454],\n                    [-111.9047878338339,41.3291504973315],\n                    [-112.8291507578281,40.88206673094385]\n                ]]\n            },\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [        [-112.8291507578281,40.88206673094385],\n                    [-112.8956858211181,40.30332102898777],\n                    [-111.6032172200158,40.02757615254776],\n                    [-111.1456265349256,40.95908300700454],\n                    [-111.9047878338339,41.3291504973315],\n                    [-112.8291507578281,40.88206673094385]\n                ]\n            }\n        },\n        {\n            "id": 6,\n            "name": "Null Island",\n            "geo_point" : {\n                "type": "Point",\n                "coordinates": [null, null]\n            },\n            "geo_poly": null,\n            "geo_line": {\n                "type": "LineString",\n                "coordinates": [\n                    [-112.8291507578281,40.88206673094385],\n                    [null, null]\n                ]\n            }\n        },\n        {\n            "id": 7\n        },\n        {\n            "id": 8,\n            "name": "Hobbiton",\n            "geo_point" : [174.776230, -41.286461],\n            "geo_poly": "Somewhere in the shire",\n            "geo_line": {\n                "type": "LineString"\n            }\n        }\n    ]\n}\n')
    .expect((r) => assert.ok(r.body.message == 'inserted 8 of 8 records'))
    .expect(200);
});

it('geoArea test 1', async () => {
  const response = await request(envUrl)
    .post('')
    .set(headers)
    .send({ 'operation': 'sql', 'sql': 'SELECT id, name, geoArea(geo_poly) as area FROM data.geo ORDER BY area ASC' })
    .expect((r) => assert.deepEqual(r.body, [
      {
        'id': 6,
        'name': 'Null Island',
      },
      {
        'id': 7,
        'name': null,
      },
      {
        'id': 8,
        'name': 'Hobbiton',
      },
      {
        'id': 2,
        'name': 'North Adams',
        'area': 2084050.5321900067,
      },
      {
        'id': 4,
        'name': 'New York City',
        'area': 6153970.008639627,
      },
      {
        'id': 3,
        'name': 'Denver',
        'area': 53950986.64863105,
      },
      {
        'id': 1,
        'name': 'Wellington',
        'area': 168404308.63474682,
      },
      {
        'id': 5,
        'name': 'Salt Lake City',
        'area': 14011200847.709723,
      }]))
    .expect(200)
});

it('geoArea test 2', async () => {
  const response = await request(envUrl)
    .post('')
    .set(headers)
    .send({ 'operation': 'sql', 'sql': 'SELECT id, name FROM data.geo where geoArea(geo_poly) > 53950986.64863106' })
    .expect((r) => assert.deepEqual(r.body, [
      {
        'id': 1,
        'name': 'Wellington',
      },
      {
        'id': 5,
        'name': 'Salt Lake City',
      }]))
    .expect(200)
});

it('geoArea test 3', async () => {
  const response = await request(envUrl)
    .post('')
    .set(headers)
    .send({
      'operation': 'sql',
      'sql': 'SELECT geoArea(\'{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[0.123456,0],[0.123456,0.123456],[0,0.123456]]]}}\')',
    })
    .expect((r) => assert.deepEqual(r.body, [
      {
        'geoArea(\'{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[0.123456,0],[0.123456,0.123456],[0,0.123456]]]}}\')': 188871526.05092356,
      }]))
    .expect(200)
});