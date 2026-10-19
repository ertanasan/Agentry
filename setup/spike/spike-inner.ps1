# Isolation spike, inner half (winhost review T5 / D5). Runs as the non-admin AgentrySpikeRunner account through a
# scheduled task, the way the real runner service would run. It launches steps as AgentrySpikeSandbox with
# CreateProcessWithLogonW, suspended, inside a Job Object (kill-on-close, memory cap), and records what worked
# in result.json. It never writes outside C:\AgentrySpike and the runner's own profile.
# Every check has a control that must succeed, so a step that never started cannot pass as "blocked".
param([Parameter(Mandatory)][string]$Dir, [int]$SitesConfigExists = 0)
$ErrorActionPreference = 'Stop'
$results = [ordered]@{}
function Record($name, $ok, $detail) { $results[$name] = [ordered]@{ ok = [bool]$ok; detail = "$detail" } }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Spike {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct EXT_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessWithLogonW(string user, string domain, string password, int logonFlags, string app, string cmd, int flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, int revision, out IntPtr sd, IntPtr size);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd, int revision, int info, out IntPtr sddl, IntPtr len);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll")] static extern int GetSecurityInfo(IntPtr h, int type, int info, IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll")] static extern int SetSecurityInfo(IntPtr h, int type, int info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenWindowStation(string name, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktop(string name, int flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
  static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder buf, int len, out int needed);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(int threadId);
  [DllImport("kernel32.dll")] static extern int GetCurrentThreadId();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  const int CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000;
  const uint READ_CONTROL_WRITE_DAC = 0x00060000;

  static string ObjectName(IntPtr h) {
    var buf = new StringBuilder(256); int needed;
    if (!GetUserObjectInformation(h, 2, buf, buf.Capacity * 2, out needed)) throw new Exception("GetUserObjectInformation failed: " + Marshal.GetLastWin32Error());
    return buf.ToString();
  }

  // Adds an allow ACE for sid to a window station or desktop (SE_WINDOW_OBJECT) through its SDDL.
  static void Allow(IntPtr h, string what, string sid, uint access) {
    IntPtr dacl, sd, text;
    int e = GetSecurityInfo(h, 7, 4, IntPtr.Zero, IntPtr.Zero, out dacl, IntPtr.Zero, out sd);
    if (e != 0) throw new Exception("reading the access list of " + what + " failed: " + e);
    if (!ConvertSecurityDescriptorToStringSecurityDescriptor(sd, 1, 4, out text, IntPtr.Zero)) throw new Exception("SDDL of " + what + " failed: " + Marshal.GetLastWin32Error());
    string sddl = Marshal.PtrToStringUni(text) + "(A;;0x" + access.ToString("X") + ";;;" + sid + ")";
    IntPtr nsd, ndacl; bool present, defaulted;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out nsd, IntPtr.Zero)) throw new Exception("bad SDDL " + sddl + ": " + Marshal.GetLastWin32Error());
    GetSecurityDescriptorDacl(nsd, out present, out ndacl, out defaulted);
    e = SetSecurityInfo(h, 7, 4, IntPtr.Zero, IntPtr.Zero, ndacl, IntPtr.Zero);
    if (e != 0) throw new Exception("writing the access list of " + what + " failed: " + e);
  }

  // A process started as another user from a non-interactive logon cannot use the runner's window station and desktop
  // (it dies with 0xC0000142), and a non-admin cannot create a window station. So the runner lets the sandbox user
  // into its own. Returns "<station>\\<desktop>" for STARTUPINFO.lpDesktop.
  public static string ShareRunnerDesktop(string sandboxSid) {
    string ws = ObjectName(GetProcessWindowStation()), desk = ObjectName(GetThreadDesktop(GetCurrentThreadId()));
    IntPtr hws = OpenWindowStation(ws, false, READ_CONTROL_WRITE_DAC);
    if (hws == IntPtr.Zero) throw new Exception("opening window station " + ws + " to change its access failed: " + Marshal.GetLastWin32Error());
    Allow(hws, "window station " + ws, sandboxSid, 0x000F037F);  // WINSTA_ALL_ACCESS | standard rights
    IntPtr hd = OpenDesktop(desk, 0, false, READ_CONTROL_WRITE_DAC);
    if (hd == IntPtr.Zero) throw new Exception("opening desktop " + desk + " to change its access failed: " + Marshal.GetLastWin32Error());
    Allow(hd, "desktop " + desk, sandboxSid, 0x000F01FF);  // DESKTOP_ALL_ACCESS | standard rights
    return ws + "\\" + desk;
  }

  // Starts `cmd` as user on `desktopName` (null = inherited), suspended, puts it in a new job (kill on close, optional
  // memory cap), resumes it, waits up to waitMs. Returns "exit=<code>" or "timeout"; closing the job kills what is left.
  public static string Run(string user, string password, string cmd, string cwd, string desktopName, ulong memoryCapBytes, uint waitMs) {
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = desktopName;
    PROCESS_INFORMATION pi;
    if (!CreateProcessWithLogonW(user, ".", password, 1, null, cmd, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi))
      throw new Exception("CreateProcessWithLogonW failed: " + Marshal.GetLastWin32Error());
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    var lim = new EXT_LIMIT(); lim.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
    if (memoryCapBytes > 0) { lim.Basic.LimitFlags |= 0x200; lim.JobMemoryLimit = (UIntPtr)memoryCapBytes; } // JOB_MEMORY
    if (!SetInformationJobObject(job, 9, ref lim, Marshal.SizeOf(lim))) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, pi.hProcess)) throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
    ResumeThread(pi.hThread);
    uint w = WaitForSingleObject(pi.hProcess, waitMs);
    string result;
    if (w == 0) { uint code; GetExitCodeProcess(pi.hProcess, out code); result = "exit=" + code; } else { result = "timeout"; }
    CloseHandle(job); // kills the whole tree when the job closes
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return result;
  }
}
'@

