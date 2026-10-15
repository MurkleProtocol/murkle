# Builds the GPU miner on Windows: gpu\bin\murkle-gpu-win32-x64.exe (docs/design/mining.md section 12.2).
#
#   powershell -File gpu\build.ps1          (npm run gpu:build)
#
# Needs the CUDA Toolkit 12.8.1 (nvcc 12.8, "V12.8.93"; sm_120 needs 12.8 or later) and Visual
# Studio 2019 or 2022 with the C++ build tools. Run it from any prompt: when cl.exe is not on the
# PATH the script loads the Visual Studio build environment itself. No GPU is needed to compile.
# $env:NVCC picks a toolkit. SASS for sm_61 70 75 80 86 89 90 120 and PTX for compute_120, so a
# driver of 527.41 or newer runs it through CUDA minor-version compatibility.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$nvcc = $env:NVCC
if (-not $nvcc) {
  $cmd = Get-Command nvcc -ErrorAction SilentlyContinue
  if ($cmd) { $nvcc = $cmd.Source }
  elseif ($env:CUDA_PATH -and (Test-Path "$env:CUDA_PATH\bin\nvcc.exe")) { $nvcc = "$env:CUDA_PATH\bin\nvcc.exe" }
  else { throw "nvcc not found: install the CUDA Toolkit 12.8.1 or set NVCC" }
}
$version = (& $nvcc --version) -join "`n"
if ($version -notmatch "release 12\.8") {
  Write-Host "this build needs CUDA 12.8 (12.8.1 is the tested release); found:"
  Write-Host ($version -split "`n" | Select-Object -Last 2)
  if ($env:MURKLE_GPU_ANY_CUDA -ne "1") { throw "set MURKLE_GPU_ANY_CUDA=1 to build with another toolkit anyway" }
}
if ($version -notmatch "V12\.8\.93") { Write-Host "note: the tested toolkit is 12.8.1 (V12.8.93)" }

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { throw "cl.exe not found and Visual Studio is not installed (install the C++ build tools)" }
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vs) { throw "Visual Studio has no C++ x64 tools (install the 'Desktop development with C++' workload)" }
  $vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
  # Run vcvars64.bat in cmd and copy the environment it sets into this process.
  cmd /c "`"$vcvars`" >nul && set" | ForEach-Object {
    if ($_ -match "^([^=]+)=(.*)$") { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
  }
}

New-Item -ItemType Directory -Force -Path "$here\bin", "$here\build" | Out-Null
$sha = "unknown"
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
  $rev = & git -C $here rev-parse --short=12 HEAD 2>$null
  if ($LASTEXITCODE -eq 0 -and $rev) { $sha = $rev }
}
Set-Content -Path "$here\build\stamp.h" -Value "#define MURKLE_GPU_GIT `"$sha`"" -Encoding ascii

$out = "$here\bin\murkle-gpu-win32-x64.exe"
$archs = @(
  "-gencode", "arch=compute_61,code=sm_61",
  "-gencode", "arch=compute_70,code=sm_70",
  "-gencode", "arch=compute_75,code=sm_75",
  "-gencode", "arch=compute_80,code=sm_80",
  "-gencode", "arch=compute_86,code=sm_86",
  "-gencode", "arch=compute_89,code=sm_89",
  "-gencode", "arch=compute_90,code=sm_90",
  "-gencode", "arch=compute_120,code=[sm_120,compute_120]"
)
& $nvcc -O3 -std=c++17 -cudart static -lineinfo -Wno-deprecated-gpu-targets @archs -Xcompiler /MT -I "$here\src" -I "$here\build" -o $out "$here\src\murkle-gpu.cu"
if ($LASTEXITCODE -ne 0) { throw "nvcc failed ($LASTEXITCODE)" }
Write-Host "built $out"
& $out --version
