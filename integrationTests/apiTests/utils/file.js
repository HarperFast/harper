import fs from 'fs-extra';
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

export async function verifyFilesDoNotExist(folderPath) {
	if (process.env.DOCKER_CONTAINER_ID) {
		await exec(
			`docker exec ${process.env.DOCKER_CONTAINER_ID} ls -al /home/harperdb/hdb/blobs/blob/0/0/`,
			(error, stdout, stderr) => {
				if (stderr.length > 0){
					assert.ok(stderr.includes(`cannot access '/home/harperdb/hdb/blobs/blob/0/0/': No such file or directory`), 'Docker container - .../blobs/blob/0/0/ folder should not exist');
				} else {
					const outputLineItems = stdout.split('..');
					assert.equal(outputLineItems.length, 2);
					assert.ok(outputLineItems[1].length <= 1);
				}
			}
		);
		await setTimeout(9000);
	} else {
		let files;
		try {
			files = await fs.readdir(folderPath);
		} catch (err) {
			assert.ok(err.toString().includes(`no such file or directory, scandir '${folderPath}'`));
			console.log('Checked: folder does not exist');
		}
		if (files !== undefined) {
			assert.equal(files.length, 0);
			console.log('Checked: files do not exist');
		}
	}
}
