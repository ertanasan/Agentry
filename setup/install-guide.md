# Installing Agentry with an AI agent's help

A step-by-step script for an AI agent (Claude Code, Codex, …) guiding a person through installing Agentry. The
person can follow it alone too. The [README](../README.md) is the reference; this file is the order to do things
in, with a check after each step.

The examples use `machost` (a Mac), `winhost` (a Windows PC), `user@winhost` (an elevated administrator reachable
over ssh) and `https://winhost.example.ts.net` (the queue owner's public address). Replace them with the real ones.

## Rules for the agent

- **Go one step at a time.** Run or show one step, run its check, and move on only when the check passes.
- **Know which machine a command runs on.** Every step below names one. Before running anything, confirm where
  the person's terminal is: `hostname`, and the prompt (`%` or `$` is zsh/bash on a Mac; `PS C:\…>` is
  PowerShell on Windows). An error pasted from the wrong machine looks like a real failure (for example ssh's
  `Permission denied (publickey)` from a machine without the key).
- **Windows setup needs an elevated PowerShell** (Run as administrator). Over ssh, the administrator's session is
  elevated.
- **Keep secrets out of the chat.** `agentry token` and `agentry attach` read the token or key from stdin: have
  the person run them in their own terminal and paste there, not into the conversation. If one does land in the
  chat, suggest rotating it afterwards (`claude setup-token` again; `agentry runner-key rotate`).
- **Never edit Agentry's database by hand.** Every change has a CLI command. If one seems missing, the install
  may be old: update it first.
- **Ask before anything destructive** (`--uninstall --purge`, `-Uninstall -Purge`, deleting `~/.agentry` or
  `C:\Agentry`), and say what it keeps and what it deletes.

## Step 0. Choose the layout

Ask the person:

1. **Which machines, and which projects build on each?** iOS and macOS apps build only on a Mac. Windows-only
   builds and local IIS/service deploys need Windows.
2. **Will they use the web UI from a phone or another computer?** If so, they need an HTTPS address for it, for
   example a Tailscale Serve name. A passkey works only at the address it was created on, so choose it now.
3. **Which AI agent runs the requests?** Claude Code (default; needs a Claude subscription) or Codex.

Then pick one:

| Layout | When | Steps |
|---|---|---|
| **A. One machine** | Every project builds on one machine | 1, 2, 3, 4, 5 |
| **B. One queue, two machines** | e.g. a 24/7 Windows server owns the queue, a Mac runner builds the iOS apps | 1–5 on the owner, then 6 |

In layout B, the **owner** is the always-on machine: it holds the database, settings, users and web UI. The
**attached** machine only runs requests; its own UI switches off while it is attached.

## Step 1. Prerequisites

**On a Mac** (`machost`), check:

```sh
bun --version && git --version && claude --version
```

Install whatever is missing: Bun from https://bun.sh, Claude Code from its documentation, git from the Xcode
command line tools (`xcode-select --install`).

**On Windows** (`winhost`), only git and an elevated Windows PowerShell are needed; setup installs Bun and
Claude Code:

```powershell
git --version
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')   # True
```

✅ Check: every command prints a version, and the last one prints `True`.

## Step 2. Install

### On a Mac

```sh
git clone https://github.com/ertanasan/Agentry.git ~/Agentry
cd ~/Agentry
setup/mac-setup.sh --public-url https://machost.example.ts.net --owner alice
```

- Leave out `--public-url` if the UI is only used on this Mac (`http://localhost:4747`), or if this Mac is going
  to be an **attached** runner (step 6). An attached Mac also needs no `--owner`.
- With a public URL on Tailscale, publish the port: `tailscale serve --bg 4747`.

✅ Check: the script ends with `answers on 127.0.0.1:4747` (and at the public URL, if given), and
`launchctl list | grep agentry` shows `com.agentry.serve` and `com.agentry.run`.

### On Windows

Get [`setup/windows-setup.ps1`](windows-setup.ps1) (clone the repository, or download the file), then in an
elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File windows-setup.ps1 -GitName "Agentry" -GitEmail agentry@example.com `
  -PublicUrl https://winhost.example.ts.net -Owner alice -DeployFolders C:\Sites\MyApp -DeployServices MyApp
```

Ask for `-DeployFolders` and `-DeployServices` (what deploy commands may change) and `-SqlInstances` (SQL Server
instances the sandbox must be refused from) before running it. At the end it prints an SSH public key: add it to
each repository as a deploy key **with write access**, then run setup again with
`-Clone git@github.com:you/MyApp.git`. Open a new shell so `agentry` is on `PATH`.

✅ Check:

```powershell
Get-ScheduledTask -TaskName 'Agentry*' | Select-Object TaskName, State
powershell -ExecutionPolicy Bypass -File windows-setup.ps1 -SelfTest
```

`Agentry server` is `Running`. The runner stays `Ready` until step 3; that's expected.

## Step 3. The agent's credentials

Each machine that runs requests needs its own token. The person runs, in their own terminal:

```sh
claude setup-token        # prints a long-lived token
agentry token             # paste it, then Enter and Ctrl-D
```

