<#
  Registers a hidden "aidm watcher" scheduled task that starts at logon (no console window).
  It picks up "Kaldığı yerden devam et" requests signed with your passkey in the IdP UI.
  Usage (normal PowerShell, no admin needed):
    powershell -ExecutionPolicy Bypass -File install-aidm-watcher.ps1 -Roots "D:\...\LLMTEST-1" [-StartNow]
  Remove:  Unregister-ScheduledTask -TaskName "aidm-watcher" -Confirm:$false
#>
param([Parameter(Mandatory = $true)][string]$Roots, [switch]$StartNow)
$vbs = Join-Path $PSScriptRoot 'aidm-watcher.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}" "{1}"' -f $vbs, $Roots)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'aidm-watcher' -Action $action -Trigger $trigger -Settings $settings -Description 'OtonomMCP aidm watcher (passkey-signed resume requests)' -Force | Out-Null
Write-Host "aidm-watcher registered (at logon). Log: $env:LOCALAPPDATA\aidm\aidm-watcher.log"
if ($StartNow) { Start-ScheduledTask -TaskName 'aidm-watcher'; Write-Host 'started' }
