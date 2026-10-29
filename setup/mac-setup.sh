#!/bin/zsh
# Sets up Agentry on a Mac, for the user who runs it (the counterpart of windows-setup.ps1). It is safe to run again:
# it rewrites the command and the agents, keeping the public URL and port of the last run unless given anew. Example:
#   setup/mac-setup.sh --public-url https://myhost.tailnet.ts.net --owner alice
#   setup/mac-setup.sh --self-test     the sandbox canary against this Mac, and a check that the web UI answers
#   setup/mac-setup.sh --uninstall     stop and remove the agents and the command; $AGENTRY_HOME stays
#   ... --uninstall --purge            also delete $AGENTRY_HOME, keeping its database, backups, an export (projects
#                                      and recipes) and the attach file in $AGENTRY_HOME-backup-<date> first
#
# What it makes:
#   <bin-dir>/agentry   runs this checkout's src/cli.ts with bun, and AGENTRY_HOME, AGENTRY_PORT and AGENTRY_PUBLIC_URL as
#                       chosen here (a value already in the environment wins). Default bin-dir: ~/.local/bin.
#   ~/Library/LaunchAgents/com.agentry.serve.plist, com.agentry.run.plist
#                       launchd agents that run `agentry serve` and `agentry run` from login and start them again when
#                       they stop, with the PATH this script ran with (deploy commands need your tools). Logs:
#                       $AGENTRY_HOME/serve.log and runner.log.
set -euo pipefail

script=${0:A}
app=${script:h:h}
home_dir=${AGENTRY_HOME:-$HOME/.agentry}
bin_dir=$HOME/.local/bin
agents=$HOME/Library/LaunchAgents
labels=(com.agentry.serve com.agentry.run)
public_url='' port='' owner='' mode=install purge=0

usage() { sed -n '2,8p' "$script" | sed 's/^# \{0,1\}//'; echo "options: --public-url URL --port N --owner NAME --bin-dir DIR | --self-test | --uninstall [--purge]"; exit 1; }
while (( $# )); do
  case $1 in
    --public-url) public_url=${2:?}; shift 2 ;;
    --port) port=${2:?}; shift 2 ;;
    --owner) owner=${2:?}; shift 2 ;;
    --bin-dir) bin_dir=${2:?}; shift 2 ;;
    --self-test) mode=selftest; shift ;;
    --uninstall) mode=uninstall; shift ;;
    --purge) purge=1; shift ;;
    *) usage ;;
  esac
done
(( purge )) && [[ $mode != uninstall ]] && usage
cmd=$bin_dir/agentry
uid=$(id -u)

step() { print -- "==> $1" }
fail() { print -u2 -- "mac-setup: $1"; exit 1 }
[[ $(uname) == Darwin ]] || fail "this is for macOS; on Windows use setup/windows-setup.ps1"

# A launchd job's pid, empty when it isn't running.
job_pid() { launchctl print "gui/$uid/$1" 2>/dev/null | awk '$1 == "pid" { print $3; exit }' }

# Stops and removes an agent. Stopping the runner lets the requests it is running finish first (up to its ExitTimeOut).
remove_agent() {
  local label=$1
  launchctl print "gui/$uid/$label" >/dev/null 2>&1 || return 0
  [[ $label == com.agentry.run && -n $(job_pid $label) ]] && print "    the runner finishes the requests it is running first"
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  while launchctl print "gui/$uid/$label" >/dev/null 2>&1; do sleep 1; done
}

