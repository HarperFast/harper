#!/usr/bin/env node

import { execSync, exec } from 'node:child_process';
import fs from 'node:fs';

/* This script should be deleted someday. It is for syncing commits from the
 * old HarperDB closed-source repository while the Harper devs were
 * transitioning the platform to open source. See CONTRIBUTING.md for more
 * details. - WSM 2026-01-20
 */

function letsBail(exitCode: number, syncBranch: string | null = null): void {
	execSync('git checkout main', { stdio: 'ignore' });
	if (syncBranch) {
		execSync(`git branch -D ${syncBranch}`, { stdio: 'ignore' });
	}
	process.exit(exitCode);
}

function gitRemotes(): Record<string, Record<string, string>> {
	let remotesList = execSync('git remote -v')
		.toString()
		.trim()
		.split('\n')
		.map((r) => r.split('\t'));
	let remotes: Record<string, Record<string, string>> = {};
	remotesList.forEach(([name, urlAndType]) => {
		if (remotes[name] == null) {
			remotes[name] = {};
		}
		let [url, type] = urlAndType.split(' ');
		type = type.replace('(', '').replace(')', '');
		remotes[name][type] = url;
	});
	return remotes;
}

function verifyRemote(remoteName: string, remoteUrl: string): boolean {
	let remotes = gitRemotes();
	if (!Object.hasOwn(remotes, remoteName)) {
		return false;
	}
	if (!(Object.hasOwn(remotes[remoteName], 'fetch') && Object.hasOwn(remotes[remoteName], 'push'))) {
		return false;
	}
	return remotes[remoteName]['fetch'] === remoteUrl && remotes[remoteName]['push'] === remoteUrl;
}

function isOldRemoteConfigured(): boolean {
	return verifyRemote('old', 'git@github.com:HarperFast/harperdb.git');
}

function isOriginRemoteConfigured(): boolean {
	return verifyRemote('origin', 'git@github.com:HarperFast/harper.git');
}

function isBranchCheckedOut(branchName: string): boolean {
	let branch = execSync(`git branch --show-current`).toString().trim();
	return branch === branchName;
}

function fetchCommits(remoteName: string): void {
	exec(`git fetch ${remoteName}`, (error, _stdout, _stderr) => {
		// Note that git outputs all kinds of non-errors on stderr, so we don't
		// want to assume something went wrong if there's anything written there.
		if (error) {
			console.error(`git exited with error '${error.message}' fetching ${remoteName} commits`);
			letsBail(error.code as number);
		}
	});
}

function pullRemoteBranch(remoteName: string, branchName: string): void {
	fetchCommits(remoteName);
	exec(`git merge ${remoteName}/${branchName}`, (error, _stdout, stderr) => {
		if (error) {
			console.error(`git exited with error '${error.message}' merging origin/main`);
			letsBail(error.code as number);
		}
		if (stderr) {
			console.error(`git error merging origin/main: ${stderr}`);
			letsBail(6);
		}
	});
}

function checkoutNewBranch(branchName: string): void {
	exec(`git checkout -b ${branchName}`, (error, _stdout, stderr) => {
		if (error) {
			console.error(`git exited with error '${error.message}' creating branch ${branchName}`);
			letsBail(error.code as number, branchName);
		}
		if (stderr && !stderr.startsWith('Switched to a new branch')) {
			console.error(`git error creating branch ${branchName}: ${stderr}`);
			letsBail(7, branchName);
		}
	});
}

function ensureValidConfig(): void {
	process.stdout.write('Verifying git config... ');
	if (!isOldRemoteConfigured()) {
		process.stdout.write('❌');
		console.error('old remote not configured correctly.');
		console.error(
			'Run `git remote add old git@github.com:HarperFast/harperdb.git` to configure it (you may have to remove the old remote first with `git remote rm old`).'
		);
		process.exit(2);
	}
	if (!isOriginRemoteConfigured()) {
		console.log('❌');
		console.error('origin remote not configured correctly.');
		console.error(
			'Run `git remote add origin git@github.com:HarperFast/harper.git` to configure it (you may have to remove the origin remote first with `git remote rm origin`).'
		);
		process.exit(3);
	}
	if (!isBranchCheckedOut('main')) {
		console.log('❌');
		console.error('main branch not checked out. Run `git checkout main` to check it out.');
		process.exit(4);
	}
	console.log('✅');
}

function generateCommitsToPick(startCommit: string): string[] {
	const commits = execSync(`git rev-list --reverse --first-parent ${startCommit}..old/main`)
		.toString()
		.trim()
		.split('\n')
		.filter((c) => c !== '');
	if (commits.length > 0) {
		// write to file in case a human needs to take over
		fs.writeFileSync('commits-to-pick.txt', commits.join('\n') + '\n');
	}
	return commits;
}

function isMergeCommit(commit: string): boolean {
	try {
		execSync(`git rev-parse ${commit}^2`, { stdio: 'ignore' });
	} catch {
		return false;
	}
	return true;
}

function createSyncBranch(): void {
	const syncDate = new Date();
	const month = String(syncDate.getMonth() + 1).padStart(2, '0');
	const day = String(syncDate.getDate()).padStart(2, '0');
	checkoutNewBranch(`sync-${month}${day}${syncDate.getFullYear()}`);
}

function doItRockapella(startCommit: string): void {
	process.stdout.write('Finding commits to sync... ');
	fetchCommits('old');
	pullRemoteBranch('origin', 'main');
	const commits = generateCommitsToPick(startCommit);
	console.log('✅');
	if (commits.length === 0) {
		console.log('No commits to sync. Exiting.');
		letsBail(0);
	}
	createSyncBranch();
	console.log(`\n${commits.length} commits found:`);
	for (const commit of commits) {
		if (isMergeCommit(commit)) {
			console.log(`${commit} (merge): git cherry-pick -m 1 ${commit}`);
		} else {
			console.log(`${commit}: git cherry-pick ${commit}`);
		}
	}
}

function run(startCommit: string): void {
	if (!startCommit) {
		console.error(`No start commit specified. Specify a commit hash or tag: sync-commits.js <commit hash or tag>`);
		letsBail(1);
	}
	ensureValidConfig();
	doItRockapella(startCommit);
}

run(process.argv[2]);
