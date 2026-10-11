
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$runtimeDir = $env:JUNE_HERMES_RUNTIME_DIR
$installDir = $env:JUNE_HERMES_INSTALL_DIR
$hermesHome = $env:JUNE_HERMES_HOME
$installCommit = $env:JUNE_HERMES_INSTALL_COMMIT
$sourceTarballUrl = $env:JUNE_HERMES_SOURCE_TARBALL_URL
$sourceTarballSha256 = ($env:JUNE_HERMES_SOURCE_TARBALL_SHA256).ToLowerInvariant()
$uvDownloadUrl = $env:JUNE_HERMES_UV_URL
$uvDownloadSha256 = ($env:JUNE_HERMES_UV_SHA256).ToLowerInvariant()

if ([string]::IsNullOrWhiteSpace($runtimeDir) -or
    [string]::IsNullOrWhiteSpace($installDir) -or
    [string]::IsNullOrWhiteSpace($hermesHome) -or
    [string]::IsNullOrWhiteSpace($uvDownloadUrl)) {
  throw "Hermes installer paths were not provided."
}

New-Item -ItemType Directory -Force -Path $runtimeDir, $hermesHome | Out-Null

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  Write-Output ("running: " + $FilePath + " " + ($Arguments -join " "))
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE"
  }
}

function Get-VerifiedDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Sha256
  )
  Write-Output "downloading: $Uri"
  Invoke-WebRequest -Uri $Uri -OutFile $Destination
  $actual = (Get-FileHash -Algorithm SHA256 -Path $Destination).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) {
    throw "Checksum mismatch for $Uri. Expected $Sha256, got $actual."
  }
}

if (!(Test-Path (Join-Path $installDir "pyproject.toml"))) {
  $tmpDir = Join-Path $runtimeDir ("download-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  try {
    $archive = Join-Path $tmpDir "hermes-agent.tar.gz"
    Get-VerifiedDownload -Uri $sourceTarballUrl -Destination $archive -Sha256 $sourceTarballSha256
    Invoke-Native "tar" @("-xzf", $archive, "-C", $tmpDir)
    $unpacked = Get-ChildItem -Path $tmpDir -Directory |
      Where-Object { $_.Name -like "hermes-agent-*" } |
      Select-Object -First 1
    if ($null -eq $unpacked) {
      throw "Hermes source archive did not contain a hermes-agent directory."
    }
    if (Test-Path $installDir) {
      Remove-Item -Recurse -Force -Path $installDir
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $installDir) | Out-Null
    Move-Item -Path $unpacked.FullName -Destination $installDir
  } finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -Path $tmpDir
  }
}

# Fix the plugins/cron sys.path shadow that 500s the Routines page (mirror of
# scripts/patch-hermes-cron-shadow.sh). The raft and discord platform adapters
# insert hermes-agent/plugins at sys.path[0], so top-level `import cron` finds
# the plugins/cron plugin instead of core cron and every dashboard cron endpoint
# raises ImportError -> HTTP 500. Point the insert at the hermes-agent root
# (parents[3]). Scoped to the two adapters (gateway/platforms/*.py already use
# the root). Idempotent and outside the download guard so retries re-patch.
foreach ($cronShadowRel in @("plugins\platforms\raft\adapter.py", "plugins\platforms\discord\adapter.py")) {
  $cronShadowFile = Join-Path $installDir $cronShadowRel
  if (Test-Path -LiteralPath $cronShadowFile -PathType Leaf) {
    $cronShadowText = Get-Content -LiteralPath $cronShadowFile -Raw
    $cronShadowText = $cronShadowText.Replace("resolve().parents[2]))", "resolve().parents[3]))")
    Set-Content -LiteralPath $cronShadowFile -Value $cronShadowText -NoNewline
  }
}