On Windows, then start the runner: `Start-ScheduledTask 'Agentry runner'`. For Codex, see
[Choose an AI agent](../README.md#choose-an-ai-agent).

✅ Check: `~/.agentry/claude-oauth-token` (Windows: `C:\Agentry\home\claude-oauth-token`) exists, and the runner
log (`~/.agentry/runner.log`, Windows: `C:\Agentry\logs`) has no authentication errors.

## Step 4. The owner account

Skip on an attached machine. If setup ran with `--owner`/`-Owner`, it printed a one-time passkey link
(30 minutes). Otherwise:

```sh
agentry user add alice
```

Open the link **at the public address** on the device that will hold the passkey (phone or computer), and
create the passkey. Add more devices later with `agentry user passkey alice`; other people with
`agentry user add <name>` or from the UI.

✅ Check: the person signs in at the public address and sees the home page.

## Step 5. Projects and a first request

A project is a repository folder plus a [recipe](../README.md#recipes): its paths and its build, test and
deploy commands on **this** machine. Start from an example in [`recipes/`](../recipes) and help the person fill
in `repo` (an absolute path to a checkout on this machine), `deploy_group`, `scope_path`, `build_cmd`,
`test_cmd`, and `deploy_cmd` with `targets` if Agentry should deploy.

```sh
agentry project add api ~/recipes/api.json
agentry add api "Fix the typo on the about page" --done-when "The about page says 'colour' nowhere"
agentry list
```

✅ Check: the request goes from `queued` to `running` within seconds, and ends `built` or `deployed` (or
`needs_review` with a reason). If it fails, open it in the UI and read the failing step's log.

## Step 6. Attach a second machine's runner (layout B)

**On the owner** (`winhost`), make a key for the second machine, and say which projects it may run:

```powershell
agentry runner-key add machost                              # prints the key once
agentry project add ios ios.json --runner machost           # only the Mac may run it
agentry project add web web.json --runner local,machost     # winhost first, the Mac too
```

**On the attached machine** (`machost`), after steps 1–3 there:

```sh
agentry project add ios ~/.agentry/recipes/ios.json     # this machine's recipe, under the owner's project name
agentry project add web ~/.agentry/recipes/web.json
agentry attach https://winhost.example.ts.net           # paste the key from the owner
```

Repositories must be cloned on both machines for projects that both may run.

✅ Check: `~/.agentry/runner.log` on the attached machine ends with
`working the queue at https://winhost.example.ts.net`, and the owner's home page shows `machost online`. A
project the attached machine has no recipe for shows as missing on the owner's page.

## Reinstalling and recovering

- **Updating.** Mac: `git pull` in the checkout, then `setup/mac-setup.sh` again (it keeps the URL and port).
  Windows: follow [`windows-update.md`](windows-update.md).
- **Starting a Mac over.** `setup/mac-setup.sh --uninstall --purge` keeps the database, backups, an export of the
  projects and recipes, and the attach file in `~/.agentry-backup-<date>`, deletes `~/.agentry`, and prints how
  to restore: run setup, then `agentry import ~/.agentry-backup-<date>/export` and, for an attached runner,
  `cp -p ~/.agentry-backup-<date>/queue.json ~/.agentry/` (it rejoins the same queue with the same key).
- **Starting Windows over.** `windows-setup.ps1 -Uninstall -Purge -SqlInstances '.\SQLEXPRESS'` keeps the
  database and an export in `C:\Agentry-backup-<date>`. Run setup, then `agentry import C:\Agentry-backup-<date>\export`.
  Runner keys come back as they were, so attached machines keep working. Users and passkeys start empty.
- **An attached machine lost its key** (its `~/.agentry` was deleted without `--purge`). The owner keeps only a
  hash, so the key can't be read back, and `runner-key add` refuses a name that exists. On the owner:
  `agentry runner-key rotate machost`, then `agentry attach` on the machine with the new key. Projects and run
  history stay.
- **A machine is gone for good.** Take its name off every project's `--runner` list, then
  `agentry runner-key remove machost` on the owner.
- **Recipes lost.** `agentry export <dir>` writes every project's recipe; run it before deleting anything. While
  an attached runner is connected, the owner's **Recipes** tab shows the recipes it reported.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| ssh `Permission denied (publickey)` | The command ran on a machine without the key | Check `hostname`; run it from the machine that has the key |
| Windows runner task stays `Ready` | No token yet | Step 3, then `Start-ScheduledTask 'Agentry runner'` |
| `UNIQUE constraint failed: runner_keys.name` | `runner-key add` for a name that exists | `agentry runner-key rotate <name>` |
| `unknown runner key` in the attached runner's log | The key was rotated or removed on the owner | `agentry attach` again with the new key |
| Attached machine's UI says the runner is offline | Expected: its own queue is switched off | Use the owner's UI |
| A request says "waiting for machost" | That runner is offline or has no recipe for a project | Start it; `agentry project add` the missing recipe there |
| Nothing answers at the public URL | The address isn't published | `tailscale serve --bg 4747` (or set up the proxy) |
| A passkey isn't offered or fails | Opened at a different address than it was made on | Use the public address given to setup |
| `bun install` fails on Windows with access denied | Packages hard-linked from the admin's cache | See step 3 of [`windows-update.md`](windows-update.md) |
