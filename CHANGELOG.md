# Changelog

## [Unreleased]

## [0.4.0] - 2026-11-10

### Added
- **redis**: reusable worker singleton lock and healthcheck.
- **redis**: paginated request index, cursor and list use case.
- **redis**: shared rate limiter with cooldown (`reportCooldown`).
- **s3**: AWS object storage adapter and ZIP archive stream (AWS SDK and archiver as optional peers).
- **auth**: OAuth client-credentials token pool (body or Basic auth).
- **http**: Swagger docs page and JSON logger helpers.
- **http**: `manufacturers` in the v1 router may be an async source.

### Fixed
- **openapi**: emit JSON Schema for zod selection and resume schemas.
