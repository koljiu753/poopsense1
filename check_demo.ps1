param([switch]$TestModel)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backendDir = Join-Path $root "backend"
$pythonCandidates = @(
    (Join-Path $backendDir ".venv\Scripts\python.exe"),
    (Join-Path $backendDir ".venv-runtime\Scripts\python.exe"),
    (Join-Path $backendDir ".venv-win\Scripts\python.exe")
)
$python = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $python) {
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) { $python = $pythonCommand.Source }
}
if (-not $python) {
    throw "找不到 Python。请先按 README 创建 backend\.venv 并安装依赖。"
}

$arguments = @((Join-Path $root "backend\scripts\demo_smoke.py"))
if ($TestModel) { $arguments += "--test-model" }
& $python @arguments
exit $LASTEXITCODE
