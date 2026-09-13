param(
    [ValidateSet('setup', 'list', 'dry-run', 'enable-auto')]
    [string]$Command = 'setup'
)

$ErrorActionPreference = 'Stop'
$backendPath = Join-Path $PSScriptRoot 'backend'
$pythonCandidates = @(
    (Join-Path $backendPath '.venv-runtime\Scripts\python.exe'),
    (Join-Path $backendPath '.venv\Scripts\python.exe')
)
$modelPython = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $modelPython) {
    Write-Error 'Backend Python environment missing: create backend/.venv and install backend dev dependencies first.'
    exit 1
}

$setupScript = Join-Path $backendPath 'scripts\model_setup.py'
& $modelPython -X utf8 $setupScript $Command
exit $LASTEXITCODE
