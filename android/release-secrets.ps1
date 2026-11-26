<#
  One-time setup for automatic Android releases (.github/workflows/android.yml). Puts the upload
  key, its password and the Play service account's key into the GitHub repository's secrets, where
  only that workflow can use them. Run it yourself, in a terminal:

    .\android\release-secrets.ps1 -ServiceAccountKey "$HOME\Downloads\<the downloaded key>.json"

  It checks the password with keytool first, then asks for it once more at GitHub's own prompt.
  Nothing is shown, and nothing is saved on this computer.
#>
param(
    [Parameter(Mandatory = $true)][string]$ServiceAccountKey,
    [string]$Repo = "chirayupatel9/spine",
    [string]$Keystore = (Join-Path $PSScriptRoot "upload.keystore"),
    [string]$Keytool = "C:\Program Files\Java\jdk-17\bin\keytool.exe"
)
$ErrorActionPreference = "Stop"

$key = Get-Content -Raw $ServiceAccountKey | ConvertFrom-Json
if ($key.type -ne "service_account" -or -not $key.client_email) { throw "$ServiceAccountKey isn't a service account's JSON key." }
if (-not (Test-Path $Keystore)) { throw "No upload key at $Keystore" }

gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Sign in to GitHub first:"
    gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) { throw "Not signed in to GitHub." }
}

Write-Host "`nThe upload key's password, to check it opens the key:"
& $Keytool -list -keystore $Keystore > $null
if ($LASTEXITCODE -ne 0) { throw "That password doesn't open $Keystore. Nothing was changed." }

[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path $Keystore))) | gh secret set ANDROID_KEYSTORE_BASE64 --repo $Repo
if ($LASTEXITCODE -ne 0) { throw "Couldn't save the upload key." }
Write-Host "`nNow the same password again, at GitHub's prompt:"
gh secret set ANDROID_KEYSTORE_PASSWORD --repo $Repo
if ($LASTEXITCODE -ne 0) { throw "Couldn't save the password." }
Get-Content -Raw $ServiceAccountKey | gh secret set PLAY_SERVICE_ACCOUNT_JSON --repo $Repo
if ($LASTEXITCODE -ne 0) { throw "Couldn't save the service account's key." }

Write-Host "`nDone. The release workflow can sign and publish now."
Write-Host "Play Console must let this service account release: $($key.client_email)"
if ((Read-Host "Delete the downloaded key file now? GitHub has it (y/N)") -match '^[yY]') {
    Remove-Item $ServiceAccountKey
    Write-Host "Deleted $ServiceAccountKey"
}
