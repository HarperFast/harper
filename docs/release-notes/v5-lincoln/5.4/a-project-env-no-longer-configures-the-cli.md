---
section: 'Security'
order: 30
---

### A Project `.env` No Longer Configures the CLI

[Refuse a project .env CLI target or credential, and save logins under the client's target](https://github.com/HarperFast/harper/pull/4001) stops a cloned project from choosing where the `harper` CLI sends credentials, and stops a login server from choosing where its token is saved:

- **A project `.env` cannot set the CLI's target, credentials or connection trust.** Operations API commands, `harper login` and the backup commands stop with an error naming the keys when a `.env` or `.env.vault` file in the current directory sets one that the environment does not. That covers the `HARPER_CLI_` and `CLI_TARGET` target and credential names, `HOME`, TLS and proxy variables, and workload-identity and `GITHUB_` deploy inputs; [Project `.env` files](/reference/v5/cli/authentication#project-env-files) has the full list. Exported values work as before and win over the file, and other keys still load.
- **`harper login` no longer writes `.env`.** It saves the target in `~/.harperdb/credentials.json`, which later commands use by default. It saves and prints the URL you gave it, never a target named in the server's reply.
- **`harper logout` no longer reads `.env`.**

Application `.env` handling in `harper run`, `harper dev` and components is unchanged.

**Upgrade impact:** a project whose `.env` sets one of these names now gets the error, and `target=` on the command does not get past it. Remove a target or credential line, then rely on the target `harper login <url>` saves, pass `target=<url>`, or export the variable in your shell or CI environment. Move a name your application reads at runtime, such as a proxy setting, to the process environment or a differently named file that `loadEnv` lists. Loading the file deliberately in a script, `dotenv -- harper deploy`, also works, and trusts everything in that file. CI that stores `harper login --for-ci` output as secrets is unaffected.
