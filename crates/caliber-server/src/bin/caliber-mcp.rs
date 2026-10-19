//! `caliber-mcp` — standalone stdio MCP server, Rust port of
//! `bun src/mcp-server.ts`.

#[path = "common/adapters.rs"]
#[allow(dead_code)]
mod adapters;
#[path = "common/fixtures.rs"]
#[allow(dead_code)]
mod fixtures;
#[path = "common/mcp_core.rs"]
#[allow(dead_code)]
mod mcp_core;
#[path = "common/traits.rs"]
#[allow(dead_code)]
mod traits;

use std::io::{Read, Write};
use std::sync::Arc;

fn main() {
    let config = caliber_common::Config::load();
    let db = Arc::new(caliber_db::CaliberDb::open(config.clone()));
    db.init();

    let source = adapters::RealMcpSource { db };
    let mut framer = mcp_core::StdioFramer::new();

    let mut stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut buffer = [0u8; 8192];
    loop {
        let read = match stdin.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
        let responses = framer.push(&source, &chunk);
        for line in responses {
            let _ = stdout.write_all(line.as_bytes());
        }
        let _ = stdout.flush();
    }
    for line in framer.finish(&source) {
        let _ = stdout.write_all(line.as_bytes());
    }
    let _ = stdout.flush();
}
