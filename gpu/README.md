# GPU miner for MURK (`murkle mine --gpu`)

`murkle-gpu` is a small CUDA program that computes the Argon2id of MURK mining (RFC 9106, version 0x13, 4 MiB, one pass, one lane, 32-byte tag, salt `murkle/mine/salt`, 40-byte passwords) for thousands of nonces at once. It is written for this one parameter set and knows nothing else. The Node CLI starts one copy per GPU, sends it plain-text commands on stdin and reads JSON lines from stdout. Users who do not pass `--gpu` see no change.

Design and measurements: `docs/design/mining.md` sections 4.4 and 12.2. Licenses of what it borrows: `THIRD_PARTY_NOTICES.md`.

## 1. What a GPU can and cannot do here

- **It only finds candidates.** Every nonce the GPU reports is hashed again by the Argon2 worker pool (hash-wasm after its self-test, else noble) before the CLI believes it, and `claim()` checks it a third time with noble, as it always did. Only after both checks can anything be proved or paid. A faulty, overclocked or lying GPU can cost hash rate; it cannot cost a payment.
- **NVIDIA only**, Pascal (compute capability 6.1) and newer, Linux x64 and Windows x64. Each hash needs 4 MiB of GPU memory, so a 24 GB card runs about 5,000 at once.
- **Driver:** 525.60 or newer on Linux, 527.41 or newer on Windows (CUDA minor-version compatibility; the binary carries machine code for sm_61 70 75 80 86 89 90 120 and PTX for newer cards).
- **Expect** a high-end card to do tens of thousands of hashes per second against about 250 for one browser thread (`mining.md` section 4.4). At today's difficulty that is a lot of solutions, the difficulty will climb fast, and the browser share of mining will collapse. The launch copy already says so.

## 2. Get the binary

Three ways, in order of effort.

1. **Download the release build:** `npm run gpu:fetch` downloads `murkle-gpu` for this platform into `gpu/bin/` and refuses it unless its sha256 equals the pin in `gpu/pins.json`. The pins point at the release [`gpu-v1.0.0`](https://github.com/MurkleProtocol/murkle/releases/tag/gpu-v1.0.0) (built from commit `2610b26` by `.github/workflows/gpu-build.yml`); `npm run gpu:fetch -- --check` re-checks the file on disk without the network.
2. **Build it** (no GPU is needed to compile): install the CUDA Toolkit 12.8.1 (nvcc 12.8, `V12.8.93`) and a host compiler it supports (g++ on Linux; Visual Studio 2019 or 2022 with the C++ tools on Windows), then
   ```bash
   npm run gpu:build         # gpu/build.sh on Linux, gpu/build.ps1 on Windows
   ```
   This writes `gpu/bin/murkle-gpu-<linux|win32>-x64[.exe]`, prints its `--version` (`{"version","cuda","git"}`) and takes about half a minute. `NVCC=/path/to/nvcc` picks a toolkit; `MURKLE_GPU_ANY_CUDA=1` allows another 12.x at your own risk. Build on Ubuntu 22.04 for a binary that runs on more distributions. A binary you built yourself is not pinned: the CLI uses it all the same and prints one line saying so. The safety gate re-checks every solution it returns, but it cannot check what else a program does: it runs with your account's rights and can read your wallet files, so run only a binary you built from this source or fetched with `npm run gpu:fetch`. `MURKLE_GPU_SLOTS` and `MURKLE_GPU_HASHES_PER_BLOCK` pass `--slots` and `--hashes-per-block` to the binary.
3. **Docker** (an NVIDIA driver and the NVIDIA Container Toolkit on the host):
   ```bash
   docker build -f gpu/Dockerfile -t murkle-gpu --build-arg MURKLE_NETWORK=mainnet \
     --build-arg MURKLE_ARTIFACTS_URL=https://<a Murkle site>/artifacts .
   docker run --gpus all -v murkle-data:/app/data murkle-gpu mine alice MURK --gpu all
   ```
   `MURKLE_NETWORK` is required (the build fails without it). The image builds the binary from this checkout, installs Node 22 from the official tarball checked against a pinned sha256, and runs as the unprivileged user `node`. Publishing an image to a registry is an owner step; nothing here pushes.

`MURKLE_GPU_BIN=/path/to/murkle-gpu` overrides the default location (`gpu/bin/murkle-gpu-<platform>-<arch>[.exe]`).

## 3. Mine

Set the wallet up first (the same steps as the "Mine on a GPU" section of `/mine`):

```bash
node bin/murkle.mjs new alice                                 # prints the Murkle address, the BTC fee address and the mining fee address
node bin/murkle.mjs address alice                             # prints them again
node bin/murkle.mjs mine alice MURK --prepare-coins 20        # after funding the mining fee address: split it into 20 coins
```

- `new` makes the wallet's mining key at once, so the **mining fee address** is printed straight away. Fund that one for mining: it pays the Bitcoin fee and service fee of every self-paid claim. The BTC fee address pays a later `send` (fund it for that send's network fee), not the mining.
- `--prepare-coins N` splits the mining fee address into `N` coins, each worth one claim plus a 330-sat change output that comes back (`prepareCoinsCommand`). A claim is bound to the largest coin of that address (`pickBindUtxo`), and a GPU finds many solutions in a short time: claims paid from one coin chain on each other's unconfirmed change, and Bitcoin nodes accept only about 25 unconfirmed transactions in such a chain (`docs/design/mining.md` section 8.6). With `N` coins, `N` claims go out side by side. Pick `N` as the number of claims you want ready; each claim pays the next-block fee rate plus 25% (`headroomRate`) for about 684 vB, plus the service fee, so fund about `N` times (that plus 330 sats), plus the split's own fee at the next-block rate (about 43 vB for each coin and about 110 vB more for the transaction), and split again when the coins are used.
- The first `mine` run (the split, if it comes first) syncs the chain from the activation block in the pins; later runs only catch up from `cli-state.json`. A fresh mainnet sync in October 2026 replayed blocks 971316 to 971726 (411 blocks) in 273 s, about 0.67 s for each block on a home connection; it grows with the chain. `new` does not sync.

