import {describe, it, after, before} from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
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



//test('mytest', async (t) => {
//    assert.ok('my' == 'my');
//    let x = "database 'braaah' does not exist";
//    assert.ok(x == "database 'braaah' does not exist");
//});

//it('Create schema for S3 test', async () => {
//  const response = await request('http://localhost:9925')
//    .post('')
//    .set({'Content-Type': 'application/json'})
////    .set('Authorization', 'Basic c2dvbGRiZXJnOnRlc3QxMjM0IQ==')
//    .send({"operation":"create_schema","schema":"S3_DATA"})
//    .expect((r) => {
////        console.log(JSON.stringify(r));
////        console.log(JSON.stringify(r.text));
////        console.log(r.status);
//        assert.ok(r.body.error == "database 'S3_DATA' already exists");
//        assert.ok(r.body.error.includes('already exists'));
//        assert.ok(r.body.error.includes("already exists"));
//        assert.ok(r.body.error);
////        assert.ok(typeof r.body[0] === 'object');
//
////        assert.ok(r.body.message);
////        assert.ok(false, 'this should fail');
//    })
//    .expect(400);
//});

//it('Test r.body[0]', async () => {
//    const response = await request('http://localhost:9925')
//        .post('')
//        .set({'Content-Type': 'application/json'})
//        .send({
//            operation: 'get_job',
//            id: 'f7cade26-9ae2-43bd-b109-ee0f5a87fffd'
//        })
//        .expect((r) => {
//            assert.ok(r.status);
//            assert.ok(r.status == 200);
//            assert.ok(r.body[0].hasOwnProperty('status'));
//            assert.ok(r.body[0].hasOwnProperty('status'));
////            console.log('r.body: ' + r.body);
////            console.log('JSON.stringify(r.body): ' + JSON.stringify(r.body));
////            console.log('r.body[0]: ' + r.body[0]);
////            console.log('JSON.stringify(r.body[0]): ' + JSON.stringify(r.body[0]));
////            console.log('r.body[0].status: ' + r.body[0].status);
//            assert.ok(typeof r.body[0] === 'object');
//        })
//        .expect(200)
//});

//it('Test sql', async () => {
//    const response = await request('http://localhost:9925')
//        .post('')
//        .set({'Content-Type': 'application/json'})
//        .send({"operation":"sql","sql":"select b.id, b.authors as authors, AVG(r.rating) from dev.ratings as r join dev.books as b on r.book_id = b.id group by b.authors, b.id order by b.id"})
//        .expect((r) => {
//            console.log('r.body: ' + JSON.stringify(r.body));
//            console.log('r.body[0]' + JSON.stringify(r.body[0]));
//            console.log('r.body[0].id: ' + r.body[0].id);
//            assert.ok(r.body[0].id == 1);
//
//              assert.ok(r.body[0].id);
//              assert.ok(!r.body[0].ids);
//              assert.ok([1, 2, 3, 4].includes(2));
//              assert.ok(r.body[0].id && r.body[0].authors);
//
//        });
//});

//it('Test sql2', async () => {
//    const response = await request('http://localhost:9925')
//        .post('')
//        .set({'Content-Type': 'application/json'})
//        .send({"operation":"sql","sql":"DELETE FROM dev.rando WHERE id IN ('987654321', '987654322')"})
//        .expect(async (r) => {
//            console.log('r.body: ' + JSON.stringify(r.body));
//            console.log('r.body.deleted_hashes: ' + JSON.stringify(r.body.deleted_hashes));
//            //without await is useless
//            //in my tests it seems it works with await inside the expect()
////            await setTimeout(2000);
//             console.log('@@@@@');
////            console.log('r.body[0].id: ' + r.body[0].id);
////            assert.ok(r.body[0].987654321 && r.body[0].987654322);
//
//        })
//        .expect((r) => {
//            console.log("Should be after @@@@@@");
//            assert.ok(r.body.error.includes('does not exist'));
//        })
//        //with await here:
//        await setTimeout(1000);
//        console.log('#######');
//});

