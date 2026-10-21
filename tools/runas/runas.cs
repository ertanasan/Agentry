// agentry-runas: how the Windows runner starts every step and git command (winhost review D8). It starts the command
// suspended inside a new job object (kill on close, optional memory and CPU caps), resumes it and waits; its exit code
// is the command's. Killing this helper closes the job, which kills the whole process tree, so its pid stands for the
// tree the way a process group does on the Mac.
//
//   agentry-runas [--memory-mb N] [--cpu-percent N] [--sandbox <user> <password-file> <scratch-dir>] -- <program> [args]
//
// The command gets this helper's environment, working directory and standard handles. With --sandbox it runs as that
// user (CreateProcessWithLogonW, proven by the isolation spike). That API takes at most 1024 characters of command
// line, so the helper starts a copy of itself as the user (`--inner <file>`, the working directory and the full command
// line in a file in scratch-dir) and the copy starts the command. Both are in the job. The copy sets the working
// directory itself: the one given to CreateProcessWithLogonW does not reach the command. A process started as another user from a
// non-interactive logon dies with 0xC0000142 unless that user may use the runner's window station and desktop, so
// the helper grants that first.
//
// Built by setup/windows-setup.ps1 with the C# compiler that ships with Windows:
//   csc /nologo /optimize /out:agentry-runas.exe runas.cs
// Exit code 125: the helper itself failed (the reason is on stderr).
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class RunAs {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct EXT_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)]
  struct CPU_RATE { public uint ControlFlags, CpuRate; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessWithLogonW(string user, string domain, string password, int logonFlags, string app, StringBuilder cmd, int flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref CPU_RATE info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr proc, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
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

  const int CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_DEFAULT_ERROR_MODE = 0x04000000, CREATE_NO_WINDOW = 0x08000000;
  const int STARTF_USESTDHANDLES = 0x100, LOGON_WITH_PROFILE = 1;
  const uint KILL_ON_JOB_CLOSE = 0x2000, JOB_MEMORY = 0x200, DIE_ON_UNHANDLED_EXCEPTION = 0x400;
  const uint READ_CONTROL_WRITE_DAC = 0x00060000, INFINITE = 0xFFFFFFFF;
  const int HELPER_FAILED = 125;

  static int Main(string[] args) {
    try {
      if (args.Length == 2 && args[0] == "--inner") return Inner(args[1]);
      return Outer(args);
    } catch (Exception e) {
      Console.Error.WriteLine("agentry-runas: " + e.Message);
      return HELPER_FAILED;
    }
  }

  static int Outer(string[] args) {
    ulong memoryMb = 0; uint cpuPercent = 0;
    string user = null, passwordFile = null, scratch = null;
    int i = 0;
    for (; i < args.Length && args[i] != "--"; i++) {
      if (args[i] == "--memory-mb") memoryMb = ulong.Parse(args[++i]);
      else if (args[i] == "--cpu-percent") cpuPercent = uint.Parse(args[++i]);
      else if (args[i] == "--sandbox") { user = args[++i]; passwordFile = args[++i]; scratch = args[++i]; }
      else throw new ArgumentException("unknown option " + args[i]);
    }
    if (i + 1 >= args.Length) throw new ArgumentException("usage: agentry-runas [--memory-mb N] [--cpu-percent N] [--sandbox <user> <password-file> <scratch-dir>] -- <program> [args]");
    var command = new List<string>();
    for (i++; i < args.Length; i++) command.Add(args[i]);
    string commandLine = CommandLine(command);

    IntPtr job = Job(memoryMb, cpuPercent);
    PROCESS_INFORMATION pi;
    string cmdFile = null;
    if (user == null) {
      pi = Start(commandLine, null, CREATE_SUSPENDED);
    } else {
      cmdFile = Path.Combine(scratch, "runas-" + System.Diagnostics.Process.GetCurrentProcess().Id + ".cmd.txt");
      File.WriteAllText(cmdFile, Environment.CurrentDirectory + "\n" + commandLine, new UTF8Encoding(false));
      string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
      var si = StdHandles();
      si.lpDesktop = ShareDesktop(user);
      IntPtr env = EnvironmentBlock();
      try {
        if (!CreateProcessWithLogonW(user, ".", File.ReadAllText(passwordFile).Trim(), LOGON_WITH_PROFILE, null,
            new StringBuilder(CommandLine(new List<string> { self, "--inner", cmdFile })),
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_DEFAULT_ERROR_MODE, env,
            Environment.CurrentDirectory, ref si, out pi))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "starting the step as " + user + " failed");
      } finally { Marshal.FreeHGlobal(env); }
    }
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
      int e = Marshal.GetLastWin32Error();
      TerminateProcess(pi.hProcess, HELPER_FAILED);
      throw new Win32Exception(e, "putting the step in its job object failed");
    }
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hProcess);
    CloseHandle(job); // kills whatever the command left running
    if (cmdFile != null) try { File.Delete(cmdFile); } catch { }
    return (int)code;
  }

  // Started as the sandbox user, already in the job: starts the command (which inherits the job) and waits.
  static int Inner(string cmdFile) {
    string text = File.ReadAllText(cmdFile, Encoding.UTF8);
    int nl = text.IndexOf('\n');
    var pi = Start(text.Substring(nl + 1), text.Substring(0, nl), 0);
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    return (int)code;
  }

  // The command with this process's environment and standard handles, in cwd (null: this process's directory).
  static PROCESS_INFORMATION Start(string commandLine, string cwd, int flags) {
    var si = StdHandles();
    PROCESS_INFORMATION pi;
    if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
        flags | CREATE_NO_WINDOW | CREATE_DEFAULT_ERROR_MODE, IntPtr.Zero, cwd, ref si, out pi))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "starting " + commandLine.Split(' ')[0] + " failed");
    return pi;
  }

  static STARTUPINFO StdHandles() {
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
    return si;
  }

  static IntPtr Job(ulong memoryMb, uint cpuPercent) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "creating a job object failed");
    var lim = new EXT_LIMIT();
    lim.Basic.LimitFlags = KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION;
    if (memoryMb > 0) { lim.Basic.LimitFlags |= JOB_MEMORY; lim.JobMemoryLimit = (UIntPtr)(memoryMb * 1024 * 1024); }
    if (!SetInformationJobObject(job, 9, ref lim, Marshal.SizeOf(lim)))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "setting the job's limits failed");
    if (cpuPercent > 0) {
      var cpu = new CPU_RATE { ControlFlags = 0x1 | 0x4, CpuRate = cpuPercent * 100 }; // enable, hard cap; in 1/100 %
      if (!SetInformationJobObject(job, 15, ref cpu, Marshal.SizeOf(cpu)))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "setting the job's CPU cap failed");
    }
    return job;
  }

  // This process's environment as a Unicode block, sorted as Windows expects.
  static IntPtr EnvironmentBlock() {
    var names = new List<string>();
    var vars = Environment.GetEnvironmentVariables();
    foreach (DictionaryEntry e in vars) names.Add((string)e.Key);
    names.Sort(StringComparer.OrdinalIgnoreCase);
    var sb = new StringBuilder();
    foreach (var n in names) sb.Append(n).Append('=').Append((string)vars[n]).Append('\0');
    sb.Append('\0');
    return Marshal.StringToHGlobalUni(sb.ToString());
  }

  // The usual Windows quoting, which CommandLineToArgvW and the C runtime undo.
  static string CommandLine(List<string> args) {
    var sb = new StringBuilder();
    foreach (var a in args) {
      if (sb.Length > 0) sb.Append(' ');
      if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) { sb.Append(a); continue; }
      sb.Append('"');
      for (int i = 0; ; i++) {
        int slashes = 0;
        while (i < a.Length && a[i] == '\\') { slashes++; i++; }
        if (i == a.Length) { sb.Append('\\', slashes * 2); break; }
        if (a[i] == '"') sb.Append('\\', slashes * 2 + 1).Append('"');
        else sb.Append('\\', slashes).Append(a[i]);
      }
      sb.Append('"');
    }
    return sb.ToString();
  }

  // Lets `user` use this process's window station and desktop (once per logon session) and names them for
  // STARTUPINFO.lpDesktop. A non-admin cannot create a window station of its own.
  static string ShareDesktop(string user) {
    string sid = new System.Security.Principal.NTAccount(user).Translate(typeof(System.Security.Principal.SecurityIdentifier)).Value;
    string ws = ObjectName(GetProcessWindowStation()), desk = ObjectName(GetThreadDesktop(GetCurrentThreadId()));
    Allow(OpenWindowStation(ws, false, READ_CONTROL_WRITE_DAC), "window station " + ws, sid, 0x000F037F);  // WINSTA_ALL_ACCESS
    Allow(OpenDesktop(desk, 0, false, READ_CONTROL_WRITE_DAC), "desktop " + desk, sid, 0x000F01FF);        // DESKTOP_ALL_ACCESS
    return ws + "\\" + desk;
  }

  static string ObjectName(IntPtr h) {
    var buf = new StringBuilder(256); int needed;
    if (!GetUserObjectInformation(h, 2, buf, buf.Capacity * 2, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error(), "naming the window station or desktop failed");
    return buf.ToString();
  }

  // Adds an allow ACE for sid to a window station or desktop, unless it has one already.
  static void Allow(IntPtr h, string what, string sid, uint access) {
    if (h == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "opening " + what + " to change its access failed");
    IntPtr dacl, sd, text;
    int e = GetSecurityInfo(h, 7, 4, IntPtr.Zero, IntPtr.Zero, out dacl, IntPtr.Zero, out sd);
    if (e != 0) throw new Win32Exception(e, "reading the access list of " + what + " failed");
    if (!ConvertSecurityDescriptorToStringSecurityDescriptor(sd, 1, 4, out text, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "reading the access list of " + what + " failed");
    string ace = "(A;;0x" + access.ToString("X") + ";;;" + sid + ")";
    string sddl = Marshal.PtrToStringUni(text);
    if (sddl.IndexOf(";;;" + sid + ")", StringComparison.OrdinalIgnoreCase) >= 0) return;
    IntPtr nsd, ndacl; bool present, defaulted;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl + ace, 1, out nsd, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "building the access list of " + what + " failed");
    GetSecurityDescriptorDacl(nsd, out present, out ndacl, out defaulted);
    e = SetSecurityInfo(h, 7, 4, IntPtr.Zero, IntPtr.Zero, ndacl, IntPtr.Zero);
    if (e != 0) throw new Win32Exception(e, "writing the access list of " + what + " failed");
  }
}
