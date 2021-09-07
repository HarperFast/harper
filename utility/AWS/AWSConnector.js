'use strict';

const S3 = require('aws-sdk/clients/s3');

module.exports = {
	getFileStreamFromS3,
	getS3AuthObj,
};

function getFileStreamFromS3(json_message) {
	const { s3 } = json_message;
	const params = {
		Bucket: s3.bucket,
		Key: s3.key,
	};
	const authenticatedS3 = getS3AuthObj(s3.aws_access_key_id, s3.aws_secret_access_key);
	return authenticatedS3.getObject(params).createReadStream();
}

function getS3AuthObj(access_key_id, secret_key) {
	return new S3({
		accessKeyId: access_key_id,
		secretAccessKey: secret_key,
	});
}
