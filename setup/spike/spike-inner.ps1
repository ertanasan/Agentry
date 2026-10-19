# Isolation spike, inner half (winhost review T5 / D5). Runs as the non-admin AgentrySpikeRunner account through a
# scheduled task, the way the real runner service would run. It launches steps as AgentrySpikeSandbox with
# CreateProcessWithLogonW, suspended, inside a Job Object (kill-on-close, memory cap), and records what worked
# in result.json. It never writes outside C:\AgentrySpike.
param([Parameter(Mandatory)][string]$Dir)
$ErrorActionPreference = 'Stop'
$results = [ordered]@{}
function Record($name, $ok, $detail) { $results[$name] = [ordered]@{ ok = $ok; detail = "$detail" } }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
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
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  const int CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000;
  // Starts `cmd` as user, suspended, puts it in a new job (kill on close, optional memory cap), resumes it, waits
  // up to waitMs. Returns "exit=<code>" or "timeout"; the job handle is closed at the end, killing anything left.
  public static string Run(string user, string password, string cmd, string cwd, ulong memoryCapBytes, uint waitMs) {
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si);
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
Record 'whoami_runner' $true (whoami)

# 1. A step runs as AgentrySandbox, in a job object, from a non-admin, non-interactive context.
try {
  $r = [Spike]::Run($sandboxUser, $password, "cmd /c whoami > `"$out\whoami.txt`"", $out, 0, 30000)
  $who = (Get-Content "$out\whoami.txt" -Raw).Trim()
  Record 'runas_in_job' ($r -eq 'exit=0' -and $who -like "*\$sandboxUser") "$r; whoami=$who"
} catch { Record 'runas_in_job' $false $_.Exception.Message }

# 2. A timeout kills the whole process tree when the job closes.
try {
  $marker = "spike-tree-$PID"
  $r = [Spike]::Run($sandboxUser, $password, "cmd /c start /b ping -n 600 127.0.0.1 & ping -n 600 127.0.0.1 & rem $marker", $out, 0, 3000)
  Start-Sleep -Seconds 2
  $left = @(Get-CimInstance Win32_Process -Filter "Name = 'PING.EXE'" | Where-Object { $_.CommandLine -like '*-n 600*' }).Count
  Record 'tree_killed_on_timeout' ($r -eq 'timeout' -and $left -eq 0) "$r; ping processes left: $left"
} catch { Record 'tree_killed_on_timeout' $false $_.Exception.Message }

# 3. The job's memory cap stops a runaway step (256 MB cap, the step asks for 1 GB).
try {
  $alloc = "powershell -NoProfile -Command `"`$a = New-Object byte[] 1GB; 'allocated'`""
  $r = [Spike]::Run($sandboxUser, $password, $alloc, $out, 256MB, 60000)
  Record 'memory_cap' ($r -ne 'exit=0') "$r (anything but exit=0 means the cap held)"
} catch { Record 'memory_cap' $false $_.Exception.Message }

# 4. File access as AgentrySandbox: production config, the spike's deny folder, the runner's profile.
foreach ($t in @(
  @{ name = 'read_sites_config'; path = 'C:\Sites\VocaTrain.Api\current\appsettings.Production.json' },
  @{ name = 'read_denied_folder'; path = (Join-Path $Dir 'secret\secret.txt') },
  @{ name = 'read_runner_profile'; path = "C:\Users\AgentrySpikeRunner\NTUSER.DAT" })) {
  try {
    $r = [Spike]::Run($sandboxUser, $password, "cmd /c type `"$($t.path)`" > nul 2>&1", $out, 0, 15000)
    Record $t.name ($r -ne 'exit=0') "$r (blocked = good; exit=0 means AgentrySandbox could read it)"
  } catch { Record $t.name $false $_.Exception.Message }
}

# 5. Network: the per-user outbound rule must block AgentrySandbox from the listener; the runner (control) must connect.
$probe = { param($port) "powershell -NoProfile -Command `"try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1', $port); exit 0 } catch { exit 7 }`"" }
try {
  $r = [Spike]::Run($sandboxUser, $password, (& $probe 47470), $out, 0, 20000)
  Record 'loopback_blocked_for_sandbox' ($r -ne 'exit=0') "$r (exit=0 means the sandbox reached 127.0.0.1:47470 despite the rule)"
} catch { Record 'loopback_blocked_for_sandbox' $false $_.Exception.Message }
try {
  $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 47470); $c.Close()
  Record 'loopback_control_runner' $true 'runner connected (control)'
} catch { Record 'loopback_control_runner' $false $_.Exception.Message }
try {
  $r = [Spike]::Run($sandboxUser, $password, (& $probe 1433), $out, 0, 20000)
  Record 'sql_port_blocked_for_sandbox' ($r -ne 'exit=0') "$r"
} catch { Record 'sql_port_blocked_for_sandbox' $false $_.Exception.Message }

$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Dir 'result.json') -Encoding UTF8
