# Contributing to Harper

> [!NOTE]
> Harper open source core is still under active development.
>
> The source code in this repository was extracted directly from our old, closed-source codebase.
>
> Stay tuned to this repo and our public channels (such as our [Discord](https://discord.gg/VzZuaw3Xay) community) for updates as we continue to develop the future of open source Harper.

Contributors are encouraged to communicate with maintainers in issues or other channels (such as our community [Discord](https://discord.gg/VzZuaw3Xay)) before submitting changes.

## Getting Started

Install dependencies using `npm install`

Build the project using `npm run build` or `npm run build:watch` to automatically rebuild on file changes.

Run integration tests using `npm run test:integration:all`. For targeted runs or additional options, use `npm run test:integration -- <pattern>`. Make sure to read the [integration test instructions](./integrationTests/README.md) for setup requirements (particularly the loopback address configuration).

Run a source-compatible test directly, without building Harper:

```bash
npm run test:unit:typestrip -- unitTests/components/deploymentRecorder.test.js
```

`#src` selects the source tree in this lane; retained JavaScript sources use explicit mappings or a `.js` suffix. `npm run test:unit:typestrip` runs the source-compatible part of the core gate. Native resource tests use `npm run test:unit:typestrip:resources`. Source conditions are inherited by workers and spawned fixtures.

Legacy tests that rewire exports, replace module namespaces or manipulate their export cache retain `#js` and need compiled CommonJS. Build after changing the code they test, then run them with ordinary Mocha:

```bash
npm run build
npm run test:unit -- unitTests/config/configUtils.test.js
npm run test:unit:typestrip:main
```

The combined `:typestrip:main` command covers the same selection as `test:unit:main` in two sequential processes. Each has its own isolated configuration and databases. `--list` on `node unitTests/runTypeStripTests.mts` shows the partition. `:typestrip:all` selects all `*test.*js` suites, including the API and legacy storage suites; stop a conflicting server before API tests as for the ordinary API gate.

Use the project-installed Mocha through the npm scripts or `npx`; completion tracking patches that copy.

A source process denies `#js`, and the harness fails a source run that loaded this checkout's compiled core, checking at file boundaries and final completion. Route an existing mutable-export suite to the compiled lane instead of mixing trees. The combined launcher rejects a globally enabled `typestrip` condition; let it choose each lane. Ordinary compiled CI still runs all tests, while native CI never builds `dist`.

The launcher runs each lane in one process, so use ordinary Mocha for watch or parallel mode. Custom configurations must require `unitTests/mocha.init.js` for completion tracking. Mixed selections with global `--file` setup run compiled to preserve ordering. File reporters and external reporters must run separately per lane to avoid overwriting output. Ctrl-C removes the launcher's temporary configuration; a force-killed process can leave that directory and its isolated database root. The existing stale-root sweep reclaims only the database root. Mocha's per-test timeout and the enclosing CI/test command bound execution. No runtime-speed improvement is claimed: the source workflow avoids the build step, while the full selection still needs a current build for legacy and artifact checks.

## Code Formatting & Linting

We currently use [prettier](https://prettier.io) and [eslint](https://eslint.org) to enforce code formatting and
linting, respectively. While we do enforce conformity to prettier's ruleset in CI, we're taking an incremental approach
with eslint. Rules that can be globally enforced are enabled in the `eslint.required.config.mjs` file, while the
aspirational rules are in `eslint.config.mjs`. This is because when editing or linting new code locally, we want to
adhere to the full ruleset in `eslint.config.mjs`. But in CI we only want to enforce those rules enabled in
`eslint.required.config.mjs`. We will enable additional rules in `eslint.required.config.mjs` over time until there is
one ruleset that is enforced everywhere. PRs that allow enabling additional eslint rules are welcome!

## Dependency Version Updates

We use [Renovate](https://www.mend.io/renovate/) to automatically update dependencies on a regular schedule (with a cooldown period to help guard against supply chain attacks).
This is configured in the `renovate.json` file in the project root. Renovate will open pull requests when it detects available updates and
Harper staff will review these and merge them on a case-by-case basis. But contributors should feel free to comment on any pull requests
they have feedback on. But in general, manually opening PRs to update dependencies is not necessary thanks to this automation.

### Reducing package-lock.json merge conflicts

The repository includes a `.gitattributes` entry that registers `npm-merge-driver` as the merge strategy for `package-lock.json`. To enable automatic conflict resolution when merging or rebasing locally, install it once:

```bash
npx npm-merge-driver install --global
```

This is optional — contributors who skip it will see standard merge conflict behavior. The driver is not used for server-side PR merges on GitHub.

## Repository Structure

Most of the content within this repo is source files. The exceptions are `static` and `test` directories, and various configuration files (such as `eslint.config.mjs`, `prettier.config.mjs`, and `tsconfig.json`).

## Repository Sync Procedure

> This section is only relevant to repository maintainers responsible for the temporary synchronization of the old, internal repository and this one.

These are the steps @Ethan-Arrowood has been following to synchronize the repositories; particularly bringing commits forward from the old repo to this new one, but the steps could reasonably be used in the reverse direction too.

> This procedure assume the old, internal repo is set as the `old` git remote
>
> ```
> git remote add old <internal repo URL>
>
> # Only fetch `main` branch
> git config remote.old.fetch '+refs/heads/main:refs/remotes/old/main'
> # Don't fetch tags
> git config remote.old.tagOpt '--no-tags'
> ```

1. Make sure local `main` branch is checked out and clean `git checkout main && git status`.
2. Copy the [latest previously-synced commit hash from this file](#last-synchronized-commit).
3. Run the sync-commits helper script: `dev/sync-commits.js <previously-synced-commit-hash>`
4. For each commit the script lists, run the `git cherry-pick ...` command it suggests.
   - NB: Some of these may have `-m 1` params to handle merge commits correctly.
5. If either cherry-pick command results in a non-zero exit code that means there is a merge conflict.
   1. If the conflict is a content, resolve it manually and `git add` the file
      - Example: `CONFLICT (content): Merge conflict in package.json`
   2. Else if the conflict is a modify/delete then likely `git rm` the file
      - Example: `CONFLICT (modify/delete): unitTests/bin/copyDB-test.js deleted in HEAD and modified in f75d9170b`
   3. Then check `git status`, if there is nothing you can `git cherry-pick --skip`
      - Note: in this circumstance, running `git cherry-pick --continue` results in a non-zero exit code with the message `The previous cherry-pick is now empty, possibly due to conflict resolution.` Maybe we use this to then run `--skip`? Or maybe there is a way to parse the output of previous `git status` step?
6. After all commits have been picked, manually check that everything brought over was supposed to be. Look out for any source code we do not want open-sourced or things like unit tests which we are actively migrating separately (and will eventually include as part of the synchronization process)
   - The GitHub PR UI is useful for this step; but make sure to leave the PR as a draft until all synchronization steps are complete
7. Once everything looks good, run `npm run format:write` to ensure formatting is correct
8. Commit the formatting changes
9. Add the formatting changes commit from the previous step to the `.git-blame-ignore-revs` file under the `# Formatting Changes` section
10. Record the last commit that was cherry-picked from `old/main` and record it below in order to make the next synchronization easier. **Make sure to record the commit hash from `old/main` and not the new hash**
11. Commit the changes to `CONTRIBUTING.md` to mark the synchronization complete
12. Push all changes and open the PR for review
13. Merge using a Merge Commit so that all relative history is retained and things like the formatting change hash stays the same as recorded.

### Last Synchronized Commit

`f969f21d780581fd0cb5566730028f2d13f1363e`

## Code of Conduct

Harper has a [Code of Conduct](./CODE_OF_CONDUCT.md) that all contributors are expected to follow.