# Waits up to 30 s for the web UI's sign-in page at $1.
answers() {
  local i
  for i in {1..30}; do
    [[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1/login" || true) == 200 ]] && return 0
    sleep 1
  done
  return 1
}

if [[ $mode == uninstall ]]; then
  step "Removing the launchd agents"
  for label in $labels; do remove_agent $label; rm -f "$agents/$label.plist"; done
  keep=$home_dir-backup-$(date +%Y%m%d-%H%M)
  if (( purge )) && [[ -f $home_dir/agentry.db ]]; then
    step "Keeping the database in $keep"
    mkdir -m 700 -p "$keep"
    cp -p "$home_dir"/agentry.db* "$keep"
    [[ -d $home_dir/backups ]] && cp -Rp "$home_dir/backups" "$keep/backups"
    # The attach file holds the runner key, which the queue's owner keeps only as a hash: with it back, this
    # machine rejoins that queue without a new key.
    [[ -f $home_dir/queue.json ]] && cp -p "$home_dir/queue.json" "$keep"
    # The projects and this machine's recipes, for `agentry import` once setup has run again.
    AGENTRY_HOME=$home_dir bun "$app/src/cli.ts" export "$keep/export" || print -u2 "    no export: the database copy in $keep still has everything"
  fi
  if [[ -f $cmd ]] && grep -q 'mac-setup.sh' "$cmd"; then step "Removing $cmd"; rm -f "$cmd"; fi
  if (( ! purge )); then
    print "Done. Agentry's data stays in $home_dir; --uninstall --purge deletes it too."
    exit 0
  fi
  step "Deleting $home_dir"
  rm -rf "$home_dir"
  print "Done."
  if [[ -d $keep ]]; then
    print "The old database and its backups are in $keep. After running this setup again:"
    [[ -d $keep/export ]] && print "  bring the projects back:   agentry import $keep/export"
    [[ -f $keep/queue.json ]] && print "  rejoin the same queue:     cp -p $keep/queue.json $home_dir/"
  fi
  exit 0
fi

if [[ $mode == selftest ]]; then
  [[ -x $cmd ]] || fail "run the setup first"
  step "Sandbox canary (test/e2e/canary.test.ts) against this Mac"
  (cd "$app" && bun test test/e2e/canary.test.ts)
  url=$(sed -n 's/.*AGENTRY_PUBLIC_URL:-\([^}]*\)}.*/\1/p' "$cmd")
  p=$(sed -n 's/.*AGENTRY_PORT:-\([^}]*\)}.*/\1/p' "$cmd")
  step "Web UI"
  answers "http://127.0.0.1:$p" && print "    answers on 127.0.0.1:$p" || fail "nothing answers on 127.0.0.1:$p (see $home_dir/serve.log)"
  if [[ -n $url ]]; then answers "$url" && print "    answers at $url" || fail "nothing answers at $url (is Tailscale Serve or your proxy set up?)"; fi
  [[ -n $(job_pid com.agentry.run) ]] && print "    the runner is running" || fail "the runner isn't running (see $home_dir/runner.log)"
  print "Self-test passed."
  exit 0
fi

# 1. What Agentry needs: bun and git to run, claude for the agent.
step "Checking bun, git and claude"
bun=$(command -v bun) || fail "bun is not on PATH: install it from https://bun.sh"
command -v git >/dev/null || fail "git is not on PATH"
claude=$(command -v claude || true)
[[ -n $claude ]] || print "    claude is not on PATH: the runner can't start an agent until you install Claude Code"
(cd "$app" && bun install --frozen-lockfile >/dev/null) || fail "bun install failed in $app"

# 2. The command. A rerun keeps the public URL and port the last one chose unless they are given anew.
previous() { [[ -f $cmd ]] && sed -n "s/.*$1:-\([^}]*\)}.*/\1/p" "$cmd" | head -1 || true }
public_url=${public_url:-$(previous AGENTRY_PUBLIC_URL)}
port=${port:-$(previous AGENTRY_PORT)}
port=${port:-4747}
public_url=${public_url%/}
step "The agentry command: $cmd"
mkdir -p "$bin_dir" "$home_dir" "$agents"
{
  print '#!/bin/sh'
  print '# Written by setup/mac-setup.sh; run it again to change these. A value already in the environment wins.'
  print "export AGENTRY_HOME=\"\${AGENTRY_HOME:-$home_dir}\""
  print "export AGENTRY_PORT=\"\${AGENTRY_PORT:-$port}\""
  [[ -n $public_url ]] && print "export AGENTRY_PUBLIC_URL=\"\${AGENTRY_PUBLIC_URL:-$public_url}\""
  [[ -n $claude ]] && print "export AGENTRY_CLAUDE_BIN=\"\${AGENTRY_CLAUDE_BIN:-$claude}\""
  print "exec '$bun' '$app/src/cli.ts' \"\$@\""
} > "$cmd"
chmod 755 "$cmd"
[[ :$PATH: == *:$bin_dir:* ]] || print "    $bin_dir is not on your PATH: add it in ~/.zshrc to type \`agentry\`"

# 3. The launchd agents: started at login, started again 30 s after they stop.
xml() { print -r -- "${${${1//&/&amp;}//</&lt;}//>/&gt;}" }
plist() {
  local label=$1 command=$2 log=$3 extra=$4
  cat > "$agents/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$(xml "$cmd")</string><string>$command</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(xml "$PATH")</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>WorkingDirectory</key><string>$(xml "$home_dir")</string>
  <key>StandardOutPath</key><string>$(xml "$home_dir/$log")</string>
  <key>StandardErrorPath</key><string>$(xml "$home_dir/$log")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Standard</string>
$extra
</dict>
</plist>
EOF
}
step "launchd agents for agentry serve and agentry run"
for label in $labels; do remove_agent $label; done
plist com.agentry.serve serve serve.log ''
# A stopped runner lets its running requests finish; a deploy may take up to 30 minutes.
plist com.agentry.run run runner.log '  <key>ExitTimeOut</key><integer>1800</integer>'
for label in $labels; do launchctl bootstrap "gui/$uid" "$agents/$label.plist"; done

# The same commands started by hand keep the port or the runner lease; the agents take over once they stop.
for what in serve run; do
  for pid in $(pgrep -f "$app/src/cli.ts $what\$" || true); do
    [[ $pid == $(job_pid com.agentry.$what) ]] && continue
    print "    agentry $what is also running by hand (pid $pid): stop it with \`kill $pid\`, and launchd's takes over within 30 s"
  done
done

# 4. The claude credentials, and the first owner.
# Any Claude account counts (claude-oauth-token-<name>, or the unnamed file from before accounts had names).
tokens=($home_dir/claude-oauth-token*(N))
if (( ! $#tokens )) && [[ ! -x $home_dir/api-key-helper ]]; then
  if [[ -t 0 ]]; then step "Claude account \"default\" (run \`claude setup-token\` in another terminal and paste its output)"; "$cmd" token claude default
  else print "    no Claude account yet: run \`agentry token claude <name>\` and paste the output of \`claude setup-token\`"; fi
fi
if [[ -n $owner ]]; then
  step "Owner $owner"
  "$cmd" user add "$owner" --owner || print "    if $owner exists already, \`agentry user reset $owner\` prints a new link"
fi

# 5. Does it answer?
step "Checking the web UI"
if answers "http://127.0.0.1:$port"; then print "    answers on 127.0.0.1:$port"
else print "    nothing answers on 127.0.0.1:$port yet: see $home_dir/serve.log"; fi
if [[ -n $public_url ]]; then
  if answers "$public_url"; then print "    answers at $public_url"
  else print "    nothing answers at $public_url: for Tailscale, run \`tailscale serve --bg $port\` (or set up your proxy)"; fi
fi

users=$(sqlite3 -readonly "$home_dir/agentry.db" "SELECT COUNT(*) FROM users" 2>/dev/null || echo 0)
print "
Done. Agentry runs from $app; its data is in $home_dir.
Next:"
# The owner account comes first: it signs in to the web UI and manages users, projects and settings.
n=0
(( users > 0 )) || print "  $((++n)). Create your owner account first: agentry user add <name>   (or run this again with --owner <name>)
     and open the passkey link it prints on the device that will hold the passkey"
print "  $((++n)). Check the sandbox and the UI:   $script --self-test
  $((++n)). Register each project:          agentry project add <name> <recipe.json>   (see recipes/)"
print "  Open the web UI at ${public_url:-http://localhost:$port}. To update Agentry: git pull here, then run this again."