$sandboxUser = 'AgentrySpikeSandbox'
$password = (Get-Content (Join-Path $Dir 'sandbox.pw') -Raw).Trim()
$out = Join-Path $Dir 'out'
$sandboxSid = (New-Object Security.Principal.NTAccount($sandboxUser)).Translate([Security.Principal.SecurityIdentifier]).Value
$desktop = $null
$cantStart = 'exit=3221225794'
function Sandbox([string]$cmd, [uint64]$mem = 0, [uint32]$wait = 30000) { [Spike]::Run($sandboxUser, $password, $cmd, $out, $desktop, $mem, $wait) }
function PsCommand([string]$script) { 'powershell -NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script)) }
function Describe([string]$r) { if ($r -eq $cantStart) { "$r (0xC0000142: the process could not start)" } else { $r } }
Record 'whoami_runner' $true (whoami)

# 1. PowerShell starts as AgentrySandbox: first on the inherited desktop, else on the runner's desktop shared with it.
$r1 = try { Sandbox (PsCommand 'exit 0') } catch { $_.Exception.Message }
$r2 = $null
if ($r1 -ne 'exit=0') {
  $r2 = try {
    $desktop = [Spike]::ShareRunnerDesktop($sandboxSid)
    Sandbox (PsCommand 'exit 0')
  } catch { $desktop = $null; $_.Exception.Message }
}
Record 'powershell_starts' ($r1 -eq 'exit=0' -or $r2 -eq 'exit=0') ("inherited desktop: $(Describe $r1)" + $(if ($r2) { "; shared runner desktop: $(Describe $r2)" }))
Record 'desktop_used' $true $(if ($desktop) { $desktop } else { 'inherited' })

# 2. The tools real steps run start too (they must be on the machine PATH).
foreach ($t in @(@{ name = 'git_starts'; cmd = 'cmd /c git --version' }, @{ name = 'dotnet_starts'; cmd = 'cmd /c dotnet --version' })) {
  $r = try { Sandbox $t.cmd 0 60000 } catch { $_.Exception.Message }
  Record $t.name ($r -eq 'exit=0') (Describe $r)
}

# 3. A step runs as AgentrySandbox, in a job object, from a non-admin, non-interactive context.
try {
  $r = Sandbox "cmd /c whoami > `"$out\whoami.txt`""
  $who = if (Test-Path "$out\whoami.txt") { "$(Get-Content "$out\whoami.txt" -Raw)".Trim() } else { '(no output)' }
  Record 'runas_in_job' ($r -eq 'exit=0' -and $who -like "*\$sandboxUser") "$(Describe $r); whoami=$who"
} catch { Record 'runas_in_job' $false $_.Exception.Message }

# 4. A timeout kills the whole process tree when the job closes.
try {
  $r = Sandbox 'cmd /c start /b ping -n 600 127.0.0.1 & ping -n 600 127.0.0.1' 0 3000
  Start-Sleep -Seconds 2
  $left = @(Get-CimInstance Win32_Process -Filter "Name = 'PING.EXE'" | Where-Object { $_.CommandLine -like '*-n 600*' }).Count
  Record 'tree_killed_on_timeout' ($r -eq 'timeout' -and $left -eq 0) "$r; ping processes left: $left"
} catch { Record 'tree_killed_on_timeout' $false $_.Exception.Message }

# 5. The job's 256 MB memory cap stops a 1 GB allocation; 16 MB under the same cap succeeds.
try {
  # Stop on the failed allocation: by default PowerShell would go on to "exit 0".
  $small = Sandbox (PsCommand '$ErrorActionPreference = ''Stop''; $a = New-Object byte[] 16MB; exit 0') 256MB 60000
  $big = Sandbox (PsCommand '$ErrorActionPreference = ''Stop''; $a = New-Object byte[] 1GB; exit 0') 256MB 60000
  Record 'memory_cap' ($small -eq 'exit=0' -and $big -ne 'exit=0' -and $big -ne $cantStart) "16 MB: $(Describe $small); 1 GB: $(Describe $big)"
} catch { Record 'memory_cap' $false $_.Exception.Message }

# 6. File access as AgentrySandbox. The control file must be readable; the others must not.
Set-Content "$out\allowed.txt" 'the sandbox may read this'
Set-Content "$env:USERPROFILE\spike-secret.txt" 'runner only'
$sites = 'C:\Sites\VocaTrain.Api\current\appsettings.Production.json'
foreach ($t in @(
  @{ name = 'read_allowed_control'; path = "$out\allowed.txt"; want = 0 },
  @{ name = 'read_sites_config'; path = $sites; want = 1 },
  @{ name = 'read_denied_folder'; path = (Join-Path $Dir 'secret\secret.txt'); want = 1 },
  @{ name = 'read_runner_profile'; path = "$env:USERPROFILE\spike-secret.txt"; want = 1 })) {
  try {
    $r = Sandbox "cmd /c type `"$($t.path)`" > nul 2>&1" 0 15000
    $ok = if ($t.want -eq 0) { $r -eq 'exit=0' } else { $r -eq 'exit=1' }
    $note = if ($t.path -eq $sites -and -not $SitesConfigExists) { ' (the file does not exist, so this proves nothing)' } else { '' }
    Record $t.name ($ok -and $note -eq '') "$(Describe $r)$note"
  } catch { Record $t.name $false $_.Exception.Message }
}

