#!/bin/sh
# Installs a CODA SDK from the GitHub Release of ubeffiong/coda-sdks, verified against SHA256SUMS.
#
#   curl -fsSL https://raw.githubusercontent.com/ubeffiong/coda-sdks/main/install.sh | sh -s -- python
#   curl -fsSL https://raw.githubusercontent.com/ubeffiong/coda-sdks/main/install.sh | sh -s -- typescript 0.1.0
#
# Languages: typescript, python, dotnet, java, go, rust. Run it inside your project folder.
set -eu

REPO="${CODA_SDK_REPO:-ubeffiong/coda-sdks}"
LANG_ID="${1:-}"
VERSION="${2:-}"

die() { printf 'coda-sdk: %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required for the $LANG_ID SDK"; }

case "$LANG_ID" in
  typescript|javascript|js|ts|node) LANG_ID=typescript ;;
  python|py) LANG_ID=python ;;
  dotnet|csharp|cs|.net) LANG_ID=dotnet ;;
  java|maven) LANG_ID=java ;;
  go|golang) LANG_ID=go ;;
  rust|cargo) LANG_ID=rust ;;
  *) die "usage: install.sh <typescript|python|dotnet|java|go|rust> [version]" ;;
esac

need curl
if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$VERSION" ] || die "could not find the latest release of $REPO"
fi
VERSION="${VERSION#v}"
BASE="https://github.com/$REPO/releases/download/v$VERSION"
printf 'coda-sdk: installing the %s SDK %s from %s\n' "$LANG_ID" "$VERSION" "$REPO"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

fetch() {
  curl -fsSL "$BASE/$1" -o "$WORK/$1" || die "could not download $1"
  curl -fsSL "$BASE/SHA256SUMS" -o "$WORK/SHA256SUMS" || die "could not download SHA256SUMS"
  expected=$(grep " $1\$" "$WORK/SHA256SUMS" | cut -d ' ' -f 1)
  [ -n "$expected" ] || die "$1 is not listed in SHA256SUMS"
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$WORK/$1" | cut -d ' ' -f 1); else actual=$(shasum -a 256 "$WORK/$1" | cut -d ' ' -f 1); fi
  [ "$expected" = "$actual" ] || die "checksum mismatch for $1"
  printf 'coda-sdk: verified %s\n' "$1"
}

case "$LANG_ID" in
  typescript)
    need npm
    fetch "coda-terminology-client-$VERSION.tgz"
    mkdir -p .coda-sdk && cp "$WORK/coda-terminology-client-$VERSION.tgz" .coda-sdk/
    npm install "./.coda-sdk/coda-terminology-client-$VERSION.tgz"
    ;;
  python)
    PY=$(command -v python3 || command -v python || true)
    [ -n "$PY" ] || die "python is required"
    fetch "coda_client-$VERSION-py3-none-any.whl"
    "$PY" -m pip install "$WORK/coda_client-$VERSION-py3-none-any.whl"
    ;;
  dotnet)
    need dotnet
    fetch "Coda.Client.$VERSION.nupkg"
    mkdir -p .coda-sdk && cp "$WORK/Coda.Client.$VERSION.nupkg" .coda-sdk/
    dotnet add package Coda.Client --version "$VERSION" --source "$(pwd)/.coda-sdk"
    ;;
  java)
    need mvn
    fetch "coda-client-$VERSION.jar"
    mvn -q install:install-file -Dfile="$WORK/coda-client-$VERSION.jar" -DgroupId=io.github.ubeffiong -DartifactId=coda-client -Dversion="$VERSION" -Dpackaging=jar
    printf '\nAdd to your pom.xml:\n  <dependency><groupId>io.github.ubeffiong</groupId><artifactId>coda-client</artifactId><version>%s</version></dependency>\n' "$VERSION"
    ;;
  go)
    need go
    go get "github.com/$REPO/go@v$VERSION"
    ;;
  rust)
    need cargo
    cargo add coda-client --git "https://github.com/$REPO" --tag "v$VERSION"
    ;;
esac

printf 'coda-sdk: done. Docs: https://github.com/%s/tree/main/%s\n' "$REPO" "$LANG_ID"
