# Updating Agentry on Windows

How to bring a Windows install made by [`windows-setup.ps1`](windows-setup.ps1) up to a new `main` from another
machine, without running setup again. Setup also updates Agentry, but it needs the options it was first run with,
and it resets the `AgentryRunner` and `AgentrySandbox` passwords. For an ordinary code change, the steps below are
enough. Migrations run by themselves when the server or runner next opens the database.

Push the change to `origin/main` first. The examples use `user@winhost`, an elevated administrator reachable over
ssh, and the default `C:\Agentry` root.

## 1. Send the commands on stdin

Give PowerShell its script on stdin. An inline `-Command "..."` loses the single quotes around task names on the
way through ssh, and a zsh `echo` would mangle the `\a` in `C:\Agentry\app`:

```sh
ssh user@winhost 'powershell -NoProfile -Command -' <<'EOF'
# the commands below
EOF
```

## 2. Fast-forward the checkout

```powershell
git -C C:\Agentry\app fetch --quiet origin main
git -C C:\Agentry\app merge --ff-only --quiet origin/main
git -C C:\Agentry\app log --oneline -1
```

`git status` shows `tools/runas/agentry-runas.exe` as untracked: setup compiles it there.

## 3. Only when the change needs it

- `package.json` or `bun.lock` changed: reinstall the packages as copies, not hard links into this administrator's
  package cache, which `AgentryRunner` can't read:

  ```powershell
  Remove-Item C:\Agentry\app\node_modules -Recurse -Force
  Push-Location C:\Agentry\app; C:\Agentry\bin\bun.exe install --frozen-lockfile --backend copyfile; Pop-Location
  ```

- `tools/runas/runas.cs` or `setup/` changed: run setup again, with the options it was first run with.

## 4. Restart what the change touches

- **Agentry server**: the web UI (`server.ts`, `views.ts`, its scripts and styles).
- **Agentry runner**: the runner, the queue and the agent adapters. Restarting it stops the requests it is running.
  On startup it recovers them.

```powershell
Stop-ScheduledTask -TaskName 'Agentry server'
Start-Sleep 3
Start-ScheduledTask -TaskName 'Agentry server'
```

## 5. Check

```powershell
Get-ScheduledTask -TaskName 'Agentry*' | Select-Object TaskName, State
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4747/login -TimeoutSec 5).StatusCode   # 200
```

Both tasks show `Running`. The task logs are in `C:\Agentry\logs`.
