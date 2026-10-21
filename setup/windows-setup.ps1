# Sets up a standalone Agentry (web UI and runner, own database) on Windows (winhost review T7). Run it in an elevated
# Windows PowerShell; it is safe to run again (it updates Agentry and resets the two accounts' passwords). Example:
#   powershell -ExecutionPolicy Bypass -File windows-setup.ps1 -GitName 'Agentry' -GitEmail 'agentry@example.com' `
#     -PublicUrl 'https://myhost.tailnet.ts.net' -DeployFolders 'C:\Sites\MyApp' -DeployServices 'MyApp' -SqlInstances '.\SQLEXPRESS'
#   ... -Clone 'git@github.com:me/MyApp.git'        once the printed deploy key is on the repository
#   powershell -ExecutionPolicy Bypass -File windows-setup.ps1 -SelfTest      only run test/windows.test.ts as AgentryRunner
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
  [switch]$SelfTest
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

# 2. Folders. <root> lets nobody but the two accounts in; the sandbox only reads app and bin.
Step "Folders under $Root"
foreach ($d in $Root, $app, $bin, $home_, (Join-Path $Root 'repos'), $logs) { New-Item -ItemType Directory -Force $d | Out-Null }
icacls $Root /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' "${runner}:(OI)(CI)RX" /Q | Out-Null; Assert-Exit "icacls $Root"
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
icacls $ssh /inheritance:r /grant:r "${runner}:(OI)(CI)F" 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' /T /Q | Out-Null; Assert-Exit "icacls $ssh"
icacls $ssh /setowner $runner /T /Q | Out-Null
$gitSsh = "'$(($gitUsr -replace '\\', '/'))/ssh.exe' -i '$(($key -replace '\\', '/'))' -o IdentitiesOnly=yes -o UserKnownHostsFile='$((Join-Path $ssh 'known_hosts') -replace '\\', '/')' -o StrictHostKeyChecking=yes"

# Clones belong to AgentryRunner, or its git refuses them as another user's ("dubious ownership").
foreach ($url in $Clone) {
  $dest = Join-Path $Root "repos\$([IO.Path]::GetFileNameWithoutExtension(($url -split '[/:]')[-1]))"
  if (Test-Path $dest) { "already cloned: $dest"; continue }
  $env:GIT_SSH_COMMAND = $gitSsh
  git clone --quiet $url $dest; Assert-Exit "git clone $url (is the deploy key on the repository?)"
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
foreach ($i in $SqlInstances) {
  $login = "$env:COMPUTERNAME\$sandbox"
  $c = New-Object System.Data.SqlClient.SqlConnection "Server=$i;Integrated Security=true;Connect Timeout=10"
  $c.Open()
  try {
    $q = $c.CreateCommand()
    $q.CommandText = "IF SUSER_ID(N'$login') IS NULL CREATE LOGIN [$login] FROM WINDOWS; DENY CONNECT SQL TO [$login];"
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

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
foreach ($cmd in 'run', 'serve') {
  $name = $tasks[$cmd]
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $name; Unregister-ScheduledTask -TaskName $name -Confirm:$false }
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
$hasToken = Test-Path (Join-Path $home_ 'claude-oauth-token')
if ($hasToken) { Start-ScheduledTask -TaskName $tasks.run }

Write-Host @"

Done. Agentry is in $Root; the web UI listens on 127.0.0.1:$Port (task '$($tasks.serve)').
Next:
  1. Check the platform layer:      powershell -ExecutionPolicy Bypass -File "$PSCommandPath" -SelfTest
  2. Add this key to each repository Agentry pushes to, as a deploy key with write access:
       $publicKey
  3. Clone each repository (run setup again with -Clone <ssh url>), point its recipe's "repo" at $Root\repos\<name>,
     and register it:                 $Root\agentry.cmd project add <name> <recipe.json>
$(if (-not $hasToken) { "  4. Save a claude token (from ``claude setup-token``):  $Root\agentry.cmd token
     then start the runner:            Start-ScheduledTask '$($tasks.run)'" })
  5. Create your account:              $Root\agentry.cmd user add <name> --owner
"@
