'use strict';

const CERTIFICATE_PEM_NAME = 'certificate.pem';
const PRIVATEKEY_PEM_NAME = 'privateKey.pem';
const CA_PEM_NAME = 'caCertificate.pem';

const CERT_NAME = {
	'DEFAULT': 'default',
	'DEFAULT-CA': 'default-ca',
	'SERVER': 'server',
	'CA': 'ca',
	'OPERATIONS-API': 'operations-api',
	'OPERATIONS-CA': 'operations-ca',
};

const CERT_CONFIG_NAME_MAP = {
	tls_certificate: CERT_NAME.SERVER,
	tls_certificateAuthority: CERT_NAME.CA,
	operationsApi_tls_certificate: CERT_NAME['OPERATIONS-API'],
	operationsApi_tls_certificateAuthority: CERT_NAME['OPERATIONS-CA'],
};

const CERT_PREFERENCE_APP = {
	[CERT_NAME.SERVER]: 2,
	[CERT_NAME.DEFAULT]: 1,
};

const CERT_PREFERENCE_OPS = {
	[CERT_NAME['OPERATIONS-API']]: 3,
	[CERT_NAME.SERVER]: 2,
	[CERT_NAME.DEFAULT]: 1,
};

const CERT_PREFERENCE_REP = {
	[CERT_NAME['OPERATIONS-API']]: 3,
	[CERT_NAME.SERVER]: 2,
	[CERT_NAME.DEFAULT]: 1,
};

const CA_CERT_PREFERENCE_OPS = {
	[CERT_NAME['OPERATIONS-CA']]: 3,
	[CERT_NAME.CA]: 2,
	[CERT_NAME['DEFAULT-CA']]: 1,
};

const CA_CERT_PREFERENCE_APP = {
	[CERT_NAME.CA]: 2,
	[CERT_NAME['DEFAULT-CA']]: 1,
};

module.exports = {
	CERTIFICATE_PEM_NAME,
	PRIVATEKEY_PEM_NAME,
	CA_PEM_NAME,
	CERT_NAME,
	CERT_CONFIG_NAME_MAP,
	CERT_PREFERENCE_APP,
	CERT_PREFERENCE_OPS,
	CERT_PREFERENCE_REP,
	CA_CERT_PREFERENCE_OPS,
	CA_CERT_PREFERENCE_APP,
};
