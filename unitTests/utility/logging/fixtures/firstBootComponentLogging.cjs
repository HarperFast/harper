'use strict';

// Simulates a first-boot install+run process (e.g. `harper run` on a fresh root, where
// bin/run.ts imports security/keys.ts before harperdb-config.yaml exists, installer.ts writes
// harperdb-config.yaml and calls initLogSettings(true), and keys.ts subsequently logs through
// the `forComponent('tls').conditional` reference it captured at module load).

const fs = require('fs-extra');
const path = require('node:path');
const hdbTerms = require('#src/utility/hdbTerms');
const harperLogger = require('#src/utility/logging/harper_logger');
const keys = require('#src/security/keys');

const rootPath = process.env.ROOTPATH;
const logRoot = path.join(rootPath, 'log');
fs.mkdirpSync(logRoot);
fs.writeFileSync(
	path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE),
	[
		`rootPath: ${JSON.stringify(rootPath)}`,
		'logging:',
		'  file: true',
		'  stdStreams: false',
		'  level: info',
		`  root: ${JSON.stringify(logRoot)}`,
		'',
	].join('\n')
);

harperLogger.initLogSettings(true);

keys.certExtensions();
keys.resolveEffectiveTlsCiphers(
	[
		{ source: 'tls', config: { ciphers: 'ECDHE-RSA-AES128-GCM-SHA256' } },
		{ source: 'ca', config: { ciphers: 'DEFAULT@SECLEVEL=1' } },
	],
	[],
	'https',
	false
);