```bash
node bin/murkle.mjs mine alice MURK --gpu all                 # every CUDA device, no CPU lanes
node bin/murkle.mjs mine alice MURK --gpu 0,2 --threads 2     # devices 0 and 2, plus 2 CPU lanes
```

- `--gpu all` or a comma list of distinct device numbers (0 to 999, as `murkle-gpu --list` numbers them). It does not go with `--prepare-coins`.
- With `--gpu`, `--threads N` means **N CPU mining lanes** (default 0). The Argon2 pool holds N + 1 workers, so one is always spare to verify what the GPUs report.
- Start-up order: find the binary, list the devices, resolve `all`, start the Argon2 pool, then per device start the binary and run its self-test (section 5). Nothing is drafted or paid before every device has passed:

  ```
  GPU 0 self-test passed: NVIDIA GeForce RTX 4090 (8.9, 24564 MiB, 5376 slots)
  block 325140: reward 50 MURK, difficulty 3600000, GPU 0 and 2 CPU threads
  81,234 H/s  [gpu0 80,100 | cpu 1,134]  solutions 0  claims sent 0  landed 0  fees spent 0 sats
  ```
- Ctrl+C stops after the current slice. A solution on any lane cancels the GPU slices of the others.
- While a claim is being proved and paid the GPU is idle (perhaps 10 % of the time at a high solution rate). Overlapping the two is a later step.

Errors you may meet, each ending the run with nothing mined or paid:

| Message | What to do |
|---|---|
| `no GPU miner binary for <platform>-<arch>: run npm run gpu:fetch, build it (gpu/README.md), or set MURKLE_GPU_BIN; nothing was mined` | section 2 |
| `no CUDA device found (driver 525 or newer is needed); nothing was mined` | install or update the NVIDIA driver |
| `GPU <i> failed its self-test (<detail>); remove it from --gpu. Nothing was mined.` | the card or its driver computes Argon2 wrongly; lower its clocks, update the driver |
| `GPU <i> (<name>) disabled: it reported a nonce whose Argon2 hash <does not meet the target\|differs from the reference>; nothing was paid for it. Check overclocking, temperature and drivers.` | mid-run: that GPU is out for the rest of the run, the other lanes carry on |