//
//it('insert invalid attribute name - single row', async () => {
//  const response = await request('http://localhost:9925')
//    .post('')
//    .set({'Content-Type': 'application/json'})
//    .send({"operation":"insert","schema":"dev","table":"invalid_attribute","records":[{"id":3,"some`$`attribute":"some_attribute"}]})
//    .expect(400)
//    .expect((r) => assert.ok(r.body.error == "Attribute names cannot include backticks or forward slashes"))
//    .expect((r) => assert.ok(!r.body.message));
//});
//
//it('Create schema', async () => {
//  const response = await request('http://localhost:9925')
//    .post('')
//    .set({'Content-Type': 'application/json'})
//    .send({"operation":"create_schema","schema":"cucuBau"})
//    .expect(200);
//});

//it('NoSQL search by hash no table', async () => {
//const response = await request(envUrl)
//.post('')
//.set(headers)
//.send({"operation":"search_by_hash","schema":"call","table":"aggrABC","hash_values":[4],"get_attributes":["*"]})
//.expect(404)
//.expect((r) => assert.ok(r.body.error == "Table 'call.aggrABC' does not exist"))
//});

//it('Set License Bad Key', async () => {
//const response = await request(envUrl)
//.post('')
//.set(headers)
//.send({"operation":"set_license","key":"","company":"harperdb.io"})
//.expect(500)
//.expect((r) => {
//    console.log(r.body);
//    console.log(r.body.error);
//    console.log(r.body['error']);
//})
//.expect((r) => assert.ok(r.body["error"] == "Invalid key or company specified for license file."))
//// Unmatched Postman assertion: pm.expect(jsonData['error']).to.equal("Invalid key or company specified for license file."))
//});

//it('Cluster set routes', async () => {
//const response = await request(envUrl)
//.post('')
//.set(headers)
//.send({
//          "operation": "cluster_set_routes",
//          "server": "hub",
//          "routes": [
//              {
//                  "host": "dev.chicken",
//                  "port": 11334
//              },
//              {
//                  "host": "dev.wing",
//                  "port": 11335
//              }
//          ]
//})
//.expect(200)
//.expect((r) => console.log(r.body))
//});

//it('Cluster get routes', async () => {
//const response = await request(envUrl)
//.post('')
//.set(headers)
//.send({"operation":"cluster_get_routes"})
//.expect(200)
//.expect((r) => console.log(r.body))
////.expect((r) => assert.ok(r.body.includes([{ host: 'dev.chicken', port: 11334 },{ host: 'dev.wing', port: 11335 }])))
//.expect((r) => assert.ok(r.body[0].host == 'dev.chicken'))
//.expect((r) => console.log(JSON.stringify(r.body)))
//.expect((r) => assert.ok(JSON.stringify(r.body) == '[{"host":"dev.chicken","port":11334},{"host":"dev.wing","port":11335}]'))
//.expect((r) => assert.ok(JSON.stringify(r.body) == `[{"host":"dev.chicken","port":11334},{"host":"dev.wing","port":11335}]`))
//});


//it('Cluster delete routes', async () => {
//const expected_result = `{
//"message": "cluster routes successfully deleted",
//"deleted": [ { "host": "dev.wing", "port": 11335 },
//{
//"host": "dev.pie",
//"port": 11335
//}
//],
//"skipped": [
//{
//"host": "dev.pie",
//"port": 11221
//}
//]
//}`
//console.log(expected_result);
//const response = await request(envUrl)
//.post('')
//.set(headers)
//.send({"operation":"cluster_delete_routes","routes":[{"host":"dev.wing","port":11335},{"host":"dev.pie","port":11335},{"host":"dev.pie","port":11221}]})
//.expect(200)
//.expect((r) => {
//    console.log(r.body)
//    //assert.ok(r.body == expected_result))
//})
//});


//const substrings = ["Sophie", "George", "Biggie Paws", "Willow", "Bird", "Murph", "Simba", "Gemma", "Bobby"];
//const str = "this has one Baiggie Paws and Willoaw";
//if (substrings.some(v => str.includes(v))) {
//    console.log(`\nMatch using "${str}"\n`);
//} else {
//    console.log(`\nNo match using "${str}"\n`);
//}