# Accept the Windows webview origin (http://tauri.localhost) on WebSocket
# upgrades (mirror of scripts/patch-hermes-ws-origin.sh — see it for the root
# cause). The /api/ws DNS-rebinding guard only accepts http(s) Origins whose
# host is in _LOOPBACK_HOST_VALUES; the Windows Tauri webview lives on
# http://tauri.localhost, so every chat WebSocket handshake was refused
# (close 4403 before accept) -> "Could not connect to Hermes gateway."
# *.localhost is loopback-only per RFC 6761, so no rebinding surface is
# added. The leading indentation anchors the match to the frozenset member
# line (an unindented twin inside _local_dashboard_request must stay
# untouched). Idempotent via the tauri.localhost guard; outside the download
# guard so retries re-patch an existing tree.
$wsOriginFile = Join-Path $installDir "hermes_cli\web_server.py"
if (Test-Path -LiteralPath $wsOriginFile -PathType Leaf) {
  $wsOriginText = Get-Content -LiteralPath $wsOriginFile -Raw
  if (!$wsOriginText.Contains('"tauri.localhost"')) {
    $wsOriginText = $wsOriginText.Replace('    "localhost", "127.0.0.1", "::1",', '    "localhost", "127.0.0.1", "::1", "tauri.localhost",')
    Set-Content -LiteralPath $wsOriginFile -Value $wsOriginText -NoNewline
  }
}

# Give this Hermes home its own gateway service (mirror of
# scripts/patch-hermes-service-label.sh, see it for the root cause): any home
# outside %LOCALAPPDATA%\hermes counted as the default root and claimed the
# bare Hermes_Gateway task, so Sub Rosa's homes and a standalone Hermes took
# over one another's gateway. Only the first `if home == default:` inside
# _profile_suffix (_profile_arg has the same line). Read and written as UTF-8
# without BOM: gateway.py holds non-ASCII text a default encoding would mangle.
$serviceLabelFile = Join-Path $installDir "hermes_cli\gateway.py"
if (Test-Path -LiteralPath $serviceLabelFile -PathType Leaf) {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $serviceLabelText = [System.IO.File]::ReadAllText($serviceLabelFile, $utf8)
  if (!$serviceLabelText.Contains("patch-hermes-service-label")) {
    $serviceLabelBad = "`n    if home == default:"
    $serviceLabelGood = "`n    # Sub Rosa (patch-hermes-service-label.sh): only the platform home is the default." +
      "`n    from hermes_constants import _get_platform_default_hermes_home" +
      "`n    if home == default and home == _get_platform_default_hermes_home().resolve():"
    $fnAt = $serviceLabelText.IndexOf("`ndef _profile_suffix() -> str:")
    $lineAt = -1
    $nextFnAt = -1
    if ($fnAt -ge 0) {
      $lineAt = $serviceLabelText.IndexOf($serviceLabelBad, $fnAt, [System.StringComparison]::Ordinal)
      $nextFnAt = $serviceLabelText.IndexOf("`ndef ", $fnAt + 1, [System.StringComparison]::Ordinal)
    }
    if ($lineAt -lt 0 -or ($nextFnAt -ge 0 -and $lineAt -gt $nextFnAt)) {
      throw "gateway.py: expected _profile_suffix default-root test not found - upstream changed, re-audit the service-label fix."
    }
    $serviceLabelText = $serviceLabelText.Substring(0, $lineAt) + $serviceLabelGood +
      $serviceLabelText.Substring($lineAt + $serviceLabelBad.Length)
    [System.IO.File]::WriteAllText($serviceLabelFile, $serviceLabelText, $utf8)
  }
}

# Bootstrap a self-contained uv + CPython inside the runtime dir. End-user
# Windows machines have no Python (and no compiler toolchain), so the install
# must bring its own interpreter the same way the release bundle does.
$uvDir = Join-Path $runtimeDir "uv"
$uvExe = Join-Path $uvDir "uv.exe"
if (!(Test-Path $uvExe)) {
  $uvTmp = Join-Path $runtimeDir ("uv-download-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $uvTmp | Out-Null
  try {
    $uvArchive = Join-Path $uvTmp "uv.zip"
    Get-VerifiedDownload -Uri $uvDownloadUrl -Destination $uvArchive -Sha256 $uvDownloadSha256
    Expand-Archive -Path $uvArchive -DestinationPath $uvTmp -Force
    $downloadedUv = Get-ChildItem -Path $uvTmp -Recurse -File -Filter "uv.exe" |
      Select-Object -First 1
    if ($null -eq $downloadedUv) {
      throw "uv archive did not contain uv.exe."
    }
    New-Item -ItemType Directory -Force -Path $uvDir | Out-Null
    Move-Item -Path $downloadedUv.FullName -Destination $uvExe -Force
  } finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -Path $uvTmp
  }
}

