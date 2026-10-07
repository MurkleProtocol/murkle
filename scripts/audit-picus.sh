#!/usr/bin/env bash
# Formal under-constraint check with Picus (Veridise) in Docker.
# Needs the picus:v0 image (docker build -t picus:v0 . in a Picus checkout).
#
# Harnesses in circuits/audit/ instantiate the production templates from
# circuits/lib.circom. The only assumption passed to Picus is that the `inv`
# hints inside circomlib IsZero are unique: when IsZero's input is 0 the hint
# is legitimately free and feeds nothing but `out`, which stays determined
# (out = 1 - in*inv, in*out = 0). See audit/REPORT.md, section "Picus".
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/audit
AUDIT_DIR_WIN=$(cygpath -w "$PWD/build/audit" 2>/dev/null || echo "$PWD/build/audit")

# Picus exit codes: 8 = properly constrained, 9 = underconstrained, 0 = unknown.
# Callers inspect the text, so the non-zero "safe" code must not trip set -e.
picus() {
  MSYS_NO_PATHCONV=1 docker run --rm -v "$AUDIT_DIR_WIN:/work" picus:v0 \
    racket picus.rkt --solver cvc5 --timeout 10000 --truncate off "$@" 2>&1 || true
}
proven() { grep -q "The circuit is properly constrained" <<<"$1"; }

for name in sanity_decoder keypair signature merkle32 tx_d4 tx_d32; do
  circom "circuits/audit/$name.circom" --O0 --r1cs --sym -o build/audit >/dev/null
done

# The tool must flag a known-underconstrained circuit, or nothing below means anything.
grep -q "The circuit is underconstrained" <<<"$(picus /work/sanity_decoder.r1cs)" \
  || { echo "FAIL: Picus did not flag the known-bad Decoder"; exit 1; }
echo "sanity: Decoder flagged as underconstrained (tool works)"

for name in keypair signature merkle32; do
  proven "$(picus "/work/$name.r1cs")" || { echo "$name: NOT PROVEN"; exit 1; }
  echo "$name: properly constrained (weak)"
done

for name in tx_d4 tx_d32; do
  ids=$(awk -F, '$4 ~ /\.isz\.inv$/ {printf "%s%s", sep, $2; sep=", "}' "build/audit/$name.sym")
  echo "[[\"unique\", $ids]]" > "build/audit/$name.pre.json"
  proven "$(picus --strong --precondition "/work/$name.pre.json" "/work/$name.r1cs")" || { echo "$name: NOT PROVEN"; exit 1; }
  echo "$name: properly constrained (strong; assumed unique: IsZero.inv hints $ids)"
done
