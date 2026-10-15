#!/usr/bin/env bash
# Builds the GPU miner: gpu/bin/murkle-gpu-<linux|win32>-x64[.exe] (docs/design/mining.md section 12.2).
#
#   bash gpu/build.sh          (npm run gpu:build)
#
# Needs the CUDA Toolkit 12.8.1 (nvcc 12.8, "V12.8.93"; sm_120 needs 12.8 or later) and a host C++
# compiler it supports (g++ on Linux, cl.exe on Windows: from Git Bash use gpu/build.ps1, which
# finds Visual Studio itself). No GPU is needed to compile. NVCC=/path/to/nvcc picks a toolkit.
# Build on an older distribution (Ubuntu 22.04) for a binary that runs on more of them.
#
# SASS for sm_61 70 75 80 86 89 90 120 and PTX for compute_120 (newer cards JIT it), so any driver
# of 525.60 (Linux) / 527.41 (Windows) or newer runs it through CUDA minor-version compatibility.
# MURKLE_GPU_GIT=<sha> sets the commit printed by --version when git is not available (Docker).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
nvcc="${NVCC:-}"
if [ -z "$nvcc" ]; then
  if command -v nvcc >/dev/null 2>&1; then nvcc="nvcc"
  elif [ -n "${CUDA_PATH:-}" ] && [ -x "$CUDA_PATH/bin/nvcc" ]; then nvcc="$CUDA_PATH/bin/nvcc"
  elif [ -x /usr/local/cuda/bin/nvcc ]; then nvcc="/usr/local/cuda/bin/nvcc"
  else echo "nvcc not found: install the CUDA Toolkit 12.8.1 or set NVCC" >&2; exit 1
  fi
fi

version="$("$nvcc" --version | tr -d '\r')"
case "$version" in
  *"release 12.8"*) ;;
  *) echo "this build needs CUDA 12.8 (12.8.1 is the tested release); found:" >&2; echo "$version" | tail -n 2 >&2
     [ "${MURKLE_GPU_ANY_CUDA:-}" = "1" ] || { echo "set MURKLE_GPU_ANY_CUDA=1 to build with another toolkit anyway" >&2; exit 1; } ;;
esac
case "$version" in *"V12.8.93"*) ;; *) echo "note: the tested toolkit is 12.8.1 (V12.8.93)" >&2 ;; esac

case "$(uname -s)" in
  Linux*) platform=linux; ext="" ;;
  MINGW*|MSYS*|CYGWIN*) platform=win32; ext=".exe" ;;
  *) echo "only Linux x64 and Windows x64 are supported" >&2; exit 1 ;;
esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; *) echo "only x64 is supported" >&2; exit 1 ;; esac

mkdir -p "$here/bin" "$here/build"
sha="${MURKLE_GPU_GIT:-$(git -C "$here" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}"
printf '#define MURKLE_GPU_GIT "%s"\n' "$sha" > "$here/build/stamp.h"

gencode=(
  -gencode arch=compute_61,code=sm_61
  -gencode arch=compute_70,code=sm_70
  -gencode arch=compute_75,code=sm_75
  -gencode arch=compute_80,code=sm_80
  -gencode arch=compute_86,code=sm_86
  -gencode arch=compute_89,code=sm_89
  -gencode arch=compute_90,code=sm_90
  -gencode "arch=compute_120,code=[sm_120,compute_120]"
)
host=()
# Linux: libstdc++ and libgcc linked in (a smaller list of things the target machine must have), and -lpthread for std::thread on glibc before 2.34.
if [ "$platform" = "linux" ]; then host=(-Xcompiler -static-libstdc++ -Xcompiler -static-libgcc -Xcompiler -pthread -lpthread); else host=(-Xcompiler //MT); fi  # "//MT": Git Bash would rewrite a bare /MT as a path

out="$here/bin/murkle-gpu-$platform-$arch$ext"
"$nvcc" -O3 -std=c++17 -cudart static -lineinfo -Wno-deprecated-gpu-targets \
  "${gencode[@]}" "${host[@]}" -I "$here/src" -I "$here/build" -o "$out" "$here/src/murkle-gpu.cu"
echo "built $out"
"$out" --version
