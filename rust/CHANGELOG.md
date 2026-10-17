# Changelog

All notable changes to `coda-client` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0, minor versions may contain breaking changes.

## [Unreleased]

## [0.2.0] - 2026-10-17

### Added
- `open_connect_session()` and `get_connect_session()`: open a CODA Connect session from your server (authenticate with an integration key as the token), with an opaque `patientRef` and `encounterRef`, and an optional `clinician` whose launch URL signs them into that one session without a CODA login.

## [0.1.0] - 2026-10-17

### Added
- First public release.
- Operations: systems, lookup, search, validate, batch and FHIR validation, expand, translate, phrase analysis and decision recording.
- Bearer token or token provider, request ids, retries with `Retry-After`, and typed API errors.
- Standard Webhooks signature verification.
