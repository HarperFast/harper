#!/usr/bin/env node

const { execSync, exec } = require('node:child_process');
const fs = require('node:fs');

/* This script should be deleted someday. It is for syncing commits from the
 * old HarperDB closed-source repository while the Harper devs were
 * transitioning the platform to open source. See CONTRIBUTING.md for more
 * details. - WSM 2026-01-20
 */

function letsBail(exitCode, syncBranch = null) {
	execSync('git checkout main', { stdio: 'ignore' });
	if (syncBranch) {
		execSync(`git branch -D ${syncBranch}`, { stdio: 'ignore' });
	}
	process.exit(exitCode);
}

function gitRemotes() {
	let remotesList = execSync('git remote -v')
		.toString()
		.trim()
		.split('\n')
		.map((r) => r.split('\t'));
	let remotes = {};
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

function verifyRemote(remoteName, remoteUrl) {
	let remotes = gitRemotes();
	if (!Object.hasOwn(remotes, remoteName)) {
		return false;
	}
	if (!(Object.hasOwn(remotes[remoteName], 'fetch') && Object.hasOwn(remotes[remoteName], 'push'))) {
		return false;
	}
	return remotes[remoteName]['fetch'] === remoteUrl && remotes[remoteName]['push'] === remoteUrl;
}

function isOldRemoteConfigured() {
	return verifyRemote('old', 'git@github.com:HarperFast/harperdb.git');
}

function isOriginRemoteConfigured() {
	return verifyRemote('origin', 'git@github.com:HarperFast/harper.git');
}

function isBranchCheckedOut(branchName) {
	let branch = execSync(`git branch --show-current`).toString().trim();
	return branch === branchName;
}

function fetchCommits(remoteName) {
	exec(`git fetch ${remoteName}`, (error, _stdout, _stderr) => {
		// Note that git outputs all kinds of non-errors on stderr, so we don't
		// want to assume something went wrong if there's anything written there.
		if (error) {
			console.error(`git exited with error '${error.message}' fetching ${remoteName} commits`);
			letsBail(error.code);
		}
	});
}

function pullRemoteBranch(remoteName, branchName) {
	fetchCommits(remoteName);
	exec(`git merge ${remoteName}/${branchName}`, (error, _stdout, stderr) => {
		if (error) {
			console.error(`git exited with error '${error.message}' merging origin/main`);
			letsBail(error.code);
		}
		if (stderr) {
			console.error(`git error merging origin/main: ${stderr}`);
			letsBail(6);
		}
	});
}

function checkoutNewBranch(branchName) {
	exec(`git checkout -b ${branchName}`, (error, _stdout, stderr) => {
		if (error) {
			console.error(`git exited with error '${error.message}' creating branch ${branchName}`);
			letsBail(error.code, branchName);
		}
		if (stderr && !stderr.startsWith('Switched to a new branch')) {
			console.error(`git error creating branch ${branchName}: ${stderr}`);
			letsBail(7, branchName);
		}
	});
}

function ensureValidConfig() {
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

function generateCommitsToPick(startCommit) {
	const commits = execSync(`git rev-list --reverse --first-parent ${startCommit}..old/main`)
		.toString()
		.trim()
		.split('\n');
	// write to file in case a human needs to take over
	fs.writeFileSync('commits-to-pick.txt', commits.join('\n') + '\n');
	return commits;
}

function isMergeCommit(commit) {
	try {
		execSync(`git rev-parse ${commit}^2`, { stdio: 'ignore' });
	} catch {
		return false;
	}
	return true;
}

function doItRockapella(startCommit) {
	process.stdout.write('Finding commits to sync... ');
	fetchCommits('old');
	pullRemoteBranch('origin', 'main');
	const syncDate = new Date();
	const month = String(syncDate.getMonth() + 1).padStart(2, '0');
	const day = String(syncDate.getDate()).padStart(2, '0');
	checkoutNewBranch(`sync-${month}${day}${syncDate.getFullYear()}`);
	const commits = generateCommitsToPick(startCommit);
	console.log('✅');
	console.log(`\n${commits.length} commits found:`);
	for (const commit of commits) {
		if (isMergeCommit(commit)) {
			console.log(`${commit} (merge): git cherry-pick -m 1 ${commit}`);
		} else {
			console.log(`${commit}: git cherry-pick ${commit}`);
		}
	}
}

function run(startCommit) {
	if (!startCommit) {
		console.error(`No start commit specified. Specify a commit hash or tag: sync-commits.js <commit hash or tag>`);
		letsBail(1);
	}
	ensureValidConfig();
	doItRockapella(startCommit);
}

run(process.argv[2]);
