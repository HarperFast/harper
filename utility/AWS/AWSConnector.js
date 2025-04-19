'use strict';

const { S3, GetObjectCommand } = require('@aws-sdk/client-s3');

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
	const item = await authenticatedS3.send(new GetObjectCommand(params));
	return item.Body;
}

function getS3AuthObj(accessKeyId, secretKey, region) {
	return new S3({
		credentials: {
			accessKeyId,
			secretAccessKey: secretKey,
		},
		region,
	});
}
