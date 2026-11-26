<#
  One-time setup for automatic Android releases (.github/workflows/android.yml): puts the upload
  key and its password into the GitHub repository's secrets, where only that workflow can use
  them. Google Play access needs no key (the workflow signs in to Google as a service account).

    pwsh -NoProfile -File .\android\release-secrets.ps1

  It asks for the password once, checks that it opens the key, and hands it straight to GitHub.
  Nothing is shown, and nothing is saved on this computer.
#>
param(
    [string]$Repo = "chirayupatel9/spine",
    [string]$Keystore = (Join-Path $PSScriptRoot "upload.keystore"),
    [string]$Keytool = "C:\Program Files\Java\jdk-17\bin\keytool.exe"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Keystore)) { throw "No upload key at $Keystore" }

# A token in GH_TOKEN would be used instead of your GitHub sign-in (and an old one fails); this
# script ignores it. Your Windows settings stay as they are.
Remove-Item Env:GH_TOKEN, Env:GITHUB_TOKEN -ErrorAction SilentlyContinue

gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "First, sign in to GitHub (it shows a code, then opens github.com to enter it):"
    gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) { throw "Not signed in to GitHub." }
}

# Give gh a secret on its standard input, exactly as is (no line break added).
function Set-RepoSecret([string]$Name, [string]$Value) {
    $psi = [Diagnostics.ProcessStartInfo]::new("gh", "secret set $Name --repo $Repo")
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $p = [Diagnostics.Process]::Start($psi)
    $p.StandardInput.Write($Value)
    $p.StandardInput.Close()
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "Couldn't save $Name." }
}

$secure = Read-Host "`nThe upload key's password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:AV_UPLOAD_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    & $Keytool -list -keystore $Keystore -storepass:env AV_UPLOAD_KEY_PASSWORD *> $null
    if ($LASTEXITCODE -ne 0) { throw "That password doesn't open $Keystore. Nothing was saved; run it again." }
    Set-RepoSecret ANDROID_KEYSTORE_BASE64 ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path $Keystore))))
    Set-RepoSecret ANDROID_KEYSTORE_PASSWORD $env:AV_UPLOAD_KEY_PASSWORD
} finally {
    Remove-Item Env:AV_UPLOAD_KEY_PASSWORD -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
Write-Host "`nDone: GitHub can sign Album Viewer's releases now. You can close this tab."