If no lane is left the miner stops: `every GPU and CPU lane is disabled; nothing more was mined`.

## 4. Rented machines

A rented GPU box is somebody else's computer. Use a **separate mining wallet** on it, fund its mining key (`new` and `address <wallet>` print the mining fee address) only with what you will spend on fees, **move the rewards to your main wallet often**, and remember that the provider can read the disk. Never put your main wallet file, your BTC fee key or your recovery phrase on it. `--pay relay` keeps the mining key's coins out of the picture but shows the relayer your claims (`README.md`, Mining).

## 5. How it is kept honest

1. **Every candidate is hashed again** by the pool (`GpuLane.grind`, `src/gpu.mjs`): the lane returns a nonce only if the pool's Argon2 of it equals the GPU's hash and meets the target, and then returns the pool's hash, never the GPU's. `claim()` re-checks with noble and `claimRefusal` checks the target again.
2. **A wrong candidate or hash disables the lane** for the run (`GPU_WRONG`, the sentence above). Other lanes carry on.
3. **Probe spot-check:** each search carries a random probe nonce; its tag is checked in the background and the next round waits for the result. A mismatch disables the lane. This catches a GPU that wrongly misses solutions (a persistent false negative costs hash rate only), at one CPU hash per GPU per round.
4. **Start-up self-test** per device: the 4 forty-byte reference vectors of `SELF_TEST_VECTORS` and the 16 of `GPU_SELF_TEST_VECTORS`; 32 random passwords against the pool; the boundary of the target comparison (a target equal to a hash returns its nonce, one less returns none); and a search over `slots + 7` nonces with the loosest target, which must stop after exactly one full batch with the first 64 nonces as candidates, 8 of which the pool hashes again.
5. **Restarts:** a crash, a stall (timeout), a protocol error or any other device failure but a wrong answer restarts the binary (a new process and a full self-test) at most 3 times per lane per run, then the lane is disabled. These are never read as "no solution".
6. **The binary never outlives Node:** end of input on its stdin means quit; a process exit hook kills every child.

## 6. The protocol (`murkle-gpu` <-> Node)

`murkle-gpu --list`, `--version`, or `--device N [--slots S] [--hashes-per-block W]`. `--slots` is the batch size (default: a quarter of the free memory, but at most free memory less 512 MiB or 10 %, in 4 MiB units, rounded to a multiple of SMs x W; on a first batch whose `k_fill` runs over 500 ms it is halved until it fits, which also protects a Windows display from the driver watchdog). `--hashes-per-block` is the number of warps per block, one hash per warp (1, 2, 4 or 8; default 4).

Requests on stdin, ASCII, one per line, single spaces, lowercase hex, decimal integers:

```
hash <id> <hex80> [<hex80> ...]          1 to 4096 passwords of 40 bytes
search <id> <challengeHex64> <targetHex64> <nonceStart> <count> <probe>
cancel <id>
quit
```

Answers on stdout, JSON lines (stderr is free text for humans):

```
{"type":"hello","protocol":1,"version":"1.0.0","device":0,"name":"...","cc":"8.9","sms":128,"vramMiB":24564,"slots":5376,"hashesPerBlock":4}
{"type":"hash","id":5,"ok":true,"hashes":["<hex64>",...]}
{"type":"search","id":7,"ok":true,"done":"160000","ms":1987,"cancelled":false,"candidates":[{"nonce":"<u64>","hash":"<hex64>"}],"more":0,"probe":"<hex64>"|null}
{"type":"error","id":7|null,"code":"BAD_REQUEST","error":"..."}
{"type":"fatal","code":"NO_DEVICE|BAD_DEVICE|OOM|CUDA|BAD_ARGS","error":"..."}      (then exit code 2)
```

