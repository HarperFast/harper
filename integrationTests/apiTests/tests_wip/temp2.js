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

//
// it('geoConvert test 1', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({
//       'operation': 'sql',
//       'sql': 'SELECT geoConvert(\'[-104.979127,39.761563]\',\'point\',\'{"name": "HarperDB Headquarters"}\')',
//     })
//     .expect(200)
//     .expect((r) => {
//       console.log(r.body);
//       assert.deepEqual(r.body, [
//         {
//           'geoConvert(\'[-104.979127,39.761563]\',\'point\',\'{"name": "HarperDB Headquarters"}\')': {
//             'type': 'Feature',
//             'properties': '{"name": "HarperDB Headquarters"}',
//             'geometry': {
//               'type': 'Point',
//               'coordinates': [
//                 -104.979127,
//                 39.761563,
//               ],
//             },
//           },
//         }])
//     })
// });

//
// it('NoSQL Add non SU role', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({
//       'operation': 'add_role', 'role': 'developer_test_11', 'permission': {
//         'super_user': false,
//         'northnwd': {
//           'tables': {
//             'customers': {
//               'read': true,
//               'insert': true,
//               'update': true,
//               'delete': true,
//               'attribute_permissions': [],
//             },
//             'suppliers': {
//               'read': false,
//               'insert': false,
//               'update': false,
//               'delete': false,
//               'attribute_permissions': [],
//             },
//             'region': {
//               'read': true,
//               'insert': false,
//               'update': false,
//               'delete': false,
//               'attribute_permissions': [],
//             },
//             'territories': {
//               'read': true,
//               'insert': true,
//               'update': false,
//               'delete': false,
//               'attribute_permissions': [],
//             },
//             'categories': {
//               'read': true,
//               'insert': true,
//               'update': true,
//               'delete': false,
//               'attribute_permissions': [],
//             },
//             'shippers': {
//               'read': true,
//               'insert': true,
//               'update': true,
//               'delete': true,
//               'attribute_permissions': [],
//             },
//           }
//         },
//         'dev': {
//           'tables': {
//             'dog': {
//               'read': true,
//               'insert': true,
//               'update': true,
//               'delete': true,
//               'attribute_permissions': [{
//                 'attribute_name': '__createdtime__',
//                 'read': true,
//                 'insert': true,
//                 'update': true,
//               }, {
//                 'attribute_name': '__updatedtime__',
//                 'read': true,
//                 'insert': true,
//                 'update': true,
//               }],
//             },
//             'breed': {
//               'read': true,
//               'insert': true,
//               'update': true,
//               'delete': true,
//               'attribute_permissions': [{
//                 'attribute_name': '__createdtime__',
//                 'read': false,
//                 'insert': false,
//                 'update': true,
//               }, { 'attribute_name': '__updatedtime__', 'read': false, 'insert': true, 'update': true }],
//             },
//             'dog_conditions': {
//               'read': true,
//               'insert': true,
//               'update': false,
//               'delete': false,
//               'attribute_permissions': [{
//                 'attribute_name': 'id',
//                 'read': true,
//                 'insert': true,
//                 'update': false,
//               },],
//             },
//           }
//         }
//       },
//     })
//     .expect((r) => {
//       console.log(r.body);
//       console.log(r.status);
//       assert.ok(r.body.id == 'developer_test_11')
//       console.log(r.body.permission.dev.tables.dog_conditions.attribute_permissions[0].update);
//     })
//     .expect(200)
//
//   //Unmatched Postman assertion: responseData = JSON.parse(responseBody);
// //Unmatched Postman assertion: postman.setEnvironmentVariable("role_id", responseData.id)})
// });


// it('Test local studio HTML is returned', async () => {
//   const response = await request(envUrl)
//     .get('')
//     .set(headers)
//     .expect(200)
//     .expect('content-type', 'text/html; charset=UTF-8')
//     .expect((r) => {
//       assert.ok(r.text.includes('<!doctype html>'));
//       assert.ok(r.text.includes('Studio :: HarperDB'));
//     })
// });

// it('Get all System Information', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ "operation": "system_information" })
//     .expect((r) => {
//       let attributes = ['system', 'time', 'cpu', 'memory', 'disk', 'network', 'harperdb_processes', 'table_size'];
//       attributes.forEach((attribute) => {
//         console.log("\n\n" + attribute + '======' + JSON.stringify(r.body[attribute]));
//         assert.ok(r.body[attribute] != undefined);
//       })
//     })
//     .expect(200)
// });


