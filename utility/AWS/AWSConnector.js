"use strict";

const AWS = require("aws-sdk");
const { handleHDBError, hdb_errors } = require('../errors/hdbError');

module.exports = {
    getFileFromS3
};

async function getFileFromS3(json_message) {
    const { s3 } = json_message;
    const params = {
        Bucket: s3.bucket,
        Key: s3.key
    };
    const authenticatedS3 = getS3AuthObj(s3.aws_access_key_id, s3.aws_secret_access_key);
    try {
        return await authenticatedS3.getObject(params).promise();
    } catch(err) {
        //TODO - update this error handling to be more specific!
        throw handleHDBError(err);
    }
}

function getS3AuthObj(access_key_id, secret_key) {
    AWS.config.update({
        accessKeyId: access_key_id,
        secretAccessKey: secret_key
    });

    return new AWS.S3();
}