//it('Drop schema', async () => {
//  const response = await request('http://localhost:9925')
//    .post('')
//    .set({'Content-Type': 'application/json'})
//    .send({"operation":"drop_schema","schema":"cucuBau"})
//    .expect(200);
//});
//
//it('Cluster set routes leaf', async () => {
//let expected = `
//{
//  message: 'cluster routes successfully set',
//  set: [],
//  skipped: [
//    { host: 'dev.chicken', port: 11334 },
//    { host: 'dev.pie', port: 11335 }
//  ]
//}
//`
//const response = await request(envUrl)
//.post('')
//.set(headers)
//.send({"operation":"cluster_set_routes","server":"leaf","routes":[{"host":"dev.chicken","port":11334},{"host":"dev.pie","port":11335}]})
//.expect(200)
//.expect((r) => {
//    console.log(JSON.stringify(r.body))
//    expected = expected.replace(/(\r\n|\n|\r)/gm, "").trim()
//    console.log(JSON.stringify(expected))
////    assert.ok(JSON.stringify(r.body) == JSON.stringify(expected))
//})
//});
//
//it('Cluster set routes leaf', async () => {
//const response = await request(envUrl)
//.post('')
//.set(headers)
//.send({"operation":"cluster_set_routes","server":"leaf","routes":[{"host":"dev.chicken","port":11334},{"host":"dev.pie","port":11335}]})
//.expect(200)
//.expect((r) => {
//    console.log(JSON.stringify(r.body))
//    //assert.ok(r.body == expected_result))
//})
//});

//it('Cluster set routes leaf', async () => {
////const expected = '{"message":"cluster routes successfully set","set":[{"host":"dev.pie","port":11335}],"skipped":[{"host":"dev.chicken","port":11334}]}';
//const expected = '{"message":"cluster routes successfully set","set":[],"skipped":[{"host":"dev.chicken","port":11334},{"host":"dev.pie","port":11335}]}';
//const response = await request(envUrl)
//.post('')
//.set(headers)
//.send({"operation":"cluster_set_routes","server":"leaf","routes":[{"host":"dev.chicken","port":11334},{"host":"dev.pie","port":11335}]})
//.expect(200)
//.expect((r) => assert.ok(JSON.stringify(r.body) == expected))
//});

//it('Cluster get routes confirm delete', async () => {
//const response = await request(envUrl)
//.post('')
//.set(headers)
//.send({"operation":"cluster_get_routes"})
//.expect(200)
////.expect((r) => assert.ok(JSON.stringify(r.body) == '{"hub":[{"host":"dev.chicken","port":11334}],"leaf":[]}'))
//.expect((r) => assert.ok(JSON.stringify(r.body) == '[{"host":"dev.chicken","port":11334},{"host":"dev.wing","port":11335}]'))
//.expect((r) => console.log(JSON.stringify(r.body)))
//});

//it('Cluster get routes', async () => {
//const response = await request(envUrl)
//.post('')
//.set(headers)
//.send({"operation":"cluster_get_routes"})
//.expect(200)
//.expect((r) => console.log(JSON.stringify(r.body)))
////.expect((r) => assert.ok(JSON.stringify(r.body) == '{"hub":[{"host":"dev.chicken","port":11334},{"host":"dev.wing","port":11335}],"leaf":[{"host":"dev.pie","port":11335}]}'))
//});

// it('Add component', async () => {
// const response = await request(envUrl)
// .post('')
// .send({"operation":"add_component","project":"appGraphQL"})
// .expect((r) => {
//     const res = JSON.stringify(r.body);
//     assert.ok(res.includes('Successfully added project') || res.includes('Project already exists'))
// })
// });

// it('Get open api', async () => {
// const response = await request(envUrlRest)
// .get('/openapi')
// .set(headers)
// .expect(200)
// .expect((r) => {
//     let openapi_text = JSON.stringify(r.body.openapi)
//     assert.ok(!openapi_text);
//     assert.ok(r.body.info.title.includes('HarperDB HTTP REST interface'));
//     assert.ok(r.body.paths);
//     assert.ok(r.body.paths.hasOwnProperty('/TableName/'));
//     assert.ok(r.body.paths.hasOwnProperty('/TableName/{id}'));
//     assert.ok(r.body.paths.hasOwnProperty('/Greeting/'));
//     let paths_text = JSON.stringify(r.body.paths);
//     assert.ok(paths_text.includes('post'));
//     assert.ok(paths_text.includes('get'));
//     assert.ok(r.body.components);
//     assert.ok(r.body.components.schemas);
//     assert.ok(r.body.components.schemas.TableName);
//     assert.ok(r.body.components.schemas.Greeting);
//     assert.ok(r.body.components.securitySchemes);
//     assert.ok(r.body.components.securitySchemes.basicAuth);
//     assert.ok(r.body.components.securitySchemes.bearerAuth);
// })
// });