// it('deploy custom function', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .send({
//       "operation": "deploy_custom_function_project",
//       "project": "test-deploy",
//       "bypass_config": true,
//       "payload": "LgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDc1NSAAMDAwNzY1IAAwMDAwMjQgADAwMDAwMDAwMDAwIDE0NDIwMDQ3MDc2IDAwNzMzNiAANQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB1c3RhcgAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwMDAwMDAgADAwMDAwMCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwYWNrYWdlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDAwNzU1IAAwMDA3NjUgADAwMDAyNCAAMDAwMDAwMDAwMDAgMTQ0MjAwNDcwNzYgMDEwNTc0IAA1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHVzdGFyADAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDAwMCAAMDAwMDAwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAgLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAACAAAAABAAAAQAAAAAEAAACAAAAAAQAAAQAAAAABAAACAAAAAAEAAAQAAAAAAAAAAAEAABAAAAAAAQAAIAAAAAABAABAAAAAAAEAAIAAAAAAAQABAAAAAAABAAIAAAAAAAEABAAAAAAAAQAIAAAAAAABABAAAAAAAAEAIAAAAAAAAQBAAAAAAAABAIAAAAAAAAEBAAAAAAAAAQIAAAAAAAABBAAAAAAAAAEIAAAAAAAAARAAAAAAAAABIAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAEAsAAABFAAACCQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBERTREIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAIAAAAGAAAAAAAAAAAQAAAIAAAAABAAABAAAAAAAAAAABAAAEAAAAAAIAAAgAAAAYAAAAAAAAAAABAAAgAAAAAAEAAEAAAAAAAQAAgAAAAAABAAEAAAAAAAEAAgAAAAAAAQAEAAAAAAABAAgAAAAAAAEAEAAAAAAAAQAgAAAAAAABAEAAAAAAAAEAgAAAAAAAAQEAAAAAAAABAgAAAAAAAAEEAAAAAAAAAQgAAAAAAAABEAAAAAAAAAEgAAAAAAAAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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aWxlcyAodGhlICJTb2Z0d2FyZSIpLCB0byBkZWFsCmluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMKdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbApjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMKZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczoKClRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluIGFsbApjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLgoKVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEICJBUyBJUyIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1IKSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksCkZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOIE5PIEVWRU5UIFNIQUxMIFRIRQpBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSCkxJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sCk9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFClNPRlRXQVJFLgoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwYWNrYWdlL1JFQURNRS5tZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDAwNjQ0IAAwMDA3NjUgADAwMDAyNCAAMDAwMDAwMDc2NDUgMTQ0MjAwNDcwNzYgMDEyMTQ2IAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHVzdGFyADAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDAwMCAAMDAwMDAwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACMgSGFycGVyREIgQ3VzdG9tIEZ1bmN0aW9ucyBUZW1wbGF0ZQoKIFRoaXMgcmVwbyBjb21wcmlzZXMgYSBzZXQgb2YgRmFzdGlmeSByb3V0ZXMsIGhlbHBlcnMsIGFuZCBzdGF0aWMgY29udGVudCB0byBiZSBsb2FkZWQgYnkgSGFycGVyREIncyBDdXN0b20gRnVuY3Rpb25zIEZhc3RpZnkgU2VydmVyLgoKVG8gZGVwbG95IHRoaXMgdGVtcGxhdGUsIHNpbXBseSBjbG9uZSB0aGlzIHJlcG8gaW50byB5b3VyIGBjdXN0b21fZnVuY3Rpb25zYCBmb2xkZXIuIEJ5IGRlZmF1bHQsIHRoaXMgZm9sZGVyIGlzIGxvY2F0ZWQgaW4geW91ciBIYXJwZXJEQiB1c2VyIGZvbGRlciBgKH4vaGRiKWAuCgoqKlJvdXRlcyBhcmUgYXV0b21hdGljYWxseSBwcmVmaXhlZCB3aXRoIHRoZWlyIHBhcmVudCBmb2xkZXIgbmFtZS4qKgoKIyMgUm91dGVzCgotLS0KCiMjIyBHRVQgLwoKTk8gcHJlVmFsaWRhdGlvbiBBTkQgVVNJTkcgaGRiQ29yZS5yZXF1ZXN0V2l0aG91dEF1dGhlbnRpY2F0aW9uCkJZUEFTU0VTIEFMTCBDSEVDS1M6IERPIE5PVCBVU0UgUkFXIFVTRVItU1VCTUlUVEVEIFZBTFVFUyBJTiBTUUwgU1RBVEVNRU5UUwoKYGBgCiAgc2VydmVyLnJvdXRlKHsKICAgIHVybDogJy8nLAogICAgbWV0aG9kOiAnR0VUJywKICAgIGhhbmRsZXI6IChyZXF1ZXN0KSA9PiB7CiAgICAgIHJlcXVlc3QuYm9keT0gewogICAgICAgIG9wZXJhdGlvbjogJ3NxbCcsCiAgICAgICAgc3FsOiAnU0VMRUNUICogRlJPTSBkZXYuZG9ncyBPUkRFUiBCWSBkb2dfbmFtZScKICAgICAgfTsKICAgICAgcmV0dXJuIGhkYkNvcmUucmVxdWVzdFdpdGhvdXRBdXRoZW50aWNhdGlvbihyZXF1ZXN0KTsKICAgIH0KICB9KQpgYGAKCiMjIyBQT1NUIC8KClNUQU5EQVJEIFBBU1MtVEhST1VHSCBCT0RZLCBQQVlMT0FEIEFORCBIREIgQVVUSEVOVElDQVRJT04KCmBgYApzZXJ2ZXIucm91dGUoewogICAgdXJsOiAnLycsCiAgICBtZXRob2Q6ICdQT1NUJywKICAgIHByZVZhbGlkYXRpb246IGhkYkNvcmUucHJlVmFsaWRhdGlvbiwKICAgIGhhbmRsZXI6IGhkYkNvcmUucmVxdWVzdCwKICB9KQpgYGAKCiMjIyBHRVQgLzppZAoKV0lUSCBBU1lOQyBUSElSRC1QQVJUWSBBVVRIIFBSRVZBTElEQVRJT04KCmBgYAogIHNlcnZlci5yb3V0ZSh7CiAgICB1cmw6ICcvOmlkJywKICAgIG1ldGhvZDogJ0dFVCcsCiAgICBwcmVWYWxpZGF0aW9uOiAocmVxdWVzdCkgPT4gY3VzdG9tVmFsaWRhdGlvbihyZXF1ZXN0LCBsb2dnZXIpLAogICAgaGFuZGxlcjogKHJlcXVlc3QpID0+IHsKICAgICAgcmVxdWVzdC5ib2R5PSB7CiAgICAgICAgb3BlcmF0aW9uOiAnc3FsJywKICAgICAgICBzcWw6IGBTRUxFQ1QgKiBGUk9NIGRldi5kb2cgV0hFUkUgaWQgPSAke3JlcXVlc3QucGFyYW1zLmlkfWAKICAgICAgfTsKCiAgICAgIC8qCiAgICAgICAqIHJlcXVlc3RXaXRob3V0QXV0aGVudGljYXRpb24gYnlwYXNzZXMgdGhlIHN0YW5kYXJkIEhhcnBlckRCIGF1dGhlbnRpY2F0aW9uLgogICAgICAgKiBZT1UgTVVTVCBBREQgWU9VUiBPV04gcHJlVmFsaWRhdGlvbiBtZXRob2QgYWJvdmUsIG9yIHRoaXMgbWV0aG9kIHdpbGwgYmUgYXZhaWxhYmxlIHRvIGFueW9uZS4KICAgICAgICovCiAgICAgIHJldHVybiBoZGJDb3JlLnJlcXVlc3RXaXRob3V0QXV0aGVudGljYXRpb24ocmVxdWVzdCk7CiAgICB9CiAgfSk7CmBgYAoKIyMgSGVscGVycwoKLS0tClRIRSBBU1lOQ1JPTk9VUyBUSElSRCBQQVJUWSBWQUxJREFUSU9OLCBGUk9NIGhlbHBlcnMvZXhhbXBsZS5qczoKCmBgYApjb25zdCBjdXN0b21WYWxpZGF0aW9uID0gYXN5bmMgKHJlcXVlc3QsbG9nZ2VyKSA9PiB7CiAgY29uc3Qgb3B0aW9ucyA9IHsKICAgIGhvc3RuYW1lOiAnanNvbnBsYWNlaG9sZGVyLnR5cGljb2RlLmNvbScsCiAgICBwb3J0OiA0NDMsCiAgICBwYXRoOiAnL3RvZG9zLzEnLAogICAgbWV0aG9kOiAnR0VUJywKICAgIGhlYWRlcnM6IHsgYXV0aG9yaXphdGlvbjogcmVxdWVzdC5oZWFkZXJzLmF1dGhvcml6YXRpb24gfSwKICB9OwoKICBjb25zdCByZXN1bHQgPSBhd2FpdCBhdXRoUmVxdWVzdChvcHRpb25zKTsKCiAgLyoKICAgKiAgdGhyb3cgYW4gYXV0aGVudGljYXRpb24gZXJyb3IgYmFzZWQgb24gdGhlIHJlc3BvbnNlIGJvZHkgb3Igc3RhdHVzQ29kZQogICAqLwogIGlmIChyZXN1bHQuZXJyb3IpIHsKICAgIGNvbnN0IGVycm9yU3RyaW5nID0gcmVzdWx0LmVycm9yIHx8ICdTb3JyeSwgdGhlcmUgd2FzIGFuIGVycm9yIGF1dGhlbnRpY2F0aW5nIHlvdXIgcmVxdWVzdCc7CiAgICBsb2dnZXIuZXJyb3IoZXJyb3JTdHJpbmcpOwogICAgdGhyb3cgbmV3IEVycm9yKGVycm9yU3RyaW5nKTsKICB9CiAgcmV0dXJuIHJlcXVlc3Q7Cn07Cgptb2R1bGUuZXhwb3J0cyA9IGN1c3RvbVZhbGlkYXRpb247CmBgYAoKVEhFIEFDVFVBTCBIVFRQIENBTEwgVVNFRCBJTiBhdXRoUmVxdWVzdCwgYWxzbyBpbiBoZWxwZXJzL2V4YW1wbGUuanM6CgpgYGAKY29uc3QgYXV0aFJlcXVlc3QgPSAob3B0aW9ucykgPT4gewogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICBjb25zdCByZXEgPSBodHRwcy5yZXF1ZXN0KG9wdGlvbnMsIChyZXMpID0+IHsKICAgICAgcmVzLnNldEVuY29kaW5nKCd1dGY4Jyk7CiAgICAgIGxldCByZXNwb25zZUJvZHkgPSAnJzsKCiAgICAgIHJlcy5vbignZGF0YScsIChjaHVuaykgPT4gewogICAgICAgIHJlc3BvbnNlQm9keSArPSBjaHVuazsKICAgICAgfSk7CgogICAgICByZXMub24oJ2VuZCcsICgpID0+IHsKICAgICAgICByZXNvbHZlKEpTT04ucGFyc2UocmVzcG9uc2VCb2R5KSk7CiAgICAgIH0pOwogICAgfSk7CgogICAgcmVxLm9uKCdlcnJvcicsIChlcnIpID0+IHsKICAgICAgcmVqZWN0KGVycik7CiAgICB9KTsKCiAgICByZXEuZW5kKCk7CiAgfSk7Cn07CmBgYAoKIyMgU3RhdGljIEZpbGVzIChXZWIgVUkpCgotLS0KCkJ5IGFkZGluZyBhIGAvc3RhdGljYCBmb2xkZXIgdG8geW91ciBwcm9qZWN0LCB5b3UgY2FuIGFsc28gaG9zdCBzdGF0aWMgZmlsZXMuIFlvdSBtaWdodCwgZm9yIGV4YW1wbGUsIGNyZWF0ZSBhIGRhc2hib2FyZCB0aGF0IGRpc3BsYXlzIHN1bW1hcnkgZGF0YSBiYXNlZCBvbiBzdGFuZGFyZCBIYXJwZXJEQiBvcGVyYXRpb25zIG9yIEN1c3RvbSBGdW5jdGlvbnMgdGhhdCBwdWxsIGRhdGEgZnJvbSBIYXJwZXJEQi4KCi0gKipZb3VyIHN0YXRpYyBmb2xkZXIgTVVTVCBjb250YWluIGFuIGBpbmRleC5odG1sYCBmaWxlKioKLSAqKllvdSBtdXN0IHVzZSBhYnNvbHV0ZSBwYXRocyBmb3IgYXNzZXRzIChzdGFydCB3aXRoIGEgc2xhc2gpKioKCi0tLQoKSU5ERVguSFRNTAoKYGBgCjwhZG9jdHlwZSBodG1sPgo8aHRtbCBsYW5nPSJlbiI+CjxoZWFkPgogIDxtZXRhIGNoYXJzZXQ9InV0Zi04IiAvPgogIDxsaW5rIHJlbD0iaWNvbiIgaHJlZj0iL3Jlc291cmNlcy9pbWcvZmF2aWNvbi5wbmciIC8+CiAgPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEiIC8+CiAgPHRpdGxlPkhh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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwYWNrYWdlL3JvdXRlcwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDAwNzU1IAAwMDA3NjUgADAwMDAyNCAAMDAwMDAwMDAwMDAgMTQ0MjAwNDcwNzYgMDEyMTE1IAA1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHVzdGFyADAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDAwMCAAMDAwMDAwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHBhY2thZ2Uvc3RhdGljAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwMDA3NTUgADAwMDc2NSAAMDAwMDI0IAAwMDAwMDAwMDAwMCAxNDQyMDA0NzA3NiAwMTIwNjMgADUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdXN0YXIAMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDAwMDAwIAAwMDAwMDAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcGFja2FnZS9oZWxwZXJzL2V4YW1wbGUuanMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDY0NCAAMDAwNzY1IAAwMDAwMjQgADAwMDAwMDAyMTI3IDE0NDIwMDQ3MDc2IDAxNDMxMCAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB1c3RhcgAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwMDAwMDAgADAwMDAwMCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAndXNlIHN0cmljdCc7Cgpjb25zdCBodHRwcyA9IHJlcXVpcmUoJ2h0dHBzJyk7Cgpjb25zdCBhdXRoUmVxdWVzdCA9IChvcHRpb25zKSA9PiB7CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsKICAgIGNvbnN0IHJlcSA9IGh0dHBzLnJlcXVlc3Qob3B0aW9ucywgKHJlcykgPT4gewogICAgICByZXMuc2V0RW5jb2RpbmcoJ3V0ZjgnKTsKICAgICAgbGV0IHJlc3BvbnNlQm9keSA9ICcnOwoKICAgICAgcmVzLm9uKCdkYXRhJywgKGNodW5rKSA9PiB7CiAgICAgICAgcmVzcG9uc2VCb2R5ICs9IGNodW5rOwogICAgICB9KTsKCiAgICAgIHJlcy5vbignZW5kJywgKCkgPT4gewogICAgICAgIHJlc29sdmUoSlNPTi5wYXJzZShyZXNwb25zZUJvZHkpKTsKICAgICAgfSk7CiAgICB9KTsKCiAgICByZXEub24oJ2Vycm9yJywgKGVycikgPT4gewogICAgICByZWplY3QoZXJyKTsKICAgIH0pOwoKICAgIHJlcS5lbmQoKTsKICB9KTsKfTsKCmNvbnN0IGN1c3RvbVZhbGlkYXRpb24gPSBhc3luYyAocmVxdWVzdCxsb2dnZXIpID0+IHsKICBjb25zdCBvcHRpb25zID0gewogICAgaG9zdG5hbWU6ICdqc29ucGxhY2Vob2xkZXIudHlwaWNvZGUuY29tJywKICAgIHBvcnQ6IDQ0MywKICAgIHBhdGg6ICcvdG9kb3MvMScsCiAgICBtZXRob2Q6ICdHRVQnLAogICAgaGVhZGVyczogeyBhdXRob3JpemF0aW9uOiByZXF1ZXN0LmhlYWRlcnMuYXV0aG9yaXphdGlvbiB9LAogIH07CgogIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGF1dGhSZXF1ZXN0KG9wdGlvbnMpOwoKICAvKgogICAqICB0aHJvdyBhbiBhdXRoZW50aWNhdGlvbiBlcnJvciBiYXNlZCBvbiB0aGUgcmVzcG9uc2UgYm9keSBvciBzdGF0dXND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CgogIC8vIFBPU1QsIFdJVEggU1RBTkRBUkQgUEFTUy1USFJPVUdIIEJPRFksIFBBWUxPQUQgQU5EIEhEQiBBVVRIRU5USUNBVElPTgogIHNlcnZlci5yb3V0ZSh7CiAgICB1cmw6ICcvJywKICAgIG1ldGhvZDogJ1BPU1QnLAogICAgcHJlVmFsaWRhdGlvbjogaGRiQ29yZS5wcmVWYWxpZGF0aW9uLAogICAgaGFuZGxlcjogaGRiQ29yZS5yZXF1ZXN0LAogIH0pOwoKICAvLyBHRVQsIFdJVEggQVNZTkMgVEhJUkQtUEFSVFkgQVVUSCBQUkVWQUxJREFUSU9OCiAgc2VydmVyLnJvdXRlKHsKICAgIHVybDogJy86aWQnLAogICAgbWV0aG9kOiAnR0VUJywKICAgIHByZVZhbGlkYXRpb246IChyZXF1ZXN0KSA9PiBjdXN0b21WYWxpZGF0aW9uKHJlcXVlc3QsIGxvZ2dlciksCiAgICBoYW5kbGVyOiAocmVxdWVzdCkgPT4gewogICAgICByZXF1ZXN0LmJvZHk9IHsKICAgICAgICBvcGVyYXRpb246ICdzcWwnLAogICAgICAgIHNxbDogYFNFTEVDVCAqIEZST00gZGV2LmRvZyBXSEVSRSBpZCA9ICR7cmVxdWVzdC5wYXJhbXMuaWR9YAogICAgICB9OwoKICAgICAgLyoKICAgICAgICogcmVxdWVzdFdpdGhvdXRBdXRoZW50aWNhdGlvbiBieXBhc3NlcyB0aGUgc3RhbmRhcmQgSGFycGVyREIgYXV0aGVudGljYXRpb24uCiAgICAgICAqIFlPVSBNVVNUIEFERCBZT1VSIE9XTiBwcmVWYWxpZGF0aW9uIG1ldGhvZCBhYm92ZSwgb3IgdGhpcyBtZXRob2Qgd2lsbCBiZSBhdmFpbGFibGUgdG8gYW55b25lLgogICAgICAgKi8KICAgICAgcmV0dXJuIGhkYkNvcmUucmVxdWVzdFdpdGhvdXRBdXRoZW50aWNhdGlvbihyZXF1ZXN0KTsKICAgIH0KICB9KTsKfTsKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
//     })
//     .expect(200)
//     .expect((r) => assert.ok(r.body.message == "Successfully deployed: test-deploy"))
//   await setTimeout(22000);
// });

