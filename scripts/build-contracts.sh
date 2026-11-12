#!/usr/bin/env bash
# Builds the seven Hustle contracts into contracts/out/<name>.wasm.
#
# Uses `cargo near build` (cargo-near >= 0.23): it builds with --release for wasm32-unknown-unknown
# and runs `wasm-opt -O`, which nearcore needs for wasm emitted by rustc >= 1.82. near-sdk 5.30
# targets protocol 85, whose VM (nearcore >= 2.12, sandbox 2.14) accepts the bulk-memory and
# non-trapping float-to-int opcodes newer rustc emits. `--locked` pins every dependency to
# contracts/Cargo.lock so the same source and toolchain give the same wasm.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
contracts="$root/contracts"
out="$contracts/out"

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
if ! cargo near --version >/dev/null 2>&1; then
  echo "cargo-near is missing: cargo install cargo-near --locked" >&2
  exit 1
fi
rustup target list --installed | grep -q '^wasm32-unknown-unknown$' \
  || rustup target add wasm32-unknown-unknown

mkdir -p "$out"
echo "rustc: $(rustc --version)"
echo "cargo-near: $(cargo near --version)"

# name in out/ -> crate directory
for name in credits registry agent-wallet job-board reputation badges market; do
  crate_dir="$contracts/$name"
  artifact="hustle_${name//-/_}.wasm"
  tmp="$(mktemp -d)"
  echo "building $name"
  (cd "$crate_dir" && cargo near build non-reproducible-wasm --locked --no-abi --out-dir "$tmp" >/dev/null 2>"$tmp/log") || {
    cat "$tmp/log" >&2
    exit 1
  }
  mv "$tmp/$artifact" "$out/$name.wasm"
  rm -rf "$tmp"
  echo "  $out/$name.wasm ($(wc -c <"$out/$name.wasm" | tr -d ' ') bytes)"
done

# Test-only contracts used by the sandbox tests; never deployed elsewhere.
mkdir -p "$out/fixtures"
for name in nft-receiver; do
  tmp="$(mktemp -d)"
  echo "building fixture $name"
  (cd "$contracts/fixtures/$name" && cargo near build non-reproducible-wasm --locked --no-abi --out-dir "$tmp" >/dev/null 2>"$tmp/log") || {
    cat "$tmp/log" >&2
    exit 1
  }
  mv "$tmp/hustle_fixture_${name//-/_}.wasm" "$out/fixtures/$name.wasm"
  rm -rf "$tmp"
done
