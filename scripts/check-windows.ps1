# Checks that this Windows computer has what AgoraOne needs to run from source (docs/windows.md).
# It only reads: it installs nothing and changes nothing. Works in Windows PowerShell 5.1 and PowerShell 7.
# Usage, from the project folder:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-windows.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$script:missing = 0
$script:warnings = 0

function Write-Ok([string]$what, [string]$detail) { Write-Host "  [ok]    $what" -ForegroundColor Green -NoNewline; Write-Host "  $detail" }
function Write-Missing([string]$what, [string]$fix) { $script:missing++; Write-Host "  [falta] $what" -ForegroundColor Red; Write-Host "          $fix" }
function Write-Warn([string]$what, [string]$fix) { $script:warnings++; Write-Host "  [aviso] $what" -ForegroundColor Yellow; Write-Host "          $fix" }
function Write-Info([string]$what, [string]$detail) { Write-Host "  [info]  $what" -ForegroundColor Cyan -NoNewline; Write-Host "  $detail" }

# The first line a program prints for --version, or $null when it is not installed.
function Get-ToolVersion([string]$name, [string[]]$arguments = @('--version')) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { return $null }
  try { return (& $name @arguments 2>$null | Select-Object -First 1) } catch { return $null }
}

# The x.y.z inside a version text, as a [version], or $null.
function ConvertTo-Version([string]$text) {
  if ($text -match '(\d+)\.(\d+)\.(\d+)') { return [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" }
  return $null
}

Write-Host ''
Write-Host 'AgoraOne: comprobación del equipo Windows' -ForegroundColor White
Write-Host ''
Write-Host 'Sistema y herramientas'

$build = [Environment]::OSVersion.Version.Build
if ($build -ge 22000) { Write-Ok 'Windows 11' "compilación $build" }
else { Write-Warn "Windows con compilación $build" 'AgoraOne se ha probado en Windows 11; en versiones anteriores puede fallar.' }

$git = Get-ToolVersion 'git'
if ($git) { Write-Ok 'Git' $git } else { Write-Missing 'Git' 'winget install --id Git.Git -e' }

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msvc = $null
if (Test-Path $vswhere) { $msvc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName 2>$null | Select-Object -First 1 }
if ($msvc) { Write-Ok 'Herramientas de compilación de C++ (MSVC)' $msvc }
else { Write-Missing 'Herramientas de compilación de C++ (MSVC), sin ellas Rust no compila' 'winget install --id Microsoft.VisualStudio.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' }

$cargo = Get-ToolVersion 'cargo'
if (-not $cargo) { Write-Missing 'Rust (cargo)' 'winget install --id Rustlang.Rustup -e   y después abre una terminal nueva' }
else {
  $toolchain = Get-ToolVersion 'rustup' @('show', 'active-toolchain')
  if ($toolchain -and $toolchain -notmatch 'msvc') { Write-Warn "Rust usa la cadena $toolchain" 'AgoraOne se compila con la de MSVC: rustup default stable-x86_64-pc-windows-msvc' }
  else { Write-Ok 'Rust' "$cargo ($toolchain)" }
}

$node = Get-ToolVersion 'node'
$nodeVersion = ConvertTo-Version $node
if (-not $nodeVersion) { Write-Missing 'Node.js 22.12 o superior' 'winget install --id OpenJS.NodeJS.LTS -e' }
elseif ($nodeVersion -lt [version]'22.12.0') { Write-Missing "Node.js $node es antiguo, hace falta 22.12 o superior" 'winget upgrade --id OpenJS.NodeJS.LTS -e' }
else { Write-Ok 'Node.js' $node }

$wantedPnpm = $null
try { $wantedPnpm = ((Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).packageManager -replace '^pnpm@', '') } catch { }
$pnpm = Get-ToolVersion 'pnpm'
if (-not $pnpm) { Write-Missing 'pnpm' "npm install -g pnpm@$wantedPnpm" }
elseif ($wantedPnpm -and $pnpm -ne $wantedPnpm) { Write-Info 'pnpm' "$pnpm (el proyecto fija $wantedPnpm; si da problemas: npm install -g pnpm@$wantedPnpm)" }
else { Write-Ok 'pnpm' $pnpm }

$uv = Get-ToolVersion 'uv'
if ($uv) { Write-Ok 'uv' $uv } else { Write-Missing 'uv (instala Python 3.13 para el núcleo)' 'winget install --id astral-sh.uv -e' }

Write-Host ''
Write-Host 'Proyecto'

if (Test-Path (Join-Path $root 'node_modules')) { Write-Ok 'Dependencias de la interfaz' 'node_modules' }
else { Write-Warn 'Faltan las dependencias de la interfaz' 'pnpm install --frozen-lockfile' }

if (Test-Path (Join-Path $root 'core\.venv\Scripts\python.exe')) { Write-Ok 'Entorno del núcleo Python' 'core\.venv' }
else { Write-Warn 'Falta el entorno del núcleo Python' 'cd core; uv sync --frozen; cd ..' }

if (Test-Path (Join-Path $root '.env')) { Write-Ok 'Archivo .env' 'existe (no se muestra su contenido)' }
else { Write-Warn 'Falta el archivo .env (lo necesita Luma para conversar)' 'Copy-Item .env.example .env   y complétalo con un editor' }

foreach ($port in 4317, 4318, 5173) {
  $owner = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($owner) {
    $process = (Get-Process -Id $owner.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Write-Info "Puerto $port ocupado" "por $process (PID $($owner.OwningProcess)); si no es AgoraOne en marcha, ciérralo antes de pnpm dev"
  }
}

Write-Host ''
Write-Host 'Hermes y extras'

$hermesHome = $env:AGORA_HERMES_HOME
if (-not $hermesHome) { $hermesHome = $env:HERMES_HOME }
if (-not $hermesHome) { $hermesHome = Join-Path $HOME '.hermes' }
$hermesCode = $env:AGORA_HERMES_PATH
if (-not $hermesCode) { $hermesCode = Join-Path $hermesHome 'hermes-agent' }
if (Test-Path (Join-Path $hermesCode 'run_agent.py')) {
  # AgoraOne only uses the Hermes commit its bridges were verified against.
  $expected = $null
  $bridge = Join-Path $root 'desktop\server\python\hermes_bridge.py'
  if ((Get-Content $bridge -Raw) -match 'EXPECTED_COMMIT = "([0-9a-f]{40})"') { $expected = $Matches[1] }
  $revision = $null
  if (Get-Command 'git' -ErrorAction SilentlyContinue) { $revision = git -C $hermesCode rev-parse HEAD 2>$null }
  if ($expected -and $revision -and $revision -ne $expected) {
    Write-Warn "Hermes está en el commit $revision" "AgoraOne exige $expected y no lo usará. Ver docs/windows.md, apartado Hermes."
  }
  else { Write-Ok 'Hermes' "$hermesCode ($revision)" }
}
else { Write-Warn "No se encuentra Hermes en $hermesCode" 'AgoraOne abre igual, pero sin perfiles ni chats. Si está en otra ruta, indícala con AGORA_HERMES_HOME y AGORA_HERMES_PATH en .env.' }

if ($env:SSLKEYLOGFILE -like '*aswMonFltProxy*') {
  Write-Warn 'El antivirus Avast o AVG intercepta las conexiones seguras (SSLKEYLOGFILE)' 'La app no se ve afectada; si uv falla con "UnknownIssuer", usa uv sync --frozen --system-certs. Ver docs/windows.md.'
}

if (Get-Command 'ollama' -ErrorAction SilentlyContinue) { Write-Ok 'ollama (búsqueda por significado)' 'instalado' }
else { Write-Info 'ollama no está instalado' 'opcional: sin él, el cerebro busca solo por palabras' }

Write-Host ''
if ($script:missing -gt 0) {
  Write-Host "Faltan $($script:missing) requisitos. Instálalos, abre una terminal nueva y vuelve a ejecutar esta comprobación." -ForegroundColor Red
  exit 1
}
if ($script:warnings -gt 0) { Write-Host "Requisitos completos, con $($script:warnings) avisos. Revisa los avisos antes de pnpm dev." -ForegroundColor Yellow }
else { Write-Host 'Todo listo. Arranca AgoraOne con pnpm dev y ábrelo con pnpm open.' -ForegroundColor Green }
exit 0
