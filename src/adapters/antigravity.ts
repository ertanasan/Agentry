import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTail, runStep } from "../proc.ts";
import type { Reply } from "./claude.ts";
import type { StepIO } from "./types.ts";
import { googleEnvironment, googleReply, oauthCredentials, type GoogleOptions } from "./google.ts";

// Windows generic credentials store UTF-8 secret bytes. This touches only Antigravity's named entry,
// in the calling identity's credential store. During runs that identity is AgentrySandbox, never the owner.
export const KEYRING_SOURCE = `using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AgentryAntigravityCredential {
  const string Target = "gemini:antigravity";
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Credential {
    public uint Flags, Type; public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist, AttributeCount; public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredWrite(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  public static string Read() {
    IntPtr pointer;
    if (!CredRead(Target, 1, 0, out pointer)) throw new Exception("No saved Antigravity Google login in this Windows account");
    try {
      var cred = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      var bytes = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, bytes, 0, bytes.Length);
      return Encoding.UTF8.GetString(bytes);
    } finally { CredFree(pointer); }
  }
  public static void Write(string secret) {
    var bytes = Encoding.UTF8.GetBytes(secret);
    var buffer = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, buffer, bytes.Length);
      var cred = new Credential { Type=1, TargetName=Target, UserName="antigravity", CredentialBlobSize=(uint)bytes.Length, CredentialBlob=buffer, Persist=2 };
      if (!CredWrite(ref cred, 0)) throw new Exception("Cannot provision Antigravity sandbox login");
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static void Delete() { CredDelete(Target, 1, 0); }
}`;

export function antigravityCredentials(raw: string): string {
  let data: any;
  try { data = JSON.parse(raw); } catch { throw new Error("Invalid Antigravity OAuth credential JSON"); }
  oauthCredentials(JSON.stringify(data?.token ?? data));
  if (data?.type === "service_account" || data?.api_key || data?.GEMINI_API_KEY) throw new Error("API keys are not supported");
  return JSON.stringify(data);
}

export function importAntigravityLogin(): string {
  if (process.platform !== "win32") throw new Error("Importing an Antigravity login currently requires Windows");
  // No shell interpolation of secret data. The only stdout is captured in memory, never logged.
  const script = `Add-Type -TypeDefinition @'\n${KEYRING_SOURCE}\n'@\n[Console]::Write([AgentryAntigravityCredential]::Read())`;
  const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (r.exitCode !== 0) throw new Error("Sign in to agy with your free Google account in this Windows account first, then retry the import");
  return antigravityCredentials(r.stdout.toString().trim());
}

export const ANTIGRAVITY_BOOTSTRAP = `$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSCommandPath
Add-Type -Path (Join-Path $dir 'keyring.cs')
$launch = Get-Content -LiteralPath (Join-Path $dir 'launch.json') -Raw | ConvertFrom-Json
$code = 1
try {
  [AgentryAntigravityCredential]::Write([IO.File]::ReadAllText((Join-Path $dir 'oauth.json')))
  $agentArgs = @($launch.argv)
  Get-Content -LiteralPath (Join-Path $dir 'prompt.jsonl') | & $launch.bin @agentArgs
  $code = $LASTEXITCODE
} finally { [AgentryAntigravityCredential]::Delete() }
exit $code
`;

// Windows workers share AgentrySandbox's credential store. Serialize Antigravity calls so provisioning,
// refresh and cleanup cannot overwrite another call's credentials. Other providers may still run in parallel.
let pending: Promise<void> = Promise.resolve();
export async function callAntigravity(o: GoogleOptions, io: StepIO, prompt: string, readOnly = false): Promise<Reply> {
  const before = pending;
  let release!: () => void;
  pending = new Promise<void>((r) => { release = r; });
  await before;
  let tokenPath: string | undefined;
  try {
    if (process.platform !== "win32") return { ok: false, detail: "Antigravity free-account token access currently requires the Windows sandbox keyring integration" };
    if (!io.sandbox.wrap.includes("--sandbox")) return { ok: false, detail: "Antigravity requires Agentry's dedicated sandbox account" };
    const home = join(io.sandbox.env.TMPDIR, `antigravity-${process.hrtime.bigint()}`);
    const config = join(home, ".gemini", "antigravity-cli");
    mkdirSync(config, { recursive: true });
    tokenPath = join(home, "oauth.json");
    writeFileSync(tokenPath, antigravityCredentials(readFileSync(o.authFile, "utf8")), { mode: 0o600 });
    writeFileSync(join(config, "settings.json"), JSON.stringify({ enableTelemetry: false,
      permissions: readOnly ? { deny: ["write_file(*)", "command(*)", "mcp(*)"] } : {},
    }));
    writeFileSync(join(home, "keyring.cs"), KEYRING_SOURCE);
    writeFileSync(join(home, "run.ps1"), ANTIGRAVITY_BOOTSTRAP);
    writeFileSync(join(home, "prompt.jsonl"), JSON.stringify({ event: "user", message: { content: prompt } }) + "\n");
    writeFileSync(join(home, "launch.json"), JSON.stringify({ bin: o.bin,
      argv: ["--input-format", "stream-json", "--output-format", "stream-json",
        ...(readOnly ? ["--mode", "plan"] : ["--dangerously-skip-permissions"]), ...(o.model ? ["--model", o.model] : [])] }));
    const env = googleEnvironment(io.sandbox.env, home);
    const r = await runStep(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(home, "run.ps1")],
      { cwd: io.worktree, logPath: io.logPath, timeoutMs: io.timeoutMs, wrap: io.sandbox.wrap, env, onStart: io.onStart });
    return r.timedOut ? { ok: false, detail: "antigravity timed out" } : googleReply(readTail(io.logPath, 4 * 1024 * 1024), r.exitCode, "antigravity");
  } catch {
    return { ok: false, detail: "Antigravity CLI could not run. Set AGENTRY_ANTIGRAVITY_BIN and import your free Google login with agentry token antigravity --from-login." };
  } finally {
    if (tokenPath) { try { unlinkSync(tokenPath); } catch { /* missing */ } }
    release();
  }
}