// it('confirm deploy worked', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .send({ "operation": "get_custom_functions" })
//     .expect((r) => {
//       console.log(r.body);
//       assert.ok(r.body.hasOwnProperty('test-deploy'));
//       assert.ok(r.body["test-deploy"]["routes"] != undefined);
//       assert.ok(r.body["test-deploy"]["routes"][0] == 'examples');
//       assert.ok(r.body["test-deploy"]["helpers"] != undefined);
//       assert.ok(r.body["test-deploy"]["helpers"][0] == 'example');
//     })
//     .expect(200)
// });

// it('drop custom functions project deploy', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .send({ "operation": "drop_custom_function_project", "project": "test-deploy" })
//     .expect((r) => assert.ok(r.body.message == "Successfully deleted project: test-deploy"))
//     .expect(200)
// });


// it('search for generic', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ operation: 'sql', sql: `SELECT * FROM ${generic.schema}.${generic.supp_tb}` })
//     .expect((r) => {
//       assert.ok(r.body[0].name == "bau bau");
//       assert.ok(r.body[0].hasOwnProperty('name'))
//     })
//     .expect(200);
// });

// it('Create auth token with invalid credentials', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ "operation": "create_authentication_tokens", "username": `${generic.username}`, "password": "" })
//     .expect((r) => {
//       console.log(r.body);
//       console.log(JSON.stringify(r.body));
//       assert.ok(JSON.stringify(r.body).includes("invalid credentials"))
//     })
//     .expect(401)
// });