# 7. Network: the per-user rule blocks port 47470 for AgentrySandbox; port 47471 (no rule) must connect.
# Probe exit codes: 0 = connected, 7 = connection failed.
$probe = { param($port) PsCommand "try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1', $port); exit 0 } catch { exit 7 }" }
try {
  $r = Sandbox (& $probe 47471)
  Record 'loopback_allowed_control' ($r -eq 'exit=0') "$(Describe $r) (the sandbox must reach 127.0.0.1:47471, which has no rule)"
} catch { Record 'loopback_allowed_control' $false $_.Exception.Message }
try {
  $r = Sandbox (& $probe 47470)
  Record 'loopback_blocked_for_sandbox' ($r -eq 'exit=7') "$(Describe $r) (exit=7 = blocked; exit=0 means the rule did not apply to loopback)"
} catch { Record 'loopback_blocked_for_sandbox' $false $_.Exception.Message }
try {
  $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 47470); $c.Close()
  Record 'loopback_control_runner' $true 'runner connected to 47470 (control)'
} catch { Record 'loopback_control_runner' $false $_.Exception.Message }

# 8. SQL Server: AgentrySandbox must not get in with its Windows login (SQL Express listens on a pipe, not 1433).
# If it does get in, it reports which logins let it in (Windows groups too) and which databases it can open.
$sqlProbe = @'
$ErrorActionPreference = 'Stop'
$c = New-Object System.Data.SqlClient.SqlConnection 'Server=.\SQLEXPRESS;Integrated Security=true;Connect Timeout=10'
try { $c.Open() } catch { $_.Exception.Message | Out-File 'OUT\sql.txt'; exit 7 }
$q = $c.CreateCommand()
$q.CommandText = "SELECT 'as ' + SUSER_NAME() + '; sysadmin=' + CAST(IS_SRVROLEMEMBER('sysadmin') AS varchar(2)) +
  '; via logins: ' + ISNULL((SELECT name + ' ' FROM sys.login_token WHERE principal_id > 0 FOR XML PATH('')), '-') +
  '; databases: ' + ISNULL((SELECT name + ' ' FROM sys.databases WHERE HAS_DBACCESS(name) = 1 FOR XML PATH('')), '-')"
$q.ExecuteScalar() | Out-File 'OUT\sql.txt'
exit 0
'@
try {
  $r = Sandbox (PsCommand $sqlProbe.Replace('OUT', $out)) 0 60000
  $why = if (Test-Path "$out\sql.txt") { "$(Get-Content "$out\sql.txt" -Raw)".Trim() } else { '' }
  $detail = if ($r -eq 'exit=0') { "the sandbox got in: $why" } else { "$(Describe $r); $why" }
  Record 'sql_login_refused_for_sandbox' ($r -eq 'exit=7' -and $why -match 'Login failed') $detail
} catch { Record 'sql_login_refused_for_sandbox' $false $_.Exception.Message }

Remove-Item "$env:USERPROFILE\spike-secret.txt" -ErrorAction SilentlyContinue
$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Dir 'result.json') -Encoding UTF8
