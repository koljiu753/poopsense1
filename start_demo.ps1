param(
    [switch]$TestModel,
    [switch]$LocalOnly
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backendDir = Join-Path $root "backend"
$frontendDir = Join-Path $root "frontend"
$logDir = Join-Path $root ".runtime-logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

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
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "找不到 npm.cmd。"
}

function Test-Url([string]$Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch { return $false }
}

function Assert-PortAvailable([int]$Port, [string]$HealthyUrl) {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listener -and -not (Test-Url $HealthyUrl)) {
        throw "端口 $Port 已被其他程序占用，且服务健康检查失败。"
    }
}

Assert-PortAvailable 8000 "http://127.0.0.1:8000/ready"
Assert-PortAvailable 5173 "http://127.0.0.1:5173/"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$listenHost = if ($LocalOnly) { "127.0.0.1" } else { "0.0.0.0" }

if (-not $LocalOnly) {
    foreach ($port in @(8000, 5173)) {
        $loopbackListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -eq "127.0.0.1" }
        if ($loopbackListener) {
            $loopbackListener | Select-Object -ExpandProperty OwningProcess -Unique |
                ForEach-Object { Stop-Process -Id $_ -Force }
        }
    }
    Start-Sleep -Milliseconds 500
}

if (-not (Test-Url "http://127.0.0.1:8000/ready")) {
    $backendOut = Join-Path $logDir "backend-$stamp.out.log"
    $backendErr = Join-Path $logDir "backend-$stamp.err.log"
    Start-Process -FilePath $python -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", $listenHost, "--port", "8000") -WorkingDirectory $backendDir -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr -WindowStyle Hidden | Out-Null
}

if (-not (Test-Url "http://127.0.0.1:5173/")) {
    $frontendOut = Join-Path $logDir "frontend-$stamp.out.log"
    $frontendErr = Join-Path $logDir "frontend-$stamp.err.log"
    Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev", "--", "--host", $listenHost) -WorkingDirectory $frontendDir -RedirectStandardOutput $frontendOut -RedirectStandardError $frontendErr -WindowStyle Hidden | Out-Null
}

$deadline = (Get-Date).AddSeconds(30)
do {
    if ((Test-Url "http://127.0.0.1:8000/ready") -and (Test-Url "http://127.0.0.1:5173/")) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

if (-not (Test-Url "http://127.0.0.1:8000/ready")) { throw "后端未在 30 秒内就绪，请查看 .runtime-logs。" }
if (-not (Test-Url "http://127.0.0.1:5173/")) { throw "前端未在 30 秒内就绪，请查看 .runtime-logs。" }

& (Join-Path $root "check_demo.ps1") -TestModel:$TestModel
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "PoopSense 演示已就绪：http://127.0.0.1:5173/" -ForegroundColor Green
if (-not $LocalOnly) {
    $lanAddress = Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.InterfaceAlias -notlike "vEthernet*" } |
        Select-Object -ExpandProperty IPAddress -First 1
    if ($lanAddress) {
        Write-Host "同一 Wi-Fi 下手机打开：http://${lanAddress}:5173/?demo=dry-flow-2" -ForegroundColor Cyan
    }
}