//
// it('Add component', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .send({ "operation": "add_component", "project": "myApp111" })
//     .expect((r) => {
//       console.log(r.body);
//       assert.ok(JSON.stringify(r.body).includes("Successfully added project") ||
//         JSON.stringify(r.body).includes("Project already exists"))
//     })
// });

// it('Drop component', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .send({ "operation": "drop_component", "project": "myApp111" })
//     .expect(200)
//     .expect((r) => {
//       console.log(r.body);
//       assert.ok(r.body.message.includes('Successfully dropped: myApp111'))
//     })
// });


// it('Confirm update record No where dev.cat', async () => {
//   const cats = ['Sophie', 'George', 'Bau', 'Willow', 'Bird', 'Murph', 'Simba', 'Gemma', 'Bobby'];
//   const ids = [19,2,3,4,5,6,7,8,1];
//
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ 'operation': 'sql', 'sql': 'SELECT cat_name, id FROM dev.cat' })
//     .expect((r) => {
//       let cats_found = [];
//       let ids_found = [];
//       r.body.forEach((obj) => {
//         // console.log(obj);
//         let cat_found = cats.filter((el) => obj.cat_name == el);
//         if(cat_found.length > 0) cats_found.push(cat_found);
//         let id_found = ids.filter((el) => obj.id == el);
//         if(id_found.length > 0) ids_found.push(id_found);
//       })
//       console.log(cats_found.length);
//       console.log(ids_found.length);
//       assert.ok(cats_found.length > 0);
//       assert.ok(ids_found.length > 0);
//     })
//     .expect(200)
// });

