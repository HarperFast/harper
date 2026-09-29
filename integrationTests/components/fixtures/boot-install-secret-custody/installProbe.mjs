// Runs as the application's `install.command`, recording the credential inputs the install spawn received.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , outputPath, keyFileName] = process.argv;
const readIfPresent = (path) => {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
};
const sshConfigDirectory = /-F (\S+)[\\/]config\b/.exec(process.env.GIT_SSH_COMMAND ?? '')?.[1];

writeFileSync(
	outputPath,
	JSON.stringify({
		sshKey: sshConfigDirectory ? readIfPresent(join(sshConfigDirectory, keyFileName)) : null,
		npmrc: process.env.npm_config_userconfig ? readIfPresent(process.env.npm_config_userconfig) : null,
	})
);
