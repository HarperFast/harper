import fs from 'fs-extra';
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

export async function verifyFilesDoNotExist(folderPath) {
	if (process.env.DOCKER_CONTAINER_ID) {
		await exec(
			`docker exec ${process.env.DOCKER_CONTAINER_ID} ls -al /home/harperdb/hdb/blobs/blob/0/0/`,
			(error, stdout, stderr) => {
				console.log('\n\n\nstdout: ' + stdout);
				console.log('error: ' + error);
				console.log('stderr: ' + stderr);
				console.log('\n\n\nKNOWN BUG: https://harperdb.atlassian.net/browse/CORE-2739\n\n\n');
				// assert.ok(stderr.includes(`cannot access '/home/harperdb/hdb/blobs/blob/0/0/': No such file or directory`), 'Docker container - .../blobs/blob/0/0/ folder should not exist');
			}
		);
		await setTimeout(9000);
	} else {
		let files;
		try {
			files = await fs.readdir(folderPath);
		} catch (err) {
			console.log(err.toString());
			assert.ok(err.toString().includes(`no such file or directory, scandir '${folderPath}'`));
		}
		if (files !== undefined) {
			console.log('\n\n\nNumber of files found should be 0, but instead there were: ' + files.length);
			console.log('\n\n\nKNOWN BUG: https://harperdb.atlassian.net/browse/CORE-2739\n\n\n');
			assert.equal(files.length, 0);
			console.log('Checked files do not exist');
		}
	}
}
