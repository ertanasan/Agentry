# Agentry

A personal software-delivery queue: requests go in, gated and deployed changes come out.

You describe a change and the line that says when it is done. A runner takes the request into a fresh git
worktree, has Claude Code make the change inside a sandbox, and then puts the result through gates before
anything reaches production:

1. **Inspect** the diff. A change outside the request's projects stops it; changes to build files, gate
   paths, or deleted and skipped tests wait for your approval.
2. **Build and test** in the sandbox, reading the results from a TRX file.
3. **Verify** with a second, read-only Claude call that judges whether the diff meets the done-when line.
4. **Push**, then **deploy**, and read each target's live `VERSION` to confirm it runs the new commit.

Anything that fails stops with a state you can act on: answer a question, approve, retry, re-run the deploy,
or reopen a finished request.

This is built for one person's projects and machines. It is shared as it is, not as a supported product.

## Requirements

- macOS (steps run under `sandbox-exec`; a Windows runner is in progress, see `setup/spike/`)
- [Bun](https://bun.sh), git, and the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- An Anthropic API key, or a `claude setup-token` token for subscription auth (`agentry token`)

## Use

```sh
bun install
bun src/cli.ts project add backend recipes/vocatrain-backend.json
bun src/cli.ts add backend "Show similar words" --done-when "..."
bun src/cli.ts run            # work the queue
bun src/cli.ts serve          # web UI with passkey sign-in on 127.0.0.1:4747
```

`bun src/cli.ts` with no arguments lists every command. State lives in `~/.agentry` (`AGENTRY_HOME`).

A project's **recipe** says how to build, test and deploy it, and which paths it owns. The files in
`recipes/` are real ones with the host names and paths replaced by placeholders.

## Layout

- `src/runner.ts`: the pipeline from queued request to deployed commit
- `src/sandbox.ts`, `sandbox/run.sb`: the sandbox for every step that runs agent-written code
- `src/inspect.ts`, `src/verifier.ts`: the diff gates and the done-when verifier
- `src/server.ts`, `src/views.ts`: the web UI
- `eval/verifier/`: an eval of the verifier; its base snapshot is not included in this repository

## Tests

```sh
bun test
bun run typecheck
```

## License

[MIT](LICENSE)