// it('SELECT', async () => {
//     const response = await request(envUrl)
//         .post('')
//         .set(headers)
//         .send({"operation":"sql","sql":"SELECT * FROM d1.t1"})
//         .expect((r) => {
//             assert.ok(r.body[0].name == "cucu");
//             let expectedJson = [{"id": 225086962176237,"__createdtime__": 1740737584647.4128,"__updatedtime__": 1740737584647.4128,"name": "cucu"}];
//             let expectedJson2 = [
//                 {
//                     "id": 225086962176237,"__createdtime__": 1740737584647.4128,"__updatedtime__": 1740737584647.4128,"name": "cucu"
//                 }
//             ];
//             let expectedJson3 = JSON.parse('[{"id": 225086962176237,"__createdtime__": 1740737584647.4128,"__updatedtime__": 1740737584647.4128,"name": "cucu"}]');
//
//             let expectedJson4 = [
// {
// "id": 225086962176237,
// "name": "cucu",
// "__createdtime__": 1740737584647.4128,"__updatedtime__": 1740737584647.4128
// }];
//
//             let expectedJson5 = [
// {
// "id": 225086962176237,
// "name": "cucu",
// "__updatedtime__": 1740737584647.4128,
// "__createdtime__": 1740737584647.4128
// }];
//
//
//             assert.deepEqual(r.body, expectedJson);
//             assert.deepStrictEqual(r.body, expectedJson);
//
//             assert.deepEqual(r.body, expectedJson2);
//             assert.deepStrictEqual(r.body, expectedJson2);
//
//             assert.deepEqual(r.body, expectedJson3);
//             assert.deepStrictEqual(r.body, expectedJson3);
//
//             assert.deepEqual(r.body, expectedJson4);
//             assert.deepStrictEqual(r.body, expectedJson4);
//
//             assert.deepEqual(r.body, expectedJson5);
//             assert.deepStrictEqual(r.body, expectedJson5);
//         })
// });

// it('Confirm update record with nonexistant id dev.cat', async () => {
//     const response = await request(envUrl)
//         .post('')
//         .send({"operation":"sql","sql":"SELECT id,name FROM dev.cat WHERE id = 75"})
//         .expect(200)
//         .expect((r) => {
//             // assert.deepEqual(r.body, []);
//             assert.ok(Array.isArray(r.body));
//             console.log('Length: ' + r.body.length);
//             console.log(r.body[0]);
//             console.log(r.body[0].id);
//             console.log(r.body[0].name);
//             assert.ok(r.body.length == 1);
//           assert.ok(r.body[0].name === "miau");
//         });
// });


// it('geoNear test 1', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({
//       'operation': 'sql',
//       'sql': 'SELECT id, name FROM data.geo WHERE geoNear(\'[-104.979127,39.761563]\', geo_point, 50, \'miles\')',
//     })
//     .expect(200)
//     .expect((r) => assert.deepEqual(r.body, [
//         {
//           'id': 3,
//           'name': 'Denver',
//         },
//       ],
//     ));
// });


it('geoConvert test 1', async () => {
  const response = await request(envUrl)
    .post('')
    .set(headers)
    .send({
      'operation': 'sql',
      'sql': 'SELECT geoConvert(\'[-104.979127,39.761563]\',\'point\',\'{"name": "HarperDB Headquarters"}\')',
    })
    .expect(200)
    .expect((r) => {
      console.log(r.body);
      assert.deepEqual(r.body, [
        {
          'geoConvert(\'[-104.979127,39.761563]\',\'point\',\'{"name": "HarperDB Headquarters"}\')': {
            'type': 'Feature',
            'properties': '{"name": "HarperDB Headquarters"}',
            'geometry': {
              'type': 'Point',
              'coordinates': [
                -104.979127,
                39.761563,
              ],
            },
          },
        }])
    })
});