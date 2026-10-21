# Runs the agentry CLI on Windows with the environment setup/windows-setup.ps1 chose (in <root>\agentry-env.ps1):
#   C:\Agentry\agentry.cmd <command> [args]          what an administrator types (setup writes agentry.cmd)
#   ... -Log C:\Agentry\logs\run.log run             what the startup tasks run, as AgentryRunner
# `run` and `serve` belong to the startup tasks: started by hand they would run as you, not as AgentryRunner.
# No param block: a named -Log would also bind by position, and an advanced script would take --all for a parameter.
$ErrorActionPreference = 'Stop'
$Log = ''
$Rest = @($args)
if ($Rest.Count -ge 2 -and $Rest[0] -eq '-Log') { $Log = $Rest[1]; $Rest = @($Rest | Select-Object -Skip 2) }
$root = Split-Path (Split-Path $PSScriptRoot)  # <root>\app\setup -> <root>
. (Join-Path $root 'agentry-env.ps1')
$bun = Join-Path $root 'bin\bun.exe'
$cli = Join-Path $root 'app\src\cli.ts'
if ($Log) {
  # cmd's redirection appends the bytes as they come; PowerShell 5.1's would re-encode them as UTF-16.
  cmd /c "`"$bun`" `"$cli`" $($Rest -join ' ') >> `"$Log`" 2>&1"
} else {
  & $bun $cli @Rest
}
exit $LASTEXITCODE
