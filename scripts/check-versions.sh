#!/usr/bin/env bash
# Every SDK carries the same version. With an argument (the release version, e.g. 0.2.0) the
# packages must match it; without one they must only agree with each other.
set -euo pipefail
cd "$(dirname "$0")/.."

declare -A found=(
  [typescript]=$(node -p "require('./typescript/package.json').version")
  [python]=$(sed -nE 's/^version = "([^"]+)"/\1/p' python/pyproject.toml)
  [python-module]=$(sed -nE 's/^__version__ = "([^"]+)"/\1/p' python/src/coda_client/__init__.py)
  [dotnet]=$(sed -nE 's/.*<Version>([^<]+)<\/Version>.*/\1/p' dotnet/src/Coda.Client/Coda.Client.csproj)
  [java]=$(sed -nE '/<artifactId>coda-client<\/artifactId>/{n;s/.*<version>([^<]+)<\/version>.*/\1/p}' java/pom.xml)
  [rust]=$(sed -nE '0,/^version = "([^"]+)"/s//\1/p' rust/Cargo.toml)
)

expected=${1:-${found[typescript]}}
fail=0
for sdk in "${!found[@]}"; do
  if [[ "${found[$sdk]}" != "$expected" ]]; then
    echo "::error::$sdk is at '${found[$sdk]}', expected '$expected'"
    fail=1
  fi
done
for sdk in typescript python dotnet java go rust; do
  grep -q "## \[$expected\]" "$sdk/CHANGELOG.md" || { echo "::error::$sdk/CHANGELOG.md has no [$expected] section"; fail=1; }
done
[[ $fail -eq 0 ]] && echo "All SDKs are at $expected."
exit $fail