//
//
// it('Confirm update record No where dev.cat', async () => {
//   const cats = ['Sophie', 'George', 'Biggie Paws', 'Willow', 'Bird', 'Murph', 'Simba', 'Gemma', 'Bobby'];
//   const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9];
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ operation: 'sql', sql: 'SELECT cat_name, id FROM dev.cat' })
//     .expect((r) => assert.ok(r.body.length == 3))
//     .expect((r) => {
//       let cats_found = [];
//       let ids_found = [];
//       r.body.forEach((obj) => {
//         assert.ok(Object.keys(obj).length == 2);
//         let cat_found = cats.filter((el) => obj.cat_name == el);
//         if (cat_found.length > 0) cats_found.push(cat_found);
//         let id_found = ids.filter((el) => obj.id == el);
//         if (id_found.length > 0) ids_found.push(id_found);
//       });
//       assert.ok(cats_found.length > 0);
//       assert.ok(ids_found.length > 0);
//     })
//     .expect(200);
// });
//
//
// it('Confirm update record "where x != y" dev.cat', async () => {
//   const cats = ['Biggie Paws', 'Willow', 'Murph', 'Bau', 'Gemma'];
//   const ids = [3,4,6,7,1];
//
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ 'operation': 'sql', 'sql': 'SELECT cat_name, id FROM dev.cat' })
//     .expect((r) => assert.ok(r.body.length == 3))
//     .expect((r) => {
//       let cats_found = [];
//       let ids_found = [];
//       r.body.forEach((obj) => {
//         assert.ok(Object.keys(obj).length == 2);
//         // assert.ok(obj.adorable == false);
//
//         let cat_found = cats.filter((el) => obj.cat_name == el);
//         if(cat_found.length > 0) cats_found.push(cat_found);
//         let id_found = ids.filter((el) => obj.id == el);
//         if(id_found.length > 0) ids_found.push(id_found);
//       })
//       assert.ok(cats_found.length > 0);
//       assert.ok(ids_found.length > 0);
//     })
//     .expect(200)
// });


