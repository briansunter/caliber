# Changelog

## [0.1.15](https://github.com/briansunter/caliber/compare/v0.1.14...v0.1.15) (2026-10-02)


### Features

* filter books by file type with Formats toolbar button ([34f1ee2](https://github.com/briansunter/caliber/commit/34f1ee2feb027e5a9a96a9c9525ec2f2e7d89f7a))
* redesign library UI and improve reliability ([405509c](https://github.com/briansunter/caliber/commit/405509c2378ba7ad9897b8a51c16bdc2da3234bf))

## [0.1.14](https://github.com/briansunter/caliber/compare/v0.1.13...v0.1.14) (2026-09-09)


### Features

* single and side-by-side page layouts for EPUB and PDF readers ([5eee5ed](https://github.com/briansunter/caliber/commit/5eee5ed8d4fd4c65c87d5b702b86378bd988bbc7))

## [0.1.13](https://github.com/briansunter/caliber/compare/v0.1.12...v0.1.13) (2026-09-09)


### Bug Fixes

* ignore Range on stale If-Range instead of serving 206 ([7b13ad4](https://github.com/briansunter/caliber/commit/7b13ad40f1297f350e594ea05fd1d3dba7963b29))

## [0.1.12](https://github.com/briansunter/caliber/compare/v0.1.11...v0.1.12) (2026-09-09)


### Features

* PDF fit-screen and actual-size zoom, progress sync and endpoint hardening ([0f06ad9](https://github.com/briansunter/caliber/commit/0f06ad9e347820610f8b19e1d054754d0c8b950f))

## [0.1.11](https://github.com/briansunter/caliber/compare/v0.1.10...v0.1.11) (2026-09-09)


### Features

* redesign library UI with shared reader chrome and accessibility pass ([0f5950e](https://github.com/briansunter/caliber/commit/0f5950e90fe9c47dec05197b0f9a3b068c15fbc2))


### Bug Fixes

* harden pagination, host validation, and reader progress persistence ([ea90b47](https://github.com/briansunter/caliber/commit/ea90b473f7e2b2a1876d8e028e6195de6d2894b1))
* implement caliber audit F01-F32 (progress identity, auth, perf, OPDS, UI) ([b8b1bd3](https://github.com/briansunter/caliber/commit/b8b1bd32450fa0a3ca4b427b2fa68304ce450871))
* ordered progress delivery, format-scoped restore, thumbnail fallback, cache identity ([357a203](https://github.com/briansunter/caliber/commit/357a203dcdedb1b4004d835e6c8e8c222e58b2b6))
* revision-ordered progress, identity-checked delivery, cache rebuild, measured virtualizer ([1e402e5](https://github.com/briansunter/caliber/commit/1e402e5b097a9e2373e519b45ac575fef4d11e0f))
* use sharp for cover thumbnail resizing ([a3cd451](https://github.com/briansunter/caliber/commit/a3cd451f6ba18efe1dd33a5184aae5747fa61775))
* wire library/format identity, transactional outbox, display-verified saves, truthful smoke ([c7732c7](https://github.com/briansunter/caliber/commit/c7732c7a529de10b4677f16f5bfba5ae64e38788))

## [0.1.10](https://github.com/briansunter/caliber/compare/v0.1.9...v0.1.10) (2026-08-20)


### Features

* enable and configure authentication from the Settings UI ([351601e](https://github.com/briansunter/caliber/commit/351601e88f9232959304855b0f55c67a7a692853))

## [0.1.9](https://github.com/briansunter/caliber/compare/v0.1.8...v0.1.9) (2026-08-20)


### Features

* add optional multi-user authentication for web, API, and OPDS ([88887b6](https://github.com/briansunter/caliber/commit/88887b6a320653042f70634b8d9d1675ac97b0d8))

## [0.1.8](https://github.com/briansunter/caliber/compare/v0.1.7...v0.1.8) (2026-08-20)


### Bug Fixes

* keep detail page back inside app ([67d5352](https://github.com/briansunter/caliber/commit/67d53523d668d994c788c6ec315b0ff33464153e))

## [0.1.7](https://github.com/briansunter/caliber/compare/v0.1.6...v0.1.7) (2026-08-20)


### Bug Fixes

* keep reader back inside app and fix detail button contrast ([2e1b706](https://github.com/briansunter/caliber/commit/2e1b7062bcee931df29b2c72242ab5587846ffc9))

## [0.1.6](https://github.com/briansunter/caliber/compare/v0.1.5...v0.1.6) (2026-07-15)


### Bug Fixes

* make bunx css independent of caller cwd ([179f270](https://github.com/briansunter/caliber/commit/179f270e4036c465f8be0dc323dd85995cdab835))

## [0.1.5](https://github.com/briansunter/caliber/compare/v0.1.4...v0.1.5) (2026-07-15)


### Bug Fixes

* wait for frontend before opening browser ([eae680e](https://github.com/briansunter/caliber/commit/eae680e61f3b6a06ec9cdbceca97b24b7206941a))

## [0.1.4](https://github.com/briansunter/caliber/compare/v0.1.3...v0.1.4) (2026-07-15)


### Bug Fixes

* open browser only with a ready library ([4bf61e3](https://github.com/briansunter/caliber/commit/4bf61e3e115c6593beb3427795fb003dcc663de7))

## [0.1.3](https://github.com/briansunter/caliber/compare/v0.1.2...v0.1.3) (2026-07-15)


### Bug Fixes

* include tailwindcss at runtime ([9372c9e](https://github.com/briansunter/caliber/commit/9372c9e06a54d7bdfa66fa95b80a05fc393e062d))

## [0.1.2](https://github.com/briansunter/caliber/compare/v0.1.1...v0.1.2) (2026-07-15)


### Bug Fixes

* add bunx browser launcher ([11e60dc](https://github.com/briansunter/caliber/commit/11e60dc0de88bdec9b1fb344ed624721ab032592))

## [0.1.1](https://github.com/briansunter/caliber/compare/v0.1.0...v0.1.1) (2026-07-15)


### Features

* automate package releases ([310f8d3](https://github.com/briansunter/caliber/commit/310f8d3b20acbd0412e19efa254a6bd5ea58d5be))


### Bug Fixes

* align release please tags ([56cce10](https://github.com/briansunter/caliber/commit/56cce102181aa6fb5411698334c950c55e860a84))
