#Requires -Version 7
<#
.SYNOPSIS
  Gives a delegate's clone its own GitHub token, for the owner to run in their own terminal.

.DESCRIPTION
  A delegate (see "delegates" in pipeline.config.json) is a separate GitHub account,
  and its Claude Code session must act as that account, not as you. This writes the
  clone's .claude/settings.local.json with the delegate's token, the same git
  credential lines docs/AGENT-TOKEN.md describes for the agent token, and the model
  the session runs on, and keeps that file out of git through .git/info/exclude.

  It prompts for the token without echoing it, and never prints it. Never run this
  from an agent session, and never pass the token on the command line.

.EXAMPLE
  pwsh -File "C:\Development Pipeline\tools\setup-delegate.ps1" -Clone "C:\GIS Workbench\gwb-garden"
#>
[CmdletBinding()]
param(
  # The delegate's own clone. It must be a git working tree.
  [string]$Clone = (Get-Location).Path,
  # The model the delegate's session runs on.
  [string]$Model = 'claude-fable-5-1',
  # Set the clone up as a GitHub App delegate instead of a user account. It asks
  # for the App id and the downloaded private key. See docs/AGENT-TOKEN.md.
  [switch]$App
)

$ErrorActionPreference = 'Stop'
if ($App) {
  & node (Join-Path $PSScriptRoot 'setup-delegate-app.mjs') --clone $Clone --model $Model
  exit $LASTEXITCODE
}
$SettingsRelative = '.claude/settings.local.json'

function Get-GitPath([string]$Root, [string]$Name) {
  $path = (& git -C $Root rev-parse --git-path $Name).Trim()
  if ($LASTEXITCODE -ne 0) { throw "$Root isn't a git working tree." }
  if (-not [System.IO.Path]::IsPathRooted($path)) { $path = Join-Path $Root $path }
  return $path
}

function ConvertFrom-SecureToken([securestring]$Secure) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

# Who the token belongs to, and its scopes. Prints neither the token nor any header
# that carries it.
function Get-TokenIdentity([securestring]$Secure) {
  $plain = ConvertFrom-SecureToken $Secure
  try {
    $response = Invoke-WebRequest -Uri 'https://api.github.com/user' -UseBasicParsing -Headers @{
      Authorization = "token $plain"
      'User-Agent'  = 'dev-pipeline-setup-delegate'
    }
    return [pscustomobject]@{
      Login  = ($response.Content | ConvertFrom-Json).login
      Scopes = (($response.Headers['X-OAuth-Scopes'] | Select-Object -First 1) -as [string])
    }
  } finally { $plain = $null }
}

# Merges the delegate's settings into the clone's local settings, keeping any other
# keys already there, and hides the file from git.
function Write-DelegateSettings([string]$Root, [securestring]$Secure, [string]$ModelName) {
  $settingsPath = Join-Path $Root $SettingsRelative
  New-Item -ItemType Directory -Force (Split-Path $settingsPath) | Out-Null

  # A tracked file would put the token in a commit, and a link would write it
  # wherever the link points. Refuse both.
  & git -C $Root ls-files --error-unmatch -- $SettingsRelative 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "$SettingsRelative is tracked by git in $Root. Untrack it first. Nothing was written." }
  $LASTEXITCODE = 0
  foreach ($path in @((Split-Path $settingsPath), $settingsPath)) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType) { throw "$path is a link ($($item.LinkType)). Nothing was written." }
  }

  $settings = [ordered]@{}
  if (Test-Path $settingsPath) {
    $existing = Get-Content -Raw $settingsPath | ConvertFrom-Json -AsHashtable
    if ($existing) { foreach ($key in $existing.Keys) { $settings[$key] = $existing[$key] } }
  }
  $envBlock = [ordered]@{}
  if ($settings.Contains('env') -and $settings['env']) { foreach ($key in $settings['env'].Keys) { $envBlock[$key] = $settings['env'][$key] } }

  $plain = ConvertFrom-SecureToken $Secure
  try {
    $envBlock['GH_TOKEN'] = $plain
    $envBlock['GIT_CONFIG_COUNT'] = '2'
    $envBlock['GIT_CONFIG_KEY_0'] = 'credential.helper'
    $envBlock['GIT_CONFIG_VALUE_0'] = ''
    $envBlock['GIT_CONFIG_KEY_1'] = 'credential.helper'
    $envBlock['GIT_CONFIG_VALUE_1'] = '!gh auth git-credential'
    $settings['env'] = $envBlock
    $settings['model'] = $ModelName
    $json = $settings | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($settingsPath, "$json`n", (New-Object System.Text.UTF8Encoding $false))
  } finally {
    $plain = $null
    $json = $null
    $envBlock['GH_TOKEN'] = $null
  }

  $exclude = Get-GitPath $Root 'info/exclude'
  New-Item -ItemType Directory -Force (Split-Path $exclude) | Out-Null
  $lines = if (Test-Path $exclude) { Get-Content $exclude } else { @() }
  if ($lines -notcontains $SettingsRelative) { Add-Content -Path $exclude -Value $SettingsRelative }
  return $settingsPath
}

function Invoke-Setup {
  $root = (Resolve-Path $Clone).Path
  Get-GitPath $root 'info/exclude' | Out-Null
  Write-Host "This writes the delegate's token into $root\.claude\settings.local.json."
  Write-Host 'Use a classic token with only the public_repo, workflow and read:org scopes, made on the delegate account.'
  Write-Host 'Make it in a private window or a separate browser profile, and sign out of the delegate afterwards.'
  $secure = Read-Host -AsSecureString -Prompt 'Delegate token (input is hidden)'
  if ($secure.Length -eq 0) { throw 'No token given. Nothing was written.' }

  $identity = Get-TokenIdentity $secure
  Write-Host "The token belongs to $($identity.Login), with scopes: $($identity.Scopes)"
  if ($identity.Scopes -match '(^|,\s*)repo(\s*,|$)' -or $identity.Scopes -match 'admin:|delete_repo') {
    Write-Warning 'That token has more than public_repo, workflow and read:org. Consider making a narrower one.'
  }
  $answer = Read-Host "Write it for $($identity.Login)? (y/N)"
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'Nothing was written.'; return }

  $path = Write-DelegateSettings $root $secure $Model
  Write-Host "Wrote $path, and added it to .git/info/exclude."
  Write-Host 'Check it from your own terminal with: git -C "<clone>" check-ignore -v .claude/settings.local.json'
  Write-Host "Then open the clone in Claude Code, and run: gh api user --jq .login (it should print $($identity.Login))"
}

# Dot-sourcing loads the functions without running the setup, which is how the
# tests reach them.
if ($MyInvocation.InvocationName -ne '.') { Invoke-Setup }
