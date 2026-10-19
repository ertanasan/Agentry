# Isolation spike for the Windows runner (winhost review T5 / D5). Run once on winhost in an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File setup\spike\winhost-spike.ps1          (removes what it created)
#   powershell -ExecutionPolicy Bypass -File setup\spike\winhost-spike.ps1 -Keep    (leaves it for a look)
#
# It creates two throwaway standard users (AgentrySpikeRunner, AgentrySpikeSandbox), a folder C:\AgentrySpike,
# a per-user outbound firewall rule for the sandbox user (ports 47470 and 1433), a TCP listener on
# 127.0.0.1:47470 and a scheduled task that runs spike-inner.ps1 as AgentrySpikeRunner: non-admin and
# non-interactive, like the real runner service. It never stops, starts or changes VocaTrain's services or
# anything under C:\Sites; it only checks whether the sandbox user can READ production config.
# Results: a table here and C:\AgentrySpike\result.json. Send the table back; every row should say OK.
param([switch]$Keep)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this in an elevated PowerShell (Run as administrator).'
}
$dir = 'C:\AgentrySpike'
$runner = 'AgentrySpikeRunner'
$sandbox = 'AgentrySpikeSandbox'
$rule = 'Agentry spike: block sandbox user'
$task = 'AgentrySpike'
$pw = { -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ }) + '!a9' }

function Cleanup {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  foreach ($u in $runner, $sandbox) {
    if (Get-LocalUser $u -ErrorAction SilentlyContinue) {
      $sid = (Get-LocalUser $u).SID.Value
      Remove-LocalUser $u
      Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } | Remove-CimInstance -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
}

Cleanup
$listener = $null
try {
  # Accounts (standard users, not administrators).
  $runnerPw = & $pw; $sandboxPw = & $pw
  New-LocalUser $runner -Password (ConvertTo-SecureString $runnerPw -AsPlainText -Force) -PasswordNeverExpires -Description 'Agentry spike' | Out-Null
  New-LocalUser $sandbox -Password (ConvertTo-SecureString $sandboxPw -AsPlainText -Force) -PasswordNeverExpires -Description 'Agentry spike' | Out-Null
  Add-LocalGroupMember Users $runner, $sandbox -ErrorAction SilentlyContinue
  $sandboxSid = (Get-LocalUser $sandbox).SID.Value

  # Folders: the runner owns the spike folder; the sandbox may write only to out\ and is denied secret\.
  New-Item -ItemType Directory -Force "$dir\out", "$dir\secret" | Out-Null
  Copy-Item (Join-Path $PSScriptRoot 'spike-inner.ps1') $dir
  Set-Content "$dir\secret\secret.txt" 'not for the sandbox'
  icacls $dir /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "${runner}:(OI)(CI)F" "${sandbox}:(RX)" | Out-Null
  icacls "$dir\out" /grant "${sandbox}:(OI)(CI)M" | Out-Null
  icacls "$dir\secret" /deny "${sandbox}:(OI)(CI)R" | Out-Null
  Set-Content "$dir\sandbox.pw" $sandboxPw
  icacls "$dir\sandbox.pw" /inheritance:r /grant:r "${runner}:R" "Administrators:F" | Out-Null

  # Per-user outbound block for the sandbox user (the plan's D8 and the SQL port).
  New-NetFirewallRule -DisplayName $rule -Direction Outbound -Action Block -Protocol TCP -RemotePort 47470, 1433 `
    -LocalUser "O:LSD:(A;;CC;;;$sandboxSid)" | Out-Null

  # A listener standing in for the Agentry server on 127.0.0.1.
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 47470)
  $listener.Start()

  # Secondary Logon is what CreateProcessWithLogonW uses.
  $seclogon = Get-Service seclogon
  if ($seclogon.StartType -eq 'Disabled') { Write-Warning 'Secondary Logon (seclogon) is disabled: run-as will fail.' }

  # Run the inner checks as the runner account, non-interactively.
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$dir\spike-inner.ps1`" -Dir `"$dir`""
  Register-ScheduledTask -TaskName $task -Action $action -User $runner -Password $runnerPw -RunLevel Limited | Out-Null
  Start-ScheduledTask -TaskName $task
  # A new account's first logon builds its profile, so the task can sit queued a while before it runs: wait until it
  # has run and finished, not just until it is no longer running.
  $notFinished = 0x41301, 0x41303, 0x41325  # running, has not run yet, queued
  $deadline = (Get-Date).AddMinutes(4)
  do {
    Start-Sleep -Seconds 2
    $state = (Get-ScheduledTask -TaskName $task).State
    $info = Get-ScheduledTaskInfo -TaskName $task
  } while (($state -in 'Running', 'Queued' -or $notFinished -contains $info.LastTaskResult) -and (Get-Date) -lt $deadline)

  if (-not (Test-Path "$dir\result.json")) {
    $code = '0x{0:X}' -f $info.LastTaskResult
    $hint = switch ($code) {
      '0x41303' { "the task never started in 4 minutes: check that $runner may 'Log on as a batch job' (secpol.msc, Local Policies, User Rights Assignment)" }
      '0x8007052E' { 'the runner account could not log on (bad user name or password)' }
      '0x80070569' { "$runner lacks the 'Log on as a batch job' right" }
      default { 'see Task Scheduler history for the task' }
    }
    $events = try {
      Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 200 -ErrorAction Stop |
        Where-Object { $_.Message -match $task } | Select-Object -First 5 | ForEach-Object { "  $($_.TimeCreated) [$($_.Id)] $($_.Message)" }
    } catch { '  (Task Scheduler history is off)' }
    throw "The inner checks wrote no result: task state $state, result $code ($hint).`n$($events -join "`n")"
  }
  $results = Get-Content "$dir\result.json" -Raw | ConvertFrom-Json
  "`nAgentry isolation spike on $env:COMPUTERNAME ($((Get-CimInstance Win32_OperatingSystem).Caption), build $([Environment]::OSVersion.Version.Build))"
  $results.PSObject.Properties | ForEach-Object { [pscustomobject]@{ Check = $_.Name; Result = $(if ($_.Value.ok) { 'OK' } else { 'FAIL' }); Detail = $_.Value.detail } } |
    Format-Table -AutoSize -Wrap
  "Raw results: $dir\result.json"
} finally {
  if ($listener) { $listener.Stop() }
  if ($Keep) { "Kept: users $runner/$sandbox, rule '$rule', task '$task', folder $dir. Run again without -Keep to remove." }
  else { Cleanup; 'Removed the spike users, rule, task and folder.' }
}
