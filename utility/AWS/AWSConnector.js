'use strict';

// `@aws-sdk/client-s3` is an optional peerDependency (see package.json) so
// installs that never export/import S3 don't pay its ~18MB footprint.
// Required lazily and cached here on first use.
let s3Sdk;

function loadClientS3() {
	if (!s3Sdk) {
		try {
			s3Sdk = require('@aws-sdk/client-s3');
		} catch (err) {
			if (err && err.code === 'MODULE_NOT_FOUND' && /@aws-sdk\/client-s3/.test(String(err.message))) {
				throw new Error(
					'S3 export/import requires the optional AWS SDK — npm install @aws-sdk/client-s3 @aws-sdk/lib-storage'
				);
			}
			throw err;
		}
	}
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