// it('NoSQL - Upsert - table perms true/attr perms true - expect success', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({
//       "operation": "insert",
//       "schema": "dev",
//       "table": "cat",
//       "records": [{ "id": 8, "name": "Seaweed" }]
//     })
//     .expect(200)
//     .expect((r) => assert.ok(r.body.message == "inserted 0 of 1 records"))
//     .expect((r) => assert.ok(r.body.skipped_hashes.includes(8)))
// });


// it('Get Configuration', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ "operation": "get_configuration" })
//     .expect(200)
//     // .expect((r) => assert.ok(r.body.clustering))
//     .expect((r) => assert.ok(r.body.componentsRoot))
//     .expect((r) => assert.ok(r.body.logging))
//     .expect((r) => assert.ok(r.body.localStudio))
//     .expect((r) => assert.ok(r.body.operationsApi))
//     .expect((r) => assert.ok(r.body.operationsApi.network.port))
//     .expect((r) => assert.ok(r.body.threads))
//
//   console.log(response.body.clustering);
// });


// it('assert not empty', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ 'operation': 'sql', 'sql': 'SELECT name, cat_name, id FROM dev.cat where id = 9' })
//     .expect((r) => {
//       console.log(r.body);
//       assert.ok(r.body[0].cat_name);
//     })
// })


