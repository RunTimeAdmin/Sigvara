#!/bin/sh
# Fetches the three Solidity dependencies into lib/, each at an exact commit.
#
# lib/ is gitignored: nothing is vendored and there are no submodules. A tag can be moved and
# a branch moves on its own, a commit cannot, so every dependency is fetched by commit and the
# result is checked.
#
#   OpenZeppelin v5.6.1     5fd1781 (contracts), 7bf4727 (contracts-upgradeable). These are
#                           the code the contracts are built on.
#   forge-std               the commit the test suite was last run against. Tests and scripts
#                           use it, src/ does not.
#
# CI and docs/arc.md both use this file, so a pin is changed in one place. If lib/<name>
# already exists at another commit this stops and says so; it never deletes anything.
set -eu

fetch_at() { # <url> <dir> <commit>
  url=$1; dir=$2; commit=$3
  if [ -e "$dir/.git" ]; then
    have=$(git -C "$dir" rev-parse HEAD)
    if [ "$have" = "$commit" ]; then
      echo "ok   $dir @ $commit"
      return 0
    fi
    echo "FAIL $dir is at $have, not $commit. Remove it and run this again." >&2
    return 1
  fi
  git init -q "$dir"
  git -C "$dir" remote add origin "$url"
  git -C "$dir" fetch -q --depth 1 origin "$commit"
  git -C "$dir" checkout -q FETCH_HEAD
  test "$(git -C "$dir" rev-parse HEAD)" = "$commit"
  echo "ok   $dir @ $commit"
}

fetch_at https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts 5fd1781b1454fd1ef8e722282f86f9293cacf256
fetch_at https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable.git lib/openzeppelin-contracts-upgradeable 7bf4727aacdbfaa0f36cbd664654d0c9e1dc52bf
fetch_at https://github.com/foundry-rs/forge-std.git lib/forge-std 5cf980eefbf8a54050628334163127ed35453558
