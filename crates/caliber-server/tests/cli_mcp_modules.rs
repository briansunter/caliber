//! Mounts the CLI/MCP module tests so `cargo test -p caliber-server` runs
//! them. The real-crate adapters in `common/adapters.rs` are exercised by the
//! binaries, not this target, so dead-code warnings are suppressed.

#[path = "../src/bin/common/cli_core.rs"]
#[allow(dead_code)]
mod cli_core;
#[path = "../src/bin/common/fixtures.rs"]
#[allow(dead_code)]
mod fixtures;
#[path = "../src/bin/common/mcp_core.rs"]
#[allow(dead_code)]
mod mcp_core;
#[path = "../src/bin/common/traits.rs"]
#[allow(dead_code)]
mod traits;
