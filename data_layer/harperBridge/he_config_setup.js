// const MOCK_SCHEMA = () => ({
//     "id": "545150f9-2869-4ee8-bd8d-82756a6ee0bb",
//     "name": "person",
//     "hash_attribute": "id",
//     "schema": "dev",
//     "attributes": [
//         {
//             "attribute": "firstname"
//         },
//         {
//             "attribute": "lastname"
//         },
//         {
//             "attribute": "age"
//         },
//         {
//             "attribute": "id"
//         }
//     ]
// });
//
// module.exports = MOCK_SCHEMA();

// const MOCK_SCHEMA = () => ({
//     "dev": {
//         "person": {
//             "id": "545150f9-2869-4ee8-bd8d-82756a6ee0bb",
//             "name": "person",
//             "hash_attribute": "id",
//             "schema": "dev",
//             "attributes": [
//                 {
//                     "attribute": "firstname"
//                 },
//                 {
//                     "attribute": "lastname"
//                 },
//                 {
//                     "attribute": "age"
//                 },
//                 {
//                     "attribute": "id"
//                 }
//             ]
//         }
//     },
//     "system": {
//         "hdb_table": {
//             "hash_attribute": "id",
//             "name": "hdb_table",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ],
//             "attributes": [
//                 {
//                     "attribute": "id"
//                 },
//                 {
//                     "attribute": "name"
//                 },
//                 {
//                     "attribute": "hash_attribute"
//                 },
//                 {
//                     "attribute": "schema"
//                 },
//                 {
//                     "attribute": "residence"
//                 }
//             ]
//         },
//         "hdb_attribute": {
//             "hash_attribute": "id",
//             "name": "hdb_attribute",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ],
//             "attributes": [
//                 {
//                     "attribute": "id"
//                 },
//                 {
//                     "attribute": "schema"
//                 },
//                 {
//                     "attribute": "table"
//                 },
//                 {
//                     "attribute": "attribute"
//                 },
//                 {
//                     "attribute": "schema_table"
//                 }
//             ]
//         },
//         "hdb_schema": {
//             "hash_attribute": "name",
//             "name": "hdb_schema",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ],
//             "attributes": [
//                 {
//                     "attribute": "name"
//                 },
//                 {
//                     "attribute": "createddate"
//                 }
//             ]
//         },
//         "hdb_user": {
//             "hash_attribute": "username",
//             "name": "hdb_user",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ],
//             "attributes": [
//                 {
//                     "attribute": "username"
//                 },
//                 {
//                     "attribute": "password"
//                 },
//                 {
//                     "attribute": "role"
//                 },
//                 {
//                     "attribute": "active"
//                 },
//                 {
//                     "attribute": "hash"
//                 }
//             ]
//         },
//         "hdb_role": {
//             "hash_attribute": "id",
//             "name": "hdb_role",
//             "schema": "system",
//             "attributes": [
//                 {
//                     "attribute": "id"
//                 },
//                 {
//                     "attribute": "role"
//                 },
//                 {
//                     "attribute": "permission"
//                 }
//             ],
//             "residence": [
//                 "*"
//             ]
//         },
//         "hdb_job": {
//             "hash_attribute": "id",
//             "name": "hdb_job",
//             "schema": "system",
//             "attributes": [
//                 {
//                     "attribute": "id"
//                 },
//                 {
//                     "attribute": "user"
//                 },
//                 {
//                     "attribute": "type"
//                 },
//                 {
//                     "attribute": "status"
//                 },
//                 {
//                     "attribute": "start_datetime"
//                 },
//                 {
//                     "attribute": "end_datetime"
//                 },
//                 {
//                     "attribute": "job_body"
//                 },
//                 {
//                     "attribute": "message"
//                 },
//                 {
//                     "attribute": "created_datetime"
//                 }
//             ]
//         },
//         "hdb_license": {
//             "hash_attribute": "license_key",
//             "name": "hdb_license",
//             "schema": "system",
//             "attributes": [
//                 {
//                     "attribute": "license_key"
//                 },
//                 {
//                     "attribute": "company"
//                 }
//             ]
//         },
//         "hdb_info": {
//             "hash_attribute": "info_id",
//             "name": "hdb_info",
//             "schema": "system",
//             "attributes": [
//                 {
//                     "attribute": "info_id"
//                 },
//                 {
//                     "attribute": "data_version_num"
//                 },
//                 {
//                     "attribute": "hdb_version_num"
//                 }
//             ]
//         },
//         "hdb_nodes": {
//             "hash_attribute": "name",
//             "name": "hdb_nodes",
//             "schema": "system",
//             "attributes": [
//                 {
//                     "attribute": "name"
//                 },
//                 {
//                     "attribute": "host"
//                 },
//                 {
//                     "attribute": "operation"
//                 },
//                 {
//                     "attribute": "port"
//                 },
//                 {
//                     "attribute": "subscriptions"
//                 }
//             ]
//         }
//     }
// });

// const heUtils = require('../../utility/helium/heliumUtils');
//
// const DATA_STORES = ['dev/dog/age', 'dev/dog/breed', 'dev/dog/id', 'dev/dog/name'];
// const MULTIPLE_ROWS = [
//     ["1", ["211", "Pug", "1", "Sam"]],
//     ["2", ["25", "Puggggs", "2", "Kyle"]],
//     ["3", ["", "", "3", "Zach"]],
//     ["4", [null, null, "4", "Aron"]]
// ];
//
// try {
//     const hdb_helium = heUtils.initializeHelium();
//     hdb_helium.createDataStores(DATA_STORES);
//     hdb_helium.insertRows(DATA_STORES, MULTIPLE_ROWS);
//
//     heUtils.terminateHelium(hdb_helium);
// } catch(e) {
//     console.log(e);
// }