// it('insert initial date function data into table', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({
//       'operation': 'sql',
//       'sql': 'INSERT INTO dev.time_functions (id, c_date, c_time, c_timestamp, getdate, now) VALUES (1, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (2, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (3, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW()), (4, CURRENT_DATE(), CURRENT_TIME(), CURRENT_TIMESTAMP, GETDATE(), NOW())',
//     })
//     .expect(200)
//     .expect((r) => assert.ok(r.body.message == 'inserted 4 of 4 records'))
//     .expect((r) => assert.ok(r.body.inserted_hashes[0] == 1))
// });
//


// it('check data updated to correct date values in table', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.time_functions' })
//     .expect(200)
//     // .expect((r) => assert.ok(r.body.length == 4))
//     // //Unmatched Postman assertion: var current_date = new Date().getUTCDate()
//     // //Unmatched Postman assertion: jsonData.forEach(row => {
//     // .expect((r) => assert.ok([1,2,3,4].includes(row.id)))
//     // .expect((r) => assert.ok(new Date(row.now).getUTCDate() == current_date))
//     // //Unmatched Postman assertion: pm.expect(row.now.toString().length == 13)
//     // .expect((r) => assert.ok(new Date(row.getdate).getUTCDate() == current_date))
//     //
//     // .expect((r) => assert.ok(row.getdate.toString().length == 13))
//     // .expect((r) => assert.ok(new Date(row.c_timestamp).getUTCDate() == current_date))
//     // .expect((r) => assert.ok(row.c_timestamp.toString().length == 13))
//     // .expect((r) => assert.ok(row.c_date.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/)))
//     // .expect((r) => assert.ok(row.c_time.match(/^[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/)))
//     .expect((r) => {
//       console.log(r.body[0].c_date.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/));
//       assert.ok(r.body[0].c_time.match(/^[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/));
//     })
// //
// });
//
// it('check data updated to correct date values in table', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.time_functions' })
//     .expect(200)
//     .expect((r) => {
//       assert.ok(r.body.length == 4);
//       let current_date = new Date().getUTCDate();
//       console.log('current date: ' + current_date);
//       r.body.forEach((row) => {
//         console.log('1 ' + row.id);
//         console.log('2 ' + new Date(row.now).getUTCDate());
//         console.log('3 ' + row.now.toString().length);
//         console.log('4 ' + new Date(row.getdate).getUTCDate());
//         console.log('5 ' + row.getdate.toString().length);
//         console.log('6 ' + new Date(row.c_timestamp).getUTCDate());
//         console.log('7 ' + row.c_timestamp.toString().length);
//         console.log('8 ' + row.c_date.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/));
//         console.log('9 ' + row.c_time.match(/^[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/));
//         console.log('\n\n\n');
//       })
//     })
// });
//
// it('check data updated to correct date values in table', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ 'operation': 'sql', 'sql': 'SELECT * FROM dev.time_functions' })
//     .expect(200)
//     .expect((r) => {
//       assert.ok(r.body.length == 4);
//       let current_date = new Date().getUTCDate();
//       r.body.forEach((row) => {
//         assert.ok([1,2,3,4].includes(row.id));
//         assert.ok(new Date(row.now).getUTCDate() == current_date);
//         assert.ok(row.now.toString().length == 13);
//         assert.ok(new Date(row.getdate).getUTCDate() == current_date);
//         assert.ok(row.getdate.toString().length == 13);
//         assert.ok(new Date(row.c_timestamp).getUTCDate() == current_date);
//         assert.ok(row.c_timestamp.toString().length == 13);
//         assert.ok(row.c_date.match(/\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/));
//         assert.ok(row.c_time.match(/^[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}.\d{3}$/));
//       })
//     })
// });


