'use strict';

const { requireAwsSdk } = require('./awsSdkLoader.js');

let s3Sdk;

function loadClientS3() {
	if (!s3Sdk) s3Sdk = requireAwsSdk('@aws-sdk/client-s3');
	return s3Sdk;
}

module.exports = {
	getFileStreamFromS3,
	getS3AuthObj,
};

async function getFileStreamFromS3(jsonMessage) {
	const { s3 } = jsonMessage;
	const params = {
		Bucket: s3.bucket,
		Key: s3.key,
	};
	const authenticatedS3 = getS3AuthObj(s3.aws_access_key_id, s3.aws_secret_access_key, s3.region);
	const { GetObjectCommand } = loadClientS3();
	const item = await authenticatedS3.send(new GetObjectCommand(params));
	return item.Body;
}

function getS3AuthObj(accessKeyId, secretKey, region) {
	const { S3 } = loadClientS3();
	return new S3({
		credentials: {
			accessKeyId,
			secretAccessKey: secretKey,
		},
		region,
	});
}