A search hashes `nonceStart + k` (mod 2^64, the u64 little-endian counter of `nonceOf`), `k = 0, 1, ...` in batches of `slots`. It stops after the batch in which the first hash `<=` target appears, after `count` nonces, or after `cancel`. `done` is the finished prefix; `candidates` lists, in nonce order, at most 64 nonces of the finished range whose tag is `<=` target (compared as big-endian numbers) and `more` counts the rest; `probe` is the tag of `nonceStart + probe` if it was hashed, else null. One job at a time; a reader thread acts on `cancel` and `quit` between batches.

Per batch: copy the passwords to the GPU; `k_init` (H0 and the first two blocks, one thread per slot and block); `k_fill` (blocks 2 to 4095, one warp per slot; the block addresses of slices 0 and 1 are the same for every password and come from a table made once by `k_reftable`); `k_final` (BLAKE2b-256 of `LE32(32) || B[4095]`); copy the tags back. The target comparison is plain `memcmp` on the host.

## 7. Measuring (`npm run gpu:bench`)

`scripts/gpu-bench.mjs` is the measurement harness. It runs flat out for tens of minutes: use it on a rented, labelled box (a Vast instance with self-destruct armed, destroyed after the run), never on a workstation. The box has no wallet and no mainnet keys.

```bash
npm ci --omit=dev
npm run gpu:bench -- --build --workers all --out bench.json
```

Steps: build; correctness (the 32 vectors, the boundary searches, 100,000 seeded random passwords against hash-wasm, 2,000 of them against noble; acceptance: 0 mismatches); a sweep of slots (25 %, 50 %, 100 % of the default) x hashes per block (1, 2, 4, 8), 60 s each, 3 runs, recording hash rate, `nvidia-smi` utilisation, memory, power, clocks and temperature, the CPU use of `murkle-gpu` and of Node, the cancel latency and the start-up time; a 10-minute `GpuLane` run at a synthetic difficulty of 10,000 (acceptance: no `GPU_WRONG`). `--only correctness` repeats the first on a box with an older driver.

| Measure | Target |
|---|---|
| RTX 4090 | at least 50,000 H/s (estimate 80,000) |
| RTX 3060 | at least 12,000 H/s |
| GPU utilisation | at least 95 % |
| Host CPU per GPU | at most 25 % of one core |
| Cancel latency | at most 250 ms |
| Start-up (allocation plus self-test) | at most 15 s |
| VRAM | within total minus the reserve |

All of these were measured on Linux; the Windows build has not been timed yet. Measured on one RTX 4090 (Vast, driver 575.57, CUDA 12.8.93, 2026-10): 114,635 H/s best cell (112.6k - 114.6k across the whole sweep, so the slot count and hashes per block barely matter), 95.2% utilisation in the worst cell and 99.3% at the default, host CPU 2.2% of one core, cancel latency 14 ms, start-up 0.5 s, 0 mismatches over 100,000 random passwords, and 0 `GPU_WRONG` in a 10-minute lane run (104,409 H/s with the pool verifying on the same box). They are in `docs/design/mining.md` sections 4.4 and 8.6 and the root `README.md`. The release Linux build on one RTX 3090 (Vast, 2026-10): about 91,000 H/s (the kernel alone), 0 mismatches over 20,000 random passwords, and the device tests pass. The RTX 3060, the RTX 5090 (sm_120) and the minimum driver (525.60 / 527.41) are not measured yet and stay estimates: the minimum drivers follow NVIDIA's compatibility rules and are not tested on every version. The `/mine` page quotes the kernel rate (about 113,000 H/s on the 4090) and the full-run rate (about 104,000 H/s, every solution re-checked) and computes the time per solution from the full run.

## 8. License

The sources in `gpu/src/` are GPL-3.0-or-later (SPDX `GPL-3.0-or-later`, `LICENSE` in the repository root), with this additional permission under section 7 of the GNU GPL version 3, which every source file repeats:

> If you link or combine this program with the NVIDIA CUDA runtime and driver libraries (cudart, libcuda / nvcuda), the licensors grant you additional permission to convey the resulting work. Corresponding Source for a non-source form of such a combination need not include the source of those NVIDIA libraries.

The NVIDIA libraries themselves are not open source: `cudart_static` is linked into the release binaries under the CUDA Toolkit EULA and the driver is the user's own (`THIRD_PARTY_NOTICES.md`).