// it('Fetch user transactions', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({
//     "operation":"search_by_value",
//     "schema":"dev",
//     "table":"cat",
//     "hash_attribute": "id",
//     "search_attribute":"cat_name",
//     "get_attributes": ["cat_name"],
//     "search_value": `${generic.username}`
//     })
//     .expect((r) => {
//       // console.log(r.body);
//       console.log(r.body[0][generic.username]);
//       console.log(r.body[0][`${generic.username}`]);
//       // assert.ok(r.body[generic.username]);
//     })
//   await setTimeout(100);
// });

// it('Get Registration Info', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ "operation": "registration_info" })
//     .expect(200)
//     .expect((r) => assert.ok(r.body.hasOwnProperty('registered')))
//     .expect((r) => assert.ok(r.body.hasOwnProperty('version')))
//     .expect((r) => assert.ok(r.body.hasOwnProperty('ram_allocation')))
//     .expect((r) => assert.ok(r.body.hasOwnProperty('license_expiration_date')))
// });

// it('Verify object and array records deleted', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({
//       "operation": "search_by_hash",
//       "schema": "dev",
//       "table": "cat",
//       "hash_values": [100],
//       "get_attributes": ["cat_name"]
//     })
//     .expect(200)
//     .expect((r) => {
//       console.log(r.body);
//       assert.deepEqual(r.body, []);
//     })
// });

//
// it('test1', async () => {
//   const response = await request(envUrl)
//     .post('')
//     .set(headers)
//     .send({ "operation": "sql", "sql": "select count(*) from dev.cat" })
//     .expect(200)
//     .expect((r) => {
//       console.log(r.body);
//       console.log('genericJobId: ' + generic.job_id);
//       generic.job_id = 1;
//       console.log('genericJobId: ' + generic.job_id);
//     })
// });

it('test2', async () => {
  console.log('\n');
  console.log(headers.Authorization);
  const response = await request(envUrl)
    .post('')
    .set(headers)
    .send({ "operation": "sql", "sql": "select count(*) from dev.cat" })
    .expect((r) => {
      // console.log(r.text);
      // console.log(r.body);
      assert.ok(r.text.includes('6'));
      // console.log('genericJobId: ' + generic.job_id);
      // generic.job_id = 2;
      // console.log('genericJobId: ' + generic.job_id);
    })
    .expect(200)
});

it('Describe all with invalid password', async () => {
  const response = await request(envUrl)
    .post('')
    .set({
      Authorization: 'Basic ' + Buffer.from(generic.username + ':' + 'admin').toString('base64'),
      'Content-Type': 'application/json'
    })
    .send({ "operation": "describe_all" })
    .expect((r) => {
      // console.log('@@@@@: ' + JSON.stringify(r));
      console.log(JSON.parse(JSON.stringify(r)).req.headers.authorization);
      // console.log(r.text);
      // console.log(r.body);
      assert.ok(JSON.stringify(r.body) == r.text);
      assert.ok(!r.text.includes('Login failed'))
    })
    .expect(200)
    console.log('&&&&&: ' + JSON.stringify(response.body.northnwd.categories.schema));
    console.log('*****: ' + response.body.northnwd.categories.schema);
    // .expect(401)
});

it('Describe all with invalid username', async () => {
  const response = await request(envUrl)
    .post('')
    .set({
      'Authorization': 'Basic ' + Buffer.from('thisIsNotMyUsername' + ':' + generic.password).toString('base64'),
      'Content-Type': 'application/json',
    })
    .send({ operation: 'describe_all' })
    .expect((r) => { assert.ok(r.text.includes('Login failed')) })
    .expect(401);
});
