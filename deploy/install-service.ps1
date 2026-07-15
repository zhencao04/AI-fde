$ErrorActionPreference = "Continue"
$nssmDir = "C:\nssm"
$nssmZip = "C:\nssm.zip"
$nssmUrl = "https://nssm.cc/release/nssm-2.24.zip"

Write-Host "===== Step 1: Download NSSM ====="
if (Test-Path "$nssmDir\nssm.exe") {
    Write-Host "NSSM already exists"
} else {
    Write-Host "Downloading NSSM ..."
    Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip -UseBasicParsing
    if (Test-Path $nssmZip) {
        Expand-Archive -Path $nssmZip -DestinationPath "C:\nssm-temp" -Force
        $inner = Get-ChildItem "C:\nssm-temp" -Directory | Select-Object -First 1
        $exePath = Join-Path $inner.FullName "win64\nssm.exe"
        if (Test-Path $exePath) {
            New-Item -ItemType Directory -Path $nssmDir -Force | Out-Null
            Copy-Item $exePath "$nssmDir\nssm.exe" -Force
            Write-Host "NSSM installed to $nssmDir"
        } else {
            Write-Host "ERROR: nssm.exe not found in archive"
            exit 1
        }
        Remove-Item "C:\nssm-temp" -Recurse -Force
        Remove-Item $nssmZip -Force
    } else {
        Write-Host "ERROR: Download failed"
        exit 1
    }
}

Write-Host "===== Step 2: Stop existing processes ====="
$nodeProcesses = Get-Process node -ErrorAction SilentlyContinue
if ($nodeProcesses) {
    Write-Host "Stopping node processes ..."
    Stop-Process -Name node -Force -ErrorAction SilentlyContinue
    Start-Sleep 2
}

Write-Host "===== Step 3: Remove old scheduled task ====="
schtasks /delete /tn observer-api /f 2>&1 | Out-Null
Write-Host "Old task removed"

Write-Host "===== Step 4: Install as Windows Service ====="
$nssmExe = "$nssmDir\nssm.exe"
$serviceName = "ObserverApi"

# Remove existing service if any
. $nssmExe stop $serviceName 2>&1 | Out-Null
. $nssmExe remove $serviceName confirm 2>&1 | Out-Null

# Install service
. $nssmExe install $serviceName "C:\nodejs\node.exe" "C:\wwwroot\ai-fde-observer\dist\server\index.js"

# Configure service
. $nssmExe set $serviceName AppDirectory "C:\wwwroot\ai-fde-observer"
. $nssmExe set $serviceName AppParameters "--max-old-space-size=2048 dist/server/index.js"
. $nssmExe set $serviceName AppEnvironmentExtra "NODE_ENV=production"
. $nssmExe set $serviceName Description "AI FDE Observer API Service"
. $nssmExe set $serviceName Start SERVICE_AUTO_START
. $nssmExe set $serviceName AppStdout "C:\wwwroot\ai-fde-observer\.data\logs\service-out.log"
. $nssmExe set $serviceName AppStderr "C:\wwwroot\ai-fde-observer\.data\logs\service-error.log"
. $nssmExe set $serviceName AppStdoutCreationDisposition 4
. $nssmExe set $serviceName AppStderrCreationDisposition 4

# Auto restart on failure
. $nssmExe set $serviceName AppExit Default Restart
. $nssmExe set $serviceName AppRestartDelay 5000

Write-Host "===== Step 5: Start Service ====="
. $nssmExe start $serviceName
Start-Sleep 3

Write-Host "===== Step 6: Verify ====="
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Service Status: $($service.Status)"
} else {
    Write-Host "ERROR: Service not found"
}

# Check port
$port = netstat -ano | findstr ":3000"
if ($port) {
    Write-Host "Port 3000: LISTENING"
} else {
    Write-Host "WARNING: Port 3000 not listening"
}

Write-Host ""
Write-Host "===== DONE ====="
Write-Host "Service Name: $serviceName"
Write-Host "Auto Restart: Enabled (5 second delay)"
Write-Host "Logs: C:\wwwroot\ai-fde-observer\.data\logs\"
