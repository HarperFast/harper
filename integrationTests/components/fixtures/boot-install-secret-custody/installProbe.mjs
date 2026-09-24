// Run as an application's `install.command`: records what the install spawn received from Harper's
// secret consumers — the SSH identity materialized behind GIT_SSH_COMMAND, and the transient .npmrc.
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
