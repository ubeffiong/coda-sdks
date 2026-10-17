# Releasing the SDKs

All six SDKs share one version and are released together from this repository (`ubeffiong/coda-sdks`):

1. **Tag** `vX.Y.Z`. [`release.yml`](.github/workflows/release.yml) then does three things:
   - tests and packages every SDK;
   - attaches the packages and SHA256SUMS to a GitHub Release, where `install.sh`, `install.ps1` and the CODA Developer hub install from;
   - tags the Go module `go/vX.Y.Z`.
2. **Publishing the release** runs [`publish.yml`](.github/workflows/publish.yml), which uploads to the registries below. Running it by hand with **dry-run** builds and validates without uploading.

The SDK sources live in `sdks/` of the private CODA repository. `scripts/sync-public.sh` publishes that folder here, with its history.

| Registry | Package | Published by |
|---|---|---|
| npm | `@coda-terminology/client` | `npm publish --provenance` |
| PyPI | `coda-client` | `twine upload` (sdist and wheel) |
| NuGet | `Coda.Client` | `dotnet nuget push` (package and symbols) |
| Maven Central | `io.github.ubeffiong:coda-client` | `mvn -P release deploy` (signed jar, sources, javadoc) |
| crates.io | `coda-client` | `cargo publish` |
| Go modules | `github.com/ubeffiong/coda-sdks/go` | tag `go/vX.Y.Z` |

## One-time set-up

1. **Repository.** This repository, `github.com/ubeffiong/coda-sdks`, is public. The package metadata and the Go module path point here; the Maven namespace `io.github.ubeffiong` is verified through the same GitHub account.
2. **Protected environment.** In GitHub, create the environment `sdk-release` with required reviewers. Every publishing job waits for that approval.
3. **Registry accounts and secrets.** Create these as secrets of the `sdk-release` environment:

| Registry | One-time step | Secret(s) |
|---|---|---|
| npm | Create the free organisation `coda-terminology`, then an automation (granular) token with publish rights to it | `NPM_TOKEN` |
| PyPI | Create the account and an API token (scope it to `coda-client` after the first upload) | `PYPI_API_TOKEN` |
| NuGet | Create an API key with the glob `Coda.Client*` | `NUGET_API_KEY` |
| Maven Central | Sign in at central.sonatype.com with the GitHub account `ubeffiong`, so `io.github.ubeffiong` is verified. Generate a user token. Create a GPG key and publish its public part to `keys.openpgp.org` | `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `MAVEN_GPG_PRIVATE_KEY` (armoured), `MAVEN_GPG_PASSPHRASE` |
| crates.io | Sign in with GitHub and create a token with the `publish-new` and `publish-update` scopes | `CARGO_REGISTRY_TOKEN` |
| Go | Nothing to set up: the module proxy serves public tags | none |

Package names were checked as free on 2026-10-17. Except for npm, the first upload claims the name, so release soon or re-check before the first release.

## Each release

1. **Bump the version** in every SDK: `typescript/package.json`, `python/pyproject.toml` and `python/src/coda_client/__init__.py`, `dotnet/src/Coda.Client/Coda.Client.csproj`, `java/pom.xml` and `rust/Cargo.toml`. Go takes its version from the tag.
2. **Update the changelogs.** In each `CHANGELOG.md`, move the items under **Unreleased** to a new `## [X.Y.Z] - date` section.
3. **Check:** run `bash scripts/check-versions.sh X.Y.Z`.
4. **Dry run:** run the `publish` workflow by hand with **dry-run** on.
5. **Publish and tag** from the CODA checkout: `bash sdks/scripts/sync-public.sh vX.Y.Z`. That pushes `main` and the tag, and `release.yml` creates the GitHub Release. Then approve the `sdk-release` environment for `publish.yml`.
6. **Turn on registry installs in the Developer hub:** once each registry shows the release, set `"published": true` for it in [`registry.json`](registry.json). The hub then leads with the registry install command.

Versions follow Semantic Versioning. Before 1.0.0, a minor version may contain breaking changes; call them out under **Changed** in the changelog.

## Self-hosted copies

CODA also serves every SDK from its own `/sdks/` path: a source zip per language plus the npm tarball, with SHA-256 checksums in `manifest.json`. This is for offline or air-gapped sites. `CODA-Web/scripts/pack-sdks.mjs` builds them before `npm run dev` and `npm run build`.