# Script-scoped uv configuration: this powershell process only runs the
# installer, so plain $env: assignments are simpler and safer than a
# save/restore dance (see the $null -> "" coercion bug this replaced).
$pythonRoot = Join-Path $runtimeDir "python"
$env:UV_NO_CONFIG = "1"
$env:UV_PYTHON_INSTALL_DIR = $pythonRoot
$env:UV_PYTHON_INSTALL_BIN = "0"

Invoke-Native $uvExe @("python", "install", "3.11")
$pythonInstall = Get-ChildItem -Path $pythonRoot -Directory |
  Where-Object { $_.Name -like "cpython-3.11*" } |
  Select-Object -First 1
if ($null -eq $pythonInstall) {
  throw "uv did not install a cpython-3.11 runtime under $pythonRoot."
}
$py = Join-Path $pythonInstall.FullName "python.exe"
if (!(Test-Path $py)) {
  throw "Managed Python interpreter missing at $py."
}

$venvDir = Join-Path $installDir "venv"
if (Test-Path $venvDir) {
  Remove-Item -Recurse -Force -Path $venvDir
}
Invoke-Native $uvExe @("venv", "--python", $py, $venvDir)
$venvPython = Join-Path $venvDir "Scripts\python.exe"
if (!(Test-Path $venvPython)) {
  throw "Python virtual environment was not created at $venvDir."
}

Set-Location $installDir
Invoke-Native $uvExe @("pip", "install", "-p", $venvPython, "-e", ".[all]")

$homeDirs = @("cron", "sessions", "logs", "pairing", "hooks", "image_cache", "audio_cache", "memories", "skills")
foreach ($dir in $homeDirs) {
  New-Item -ItemType Directory -Force -Path (Join-Path $hermesHome $dir) | Out-Null
}

$envFile = Join-Path $hermesHome ".env"
if (!(Test-Path $envFile)) {
  $exampleEnv = Join-Path $installDir ".env.example"
  if (Test-Path $exampleEnv) {
    Copy-Item -Path $exampleEnv -Destination $envFile
  } else {
    New-Item -ItemType File -Path $envFile | Out-Null
  }
}

$configFile = Join-Path $hermesHome "config.yaml"
if (!(Test-Path $configFile)) {
  $exampleConfig = Join-Path $installDir "cli-config.yaml.example"
  if (Test-Path $exampleConfig) {
    Copy-Item -Path $exampleConfig -Destination $configFile
  }
}

$soulFile = Join-Path $hermesHome "SOUL.md"
if (!(Test-Path $soulFile)) {
  [System.IO.File]::WriteAllText($soulFile, "# Hermes Agent Persona`n", (New-Object System.Text.UTF8Encoding $false))
}

$skillsSync = Join-Path $installDir "tools\skills_sync.py"
if (Test-Path $skillsSync) {
  try {
    Invoke-Native $venvPython @($skillsSync)
  } catch {
    $sourceSkills = Join-Path $installDir "skills"
    $targetSkills = Join-Path $hermesHome "skills"
    if (Test-Path $sourceSkills) {
      Copy-Item -Path (Join-Path $sourceSkills "*") -Destination $targetSkills -Recurse -Force
    }
  }
}

$hermesExe = Join-Path $venvDir "Scripts\hermes.exe"
if (!(Test-Path $hermesExe)) {
  throw "Hermes executable was not created at $hermesExe."
}

$metadata = [ordered]@{
  source = "NousResearch/hermes-agent"
  commit = $installCommit
  patches = $env:JUNE_HERMES_PATCHES
  installDir = $installDir
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $runtimeDir "runtime.json"), $metadata, (New-Object System.Text.UTF8Encoding $false))
