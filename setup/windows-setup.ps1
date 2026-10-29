# Sets up a standalone Agentry (web UI and runner, own database) on Windows (winhost review T7). Run it in an elevated
# Windows PowerShell; it is safe to run again (it updates Agentry and resets the two accounts' passwords). Example:
#   powershell -ExecutionPolicy Bypass -File windows-setup.ps1 -GitName 'Agentry' -GitEmail 'agentry@example.com' `
#     -PublicUrl 'https://myhost.tailnet.ts.net' -DeployFolders 'C:\Sites\MyApp' -DeployServices 'MyApp' -SqlInstances '.\SQLEXPRESS'
#   ... -Clone 'git@github.com:me/MyApp.git'        once the printed deploy key is on the repository
#   ... -Owner 'alice'                               also create the first owner and print their passkey link
#   powershell -ExecutionPolicy Bypass -File windows-setup.ps1 -SelfTest      only run test/windows.test.ts as AgentryRunner
#   powershell -ExecutionPolicy Bypass -File windows-setup.ps1 -Uninstall     stop and remove the tasks and the command
#                                                                              from PATH; the accounts and <root> stay
#   ... -Uninstall -Purge -SqlInstances '.\SQLEXPRESS'   also remove the accounts, their profiles and SQL Server logins,
#                                                         and <root>, keeping a copy of the database in <root>-backup-<date>
#
# What it makes:
#   AgentryRunner   standard user that runs Agentry (startup tasks "Agentry runner" and "Agentry server"). Owns
#                   <root>\home (database, worktrees, logs of runs, the claude token), <root>\repos and <root>\logs.
#   AgentrySandbox  standard user that runs the agent, build, test and verify steps. It may read <root>\app and <root>\bin,
#                   list the names (not read the files) in <root> and <root>\home, and write only the folders the runner
#                   grants it for a run (src/platform-windows.ts). It is denied
#                   writing the top-level folders of C:\ that every user may otherwise change, and SQL Server logins.
#   <root>\app      this repository, checked out from -Repo, with tools\runas\agentry-runas.exe compiled.
#   <root>\bin      bun.exe (pinned, checksum checked) and claude.exe.
#   <root>\home\ssh an SSH key for pushing; add its public key (printed at the end) to each repository as a deploy key
#                   with write access.
#   <root>\agentry.cmd  the admin command, with <root> on the machine's PATH so new shells can type `agentry`.
# The sandbox can still read whatever Windows lets every user read, and reach every network service, loopback included
# (the isolation spike found per-user firewall rules do not cover loopback): keep local services authenticated.
param(
  [string]$Root = 'C:\Agentry',
  [string]$Repo = 'https://github.com/ertanasan/Agentry.git',
  [string]$Branch = 'main',
  [string]$BunVersion = '1.4.3',
  [string]$GitName = '',          # author of Agentry's commits
  [string]$GitEmail = '',
  [string]$PublicUrl = '',        # the address the browser uses (passkeys are bound to it); default http://localhost:<port>
  [int]$Port = 4747,
  [string[]]$DeployFolders = @(), # folders deploy commands may change, as AgentryRunner
  [string[]]$DeployServices = @(),# services deploy commands may stop and start
  [string[]]$SqlInstances = @(),  # SQL Server instances that must refuse AgentrySandbox
  [string[]]$Clone = @(),         # repositories to clone into <root>\repos (ssh URLs; needs the deploy key added first)
  [string]$Owner = '',            # create this first owner account and print its one-time passkey link
  [switch]$SelfTest,
  [switch]$Uninstall,
  [switch]$Purge                  # with -Uninstall: start from scratch (see above)
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$runner = 'AgentryRunner'
$sandbox = 'AgentrySandbox'
$tasks = @{ run = 'Agentry runner'; serve = 'Agentry server'; selftest = 'Agentry selftest' }
$app = Join-Path $Root 'app'; $bin = Join-Path $Root 'bin'; $home_ = Join-Path $Root 'home'; $logs = Join-Path $Root 'logs'
$launcher = Join-Path $app 'setup\windows-agentry.ps1'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this in an elevated PowerShell (Run as administrator).'
}
function Step([string]$what) { Write-Host "==> $what" }
function Assert-Exit([string]$what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

# Runs a registered task and waits until it has run and finished. A new account's first logon builds its profile, so
# the task can sit queued a while first.
function Invoke-Task([string]$name, [int]$minutes) {
  Start-ScheduledTask -TaskName $name
  $notFinished = 0x41301, 0x41303, 0x41325  # running, has not run yet, queued
  $deadline = (Get-Date).AddMinutes($minutes)
  do {
    Start-Sleep -Seconds 2
    $state = (Get-ScheduledTask -TaskName $name).State
    $info = Get-ScheduledTaskInfo -TaskName $name
  } while (($state -in 'Running', 'Queued' -or $notFinished -contains $info.LastTaskResult) -and (Get-Date) -lt $deadline)
  $info.LastTaskResult
}

if ($SelfTest) {
  if (-not (Get-ScheduledTask -TaskName $tasks.selftest -ErrorAction SilentlyContinue)) { throw 'Run the full setup first.' }
  $log = Join-Path $logs 'selftest.log'
  Remove-Item $log -ErrorAction SilentlyContinue
  $result = Invoke-Task $tasks.selftest 15
  if (Test-Path $log) { Get-Content $log }
  "selftest task result: $result"
  exit $(if ($result -eq 0) { 0 } else { 1 })
}

# <root> on the machine's PATH, or off it.
function Set-OnPath([bool]$on) {
  $parts = @([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne $Root.TrimEnd('\') })
  if ($on) { $parts += $Root }
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'Machine')
}

if ($Uninstall) {
  Step 'Removing the startup tasks'
  foreach ($name in $tasks.Values) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $name; Unregister-ScheduledTask -TaskName $name -Confirm:$false }
  }
  Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" | Where-Object { $_.CommandLine -like "*$app\src\cli.ts*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # The launcher's loop, git, ssh and claude can outlive the task, and they keep the accounts' profiles loaded.
  Get-Process -IncludeUserName -ErrorAction SilentlyContinue |
    Where-Object { $_.UserName -and @($runner, $sandbox) -contains ($_.UserName -split '\\')[-1] } |
    ForEach-Object { Write-Host "    stopping $($_.ProcessName) ($($_.Id)) of $($_.UserName)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Step "Removing $Root from PATH"
  Set-OnPath $false
  if (-not $Purge) {
    Write-Host "`nDone. The accounts and $Root stay; -Uninstall -Purge -SqlInstances <instance> removes them too."
    exit 0
  }

  $keep = "$Root-backup-$(Get-Date -Format yyyyMMdd-HHmm)"
  if (Test-Path (Join-Path $home_ 'agentry.db')) {
    Step "Keeping the database in $keep"
    New-Item -ItemType Directory -Force $keep | Out-Null
    Copy-Item (Join-Path $home_ 'agentry.db*') $keep
    if (Test-Path (Join-Path $home_ 'backups')) { Copy-Item -Recurse (Join-Path $home_ 'backups') (Join-Path $keep 'backups') }
    # The projects, runner keys and queue settings, for `agentry import` once setup has run again.
    & (Join-Path $Root 'agentry.cmd') export (Join-Path $keep 'export')
    if ($LASTEXITCODE) { Write-Warning "no export: the database copy in $keep still has everything" }
  }
  foreach ($i in $SqlInstances) {
    $login = "$env:COMPUTERNAME\$sandbox"
    $c = New-Object System.Data.SqlClient.SqlConnection "Server=$i;Integrated Security=true;Connect Timeout=10"
    $c.Open()
    try { $q = $c.CreateCommand(); $q.CommandText = "IF SUSER_ID(N'$login') IS NOT NULL DROP LOGIN [$login];"; $q.ExecuteNonQuery() | Out-Null }
    finally { $c.Close() }
    "SQL Server ${i}: login $login dropped"
  }
  Step 'Removing the accounts'
  foreach ($u in $runner, $sandbox) {
    $acct = Get-LocalUser -Name $u -ErrorAction SilentlyContinue
    if (-not $acct) { continue }
    $prof = Get-CimInstance Win32_UserProfile | Where-Object SID -eq $acct.SID.Value
    if ($prof) {
      $gone = $false
      foreach ($try in 1..10) { try { $prof | Remove-CimInstance -ErrorAction Stop; $gone = $true; break } catch { Start-Sleep -Seconds 3 } }
      if (-not $gone) { throw "The profile of $u is still in use: sign out its sessions (Task Manager > Users) or reboot, then run this again." }
    }
    Remove-LocalUser -Name $u
    "removed $u"
  }
  Step "Deleting $Root"
  if (Test-Path $Root) { Remove-Item -Recurse -Force $Root }
  Write-Host @"

Done. $(if (Test-Path $keep) { "The old database and its backups are in $keep. " })$(if (Test-Path (Join-Path $keep 'export')) { "After setup, bring
the projects back with: agentry import $(Join-Path $keep 'export')
" })The access entries setup gave the old accounts
(deploy folders, services, C:\) stay as unresolved SIDs; a new setup grants its new accounts again.
"@
  exit 0
}

if (-not $GitName -or -not $GitEmail) { throw 'Give -GitName and -GitEmail: the author of the commits Agentry pushes.' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class UserRight {
  [StructLayout(LayoutKind.Sequential)] struct LSA_STRING { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref OBJECT_ATTRIBUTES attrs, uint access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LSA_STRING[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  public static void Grant(string sidText, string right) {
    var sid = new SecurityIdentifier(sidText);
    var bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
    var attrs = new OBJECT_ATTRIBUTES(); attrs.Length = Marshal.SizeOf(attrs);
    IntPtr policy;
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attrs, 0x00000811, out policy); // view local info, create account, lookup names
    if (status != 0) throw new Exception("LsaOpenPolicy failed: " + LsaNtStatusToWinError(status));
    var name = new LSA_STRING(); name.Buffer = Marshal.StringToHGlobalUni(right);
    name.Length = (ushort)(right.Length * 2); name.MaximumLength = (ushort)(name.Length + 2);
    try {
      status = LsaAddAccountRights(policy, bytes, new[] { name }, 1);
      if (status != 0) throw new Exception("Granting " + right + " failed: " + LsaNtStatusToWinError(status));
    } finally { Marshal.FreeHGlobal(name.Buffer); LsaClose(policy); }
  }
}
'@

function New-Password {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [Convert]::ToBase64String($bytes).Replace('/', 'x').Replace('+', 'y') + '!a9'  # letters, digits and a symbol
}

# 1. Accounts. Passwords are new on every run; the tasks are registered again below with the runner's.
Step 'Accounts'
$seclogon = Get-Service seclogon
if ($seclogon.StartType -eq 'Disabled') { Set-Service seclogon -StartupType Manual }  # CreateProcessWithLogonW needs it
$passwords = @{}
foreach ($u in $runner, $sandbox) {
  $passwords[$u] = New-Password
  $secure = ConvertTo-SecureString $passwords[$u] -AsPlainText -Force
  if (Get-LocalUser $u -ErrorAction SilentlyContinue) { Set-LocalUser $u -Password $secure -PasswordNeverExpires $true }
  else { New-LocalUser $u -Password $secure -PasswordNeverExpires -AccountNeverExpires -Description 'Agentry' | Out-Null }
  Add-LocalGroupMember Users $u -ErrorAction SilentlyContinue
}
$runnerSid = (Get-LocalUser $runner).SID.Value
[UserRight]::Grant($runnerSid, 'SeBatchLogonRight')  # the startup tasks log on as a batch job
$hidden = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
New-Item $hidden -Force | Out-Null
foreach ($u in $runner, $sandbox) { New-ItemProperty $hidden -Name $u -Value 0 -PropertyType DWord -Force | Out-Null }  # not on the sign-in screen

# 2. Folders. <root> lets nobody but the two accounts in; the sandbox only reads app and bin. The admin running setup
# may also read it unelevated (Explorer runs without the Administrators group), but not the password file or SSH key.
Step "Folders under $Root"
foreach ($d in $Root, $app, $bin, $home_, (Join-Path $Root 'repos'), $logs) { New-Item -ItemType Directory -Force $d | Out-Null }
$admin = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $Root /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' "${runner}:(OI)(CI)RX" "*${admin}:(OI)(CI)RX" /Q | Out-Null; Assert-Exit "icacls $Root"
foreach ($d in $app, $bin) { icacls $d /grant "${sandbox}:(OI)(CI)RX" /Q | Out-Null; Assert-Exit "icacls $d" }
foreach ($d in $home_, (Join-Path $Root 'repos'), $logs) { icacls $d /grant "${runner}:(OI)(CI)M" /Q | Out-Null; Assert-Exit "icacls $d" }
# PowerShell looks its starting folder up in each parent, so the sandbox may list (names only) <root> and the home;
# the runner opens the folders below for each run.
foreach ($d in $Root, $home_) { icacls $d /grant "${sandbox}:(RD,RA)" /Q | Out-Null; Assert-Exit "icacls $d" }
$pwFile = Join-Path $home_ 'sandbox-password'
[IO.File]::WriteAllText($pwFile, $passwords[$sandbox])
icacls $pwFile /inheritance:r /grant:r "${runner}:R" 'Administrators:F' 'SYSTEM:F' /Q | Out-Null; Assert-Exit "icacls $pwFile"

# 3. Bun, pinned and checked against the release's SHA-256 list.
Step "Bun $BunVersion"
$bunExe = Join-Path $bin 'bun.exe'
$have = if (Test-Path $bunExe) { (& $bunExe --version) } else { '' }
if ($have -ne $BunVersion) {
  $base = "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion"
  $tmp = Join-Path $env:TEMP "agentry-bun-$PID"
  New-Item -ItemType Directory -Force $tmp | Out-Null
  try {
    Invoke-WebRequest "$base/bun-windows-x64.zip" -OutFile "$tmp\bun.zip" -UseBasicParsing
    Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile "$tmp\sums.txt" -UseBasicParsing  # served as bytes, not text
    $want = (Get-Content "$tmp\sums.txt" | Where-Object { $_ -match '\sbun-windows-x64\.zip$' }) -replace '\s.*$', ''
    $got = (Get-FileHash "$tmp\bun.zip" -Algorithm SHA256).Hash
    if (-not $want -or $got -ne $want.ToUpper()) { throw "bun-windows-x64.zip does not match SHASUMS256.txt ($got vs $want)" }
    Expand-Archive "$tmp\bun.zip" $tmp -Force
    Copy-Item "$tmp\bun-windows-x64\bun.exe" $bunExe -Force
  } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

# 4. Claude Code: a copy in <root>\bin, where the sandbox can run it (it does not update itself there).
Step 'Claude Code'
$claudeExe = Join-Path $bin 'claude.exe'
if (-not (Test-Path $claudeExe)) {
  $found = Get-Command claude.exe -ErrorAction SilentlyContinue
  $src = if ($found) { $found.Source } else { Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
  if (-not (Test-Path $src)) {
    Write-Host 'Installing Claude Code with the official installer (claude.ai/install.ps1)'
    Invoke-RestMethod 'https://claude.ai/install.ps1' | Invoke-Expression
  }
  if (-not (Test-Path $src)) { throw "No claude.exe at $src after installing" }
  Copy-Item $src $claudeExe
}
"claude: $(& $claudeExe --version)"

# 5. Agentry itself, and the run-as helper. The runner can read but not change its own code.
Step "Agentry from $Repo ($Branch)"
if (Test-Path (Join-Path $app '.git')) {
  git -C $app fetch --quiet origin $Branch; Assert-Exit 'git fetch'
  git -C $app reset --quiet --hard "origin/$Branch"; Assert-Exit 'git reset'
} else {
  git clone --quiet --branch $Branch $Repo $app; Assert-Exit 'git clone'
}
# Copies, not hard links into this administrator's package cache: linked files keep the cache's access list, which
# AgentryRunner cannot read.
Remove-Item (Join-Path $app 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
Push-Location $app
try { & $bunExe install --frozen-lockfile --backend copyfile; Assert-Exit 'bun install' } finally { Pop-Location }
$csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
& $csc /nologo /optimize "/out:$app\tools\runas\agentry-runas.exe" "$app\tools\runas\runas.cs"; Assert-Exit 'Compiling agentry-runas'

# 6. The push key. Git's own ssh, a pinned GitHub host key, and only this key.
Step 'SSH key for pushes'
$ssh = Join-Path $home_ 'ssh'
$key = Join-Path $ssh 'id_ed25519'
$gitUsr = Join-Path $env:ProgramFiles 'Git\usr\bin'
# The folder ends up AgentryRunner's with an access list of its own; take it back (and drop any deny entries a key
# tool left) before writing to it again.
if (Test-Path $ssh) {
  takeown /F $ssh /R /D Y | Out-Null; Assert-Exit "takeown $ssh"
  icacls $ssh /reset /T /C /Q | Out-Null; Assert-Exit "icacls $ssh /reset"
} else { New-Item -ItemType Directory $ssh | Out-Null }
if (-not (Test-Path $key)) {
  $keygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue
  $keygen = if ($keygen) { $keygen.Source } else { Join-Path $gitUsr 'ssh-keygen.exe' }
  & $keygen -q -t ed25519 -N '""' -C "agentry@$env:COMPUTERNAME" -f $key; Assert-Exit 'ssh-keygen'
  icacls $ssh /reset /T /C /Q | Out-Null; Assert-Exit "icacls $ssh /reset"
}
Set-Content (Join-Path $ssh 'known_hosts') 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' -Encoding ASCII
$publicKey = Get-Content "$key.pub"
# The folder gets the access list and its files inherit it (icacls /T would give files an empty one: folder-only
# inheritance flags don't apply to files, but removing what they inherited does).
icacls $ssh /inheritance:r /grant:r "${runner}:(OI)(CI)F" 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' /Q | Out-Null; Assert-Exit "icacls $ssh"
icacls "$ssh\*" /reset /Q | Out-Null; Assert-Exit "icacls $ssh\*"
icacls $ssh /setowner $runner /T /Q | Out-Null
# Windows' own OpenSSH checks the key's real access list. Git's ssh sees an owner-only key as too open when its
# owner runs it, and ignores the key.
$sshExe = Get-Command ssh.exe -ErrorAction SilentlyContinue
$sshExe = if ($sshExe) { $sshExe.Source } else { Join-Path $gitUsr 'ssh.exe' }
$gitSsh = "'$($sshExe -replace '\\', '/')' -i '$(($key -replace '\\', '/'))' -o IdentitiesOnly=yes -o UserKnownHostsFile='$((Join-Path $ssh 'known_hosts') -replace '\\', '/')' -o StrictHostKeyChecking=yes"

# Clones belong to AgentryRunner, or its git refuses them as another user's ("dubious ownership").
# The key is AgentryRunner's, so Windows' OpenSSH won't load it for this administrator ("bad permissions"): clone with
# a copy only this administrator can read, deleted straight after.
foreach ($url in $Clone) {
  $dest = Join-Path $Root "repos\$([IO.Path]::GetFileNameWithoutExtension(($url -split '[/:]')[-1]))"
  if (Test-Path $dest) { "already cloned: $dest"; continue }
  $cloneKey = Join-Path $env:TEMP "agentry-clone-key-$PID"
  Copy-Item $key $cloneKey -Force
  try {
    icacls $cloneKey /inheritance:r /grant:r "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):F" /Q | Out-Null; Assert-Exit "icacls $cloneKey"
    $env:GIT_SSH_COMMAND = $gitSsh.Replace(($key -replace '\\', '/'), ($cloneKey -replace '\\', '/'))
    git clone --quiet $url $dest; Assert-Exit "git clone $url (is the deploy key on the repository?)"
  } finally { Remove-Item $cloneKey -Force -ErrorAction SilentlyContinue; Remove-Item Env:GIT_SSH_COMMAND -ErrorAction SilentlyContinue }
  icacls $dest /setowner $runner /T /C /Q | Out-Null; Assert-Exit "icacls $dest"
  "cloned: $dest"
}

# 7. What deploy commands may touch, as AgentryRunner.
Step 'Deploy rights'
foreach ($d in $DeployFolders) {
  New-Item -ItemType Directory -Force $d | Out-Null
  icacls $d /grant "${runner}:(OI)(CI)M" /Q | Out-Null; Assert-Exit "icacls $d"
}
foreach ($s in $DeployServices) {
  $sddl = (sc.exe sdshow $s | Where-Object { $_ }) -join ''
  Assert-Exit "reading the access list of service $s"
  if ($sddl -notmatch [regex]::Escape(";;;$runnerSid)")) {
    $ace = "(A;;CCLCSWRPWPDTLOCRRC;;;$runnerSid)"  # query, start, stop, pause, read; no reconfiguring
    $new = if ($sddl -match 'S:') { $sddl -replace 'S:', "${ace}S:" } else { $sddl + $ace }
    sc.exe sdset $s $new | Out-Null; Assert-Exit "granting $runner start and stop on service $s"
  }
}

# 8. What the sandbox may not do: change top-level folders of C:\ that every user may write, create new ones there,
# or log on to SQL Server.
Step 'Sandbox limits'
$system = 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users', '$Recycle.Bin', 'System Volume Information', 'Recovery', 'Documents and Settings', 'PerfLogs'
$writable = 'Write|Modify|FullControl|CreateFiles|AppendData'
$denied = @()
foreach ($d in Get-ChildItem C:\ -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $system -notcontains $_.Name }) {
  $acl = Get-Acl $d.FullName -ErrorAction SilentlyContinue
  if ($acl -and ($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference -match 'Users$|Authenticated Users|Everyone' -and $_.FileSystemRights -match $writable })) {
    icacls $d.FullName /deny "${sandbox}:(OI)(CI)(W,D,DC)" /Q | Out-Null; Assert-Exit "icacls $($d.FullName)"
    $denied += $d.FullName
  }
}
icacls 'C:\' /deny "${sandbox}:(AD)" /Q | Out-Null; Assert-Exit 'icacls C:\'
icacls 'C:\Users\Public' /deny "${sandbox}:(OI)(CI)(W,D,DC)" /Q | Out-Null
"write denied: C:\ (new folders), C:\Users\Public$(if ($denied) { ', ' + ($denied -join ', ') })"
$sandboxSid = (Get-LocalUser -Name $sandbox).SID.Value
foreach ($i in $SqlInstances) {
  $login = "$env:COMPUTERNAME\$sandbox"
  $c = New-Object System.Data.SqlClient.SqlConnection "Server=$i;Integrated Security=true;Connect Timeout=10"
  $c.Open()
  try {
    $q = $c.CreateCommand()
    # A login of that name left from an earlier AgentrySandbox (deleted and made again) holds the old SID, so its deny
    # would not cover this account: replace it.
    $q.CommandText = "IF SUSER_SID(N'$login') IS NOT NULL AND SUSER_SID(N'$login') <> SID_BINARY(N'$sandboxSid') DROP LOGIN [$login];
      IF SUSER_ID(N'$login') IS NULL CREATE LOGIN [$login] FROM WINDOWS; DENY CONNECT SQL TO [$login];"
    $q.ExecuteNonQuery() | Out-Null
  } finally { $c.Close() }
  "SQL Server ${i}: $login may not connect"
}

# 9. The environment every Agentry process gets, the admin command, and the startup tasks.
Step 'Startup tasks'
$q = { param($s) "'" + ($s -replace "'", "''") + "'" }
$envLines = @(
  "# Written by windows-setup.ps1; read by app\setup\windows-agentry.ps1. Run setup again to change it.",
  "`$env:AGENTRY_HOME = $(& $q $home_)",
  "`$env:AGENTRY_CLAUDE_BIN = $(& $q $claudeExe)",
  "`$env:AGENTRY_PORT = $(& $q "$Port")",
  "`$env:GIT_SSH_COMMAND = $(& $q $gitSsh)",
  "`$env:PATH = $(& $q $bin) + ';' + `$env:PATH"
)
if ($PublicUrl) { $envLines += "`$env:AGENTRY_PUBLIC_URL = $(& $q $PublicUrl)" }
foreach ($who in 'AUTHOR', 'COMMITTER') { $envLines += "`$env:GIT_${who}_NAME = $(& $q $GitName)", "`$env:GIT_${who}_EMAIL = $(& $q $GitEmail)" }
Set-Content (Join-Path $Root 'agentry-env.ps1') $envLines -Encoding UTF8
Set-Content (Join-Path $Root 'agentry.cmd') "@powershell -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" %*" -Encoding ASCII
Set-OnPath $true

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
foreach ($cmd in 'run', 'serve') {
  $name = $tasks[$cmd]
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $name; Unregister-ScheduledTask -TaskName $name -Confirm:$false }
}
# Stopping a task ends its launcher; make sure no Agentry process of the old tasks outlives it.
Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" | Where-Object { $_.CommandLine -like "*$app\src\cli.ts*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($cmd in 'run', 'serve') {
  $name = $tasks[$cmd]
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $home_ `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Log `"$logs\$cmd.log`" $cmd"
  Register-ScheduledTask -TaskName $name -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings `
    -User $runner -Password $passwords[$runner] -RunLevel Limited | Out-Null
}
# The selftest: test/windows.test.ts as AgentryRunner, started by `windows-setup.ps1 -SelfTest`.
if (Get-ScheduledTask -TaskName $tasks.selftest -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $tasks.selftest -Confirm:$false }
$testAction = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $app `
  -Argument "/c powershell -NoProfile -ExecutionPolicy Bypass -Command `". '$Root\agentry-env.ps1'; & '$bunExe' test test/windows.test.ts`" > `"$logs\selftest.log`" 2>&1"
Register-ScheduledTask -TaskName $tasks.selftest -Action $testAction -User $runner -Password $passwords[$runner] -RunLevel Limited `
  -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)) | Out-Null

Start-ScheduledTask -TaskName $tasks.serve
$hasToken = Test-Path (Join-Path $home_ 'claude-oauth-token*')   # any Claude account
if ($hasToken) { Start-ScheduledTask -TaskName $tasks.run }

# 10. Does the web UI answer? Then the database exists, and the first owner can be made.
function Test-Answers([string]$url) {
  foreach ($i in 1..60) {
    try { if ((Invoke-WebRequest -Uri "$url/login" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch { }
    Start-Sleep -Seconds 1
  }
  $false
}
Step 'Checking the web UI'
$local = Test-Answers "http://127.0.0.1:$Port"
if ($local) { Write-Host "    answers on 127.0.0.1:$Port" } else { Write-Host "    nothing answers on 127.0.0.1:$Port yet: see $logs\serve.log" }
if ($PublicUrl) {
  if (Test-Answers $PublicUrl.TrimEnd('/')) { Write-Host "    answers at $PublicUrl" }
  else { Write-Host "    nothing answers at $PublicUrl`: for Tailscale, run ``tailscale serve --bg $Port`` (or set up your proxy)" }
}
$ownerMade = $false
if ($Owner -and $local) {
  Step "Owner $Owner"
  & (Join-Path $Root 'agentry.cmd') user add $Owner --owner
  if ($LASTEXITCODE) { Write-Host "    if $Owner exists already, ``agentry user reset $Owner`` prints a new link" }
  else { $ownerMade = $true }
}

# The owner account comes first: it signs in to the web UI and manages users, projects and settings.
$next = @()
if (-not $ownerMade) { $next += "Create your owner account first:    agentry user add <name>   (or run setup again with -Owner <name>)
     and open the passkey link it prints on the device that will hold the passkey" }
$next += "Check the platform layer:      powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -SelfTest"
$next += "Add this key to each repository Agentry pushes to, as a deploy key with write access:
       $publicKey"
$next += "Clone each repository (run setup again with -Clone <ssh url>), point its recipe's `"repo`" at $Root\repos\<name>,
     and register it:                 agentry project add <name> <recipe.json>"
if (-not $hasToken) { $next += "Save a Claude account (from ``claude setup-token``):  agentry token claude <name>
     then start the runner:            Start-ScheduledTask '$($tasks.run)'" }
Write-Host "`nDone. Agentry is in $Root; the web UI listens on 127.0.0.1:$Port (task '$($tasks.serve)').`nNext:"
for ($i = 0; $i -lt $next.Count; $i++) { Write-Host "  $($i + 1). $($next[$i])" }
Write-Host "In a new shell, ``agentry`` runs $Root\agentry.cmd. Open the web UI at $(if ($PublicUrl) { $PublicUrl } else { "http://localhost:$Port" })."
