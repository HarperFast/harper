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

Run integration tests using `npm run test:integration`. Make sure to read the [integration test instructions](./integrationTests/README.md) for setup requirements (particularly the loopback address configuration).

Run unit tests using `npm run test:unit <unit-test-file>` or `npm run test:unit:all`, but make sure to build the project first since unit tests depend on the built source files.

> Unit tests currently use [Mocha](https://mochajs.org/) as the test runner, but since they are implemented in TypeScript and are sometimes executing TypeScript source code, it also uses [TSX](https://tsx.is/) for compilation and execution. The npm script `test:unit` sets the appropriate env vars and mocha configuration file. Make sure that the `TSX_TSCONFIG_PATH` environment variable points to the correct `tsconfig.json` file for the unit tests (i.e. `./unitTests/tsconfig.json`) and not the root-level `tsconfig.json`.

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

`e1ea920d74e919140ae89d5ca4d75614c10c2925`

## Code of Conduct

Harper has a [Code of Conduct](./CODE_OF_CONDUCT.md) that all contributors are expected to follow.
