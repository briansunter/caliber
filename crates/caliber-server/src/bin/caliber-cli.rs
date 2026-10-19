//! `caliber-cli` — Rust port of `bun src/cli.ts`.

#[path = "common/adapters.rs"]
#[allow(dead_code)]
mod adapters;
#[path = "common/cli_core.rs"]
#[allow(dead_code)]
mod cli_core;
#[path = "common/fixtures.rs"]
#[allow(dead_code)]
mod fixtures;
#[path = "common/mcp_core.rs"]
#[allow(dead_code)]
mod mcp_core;
#[path = "common/traits.rs"]
#[allow(dead_code)]
mod traits;

use std::io::{IsTerminal, Write};
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = caliber_common::Config::load();

    let db = Arc::new(caliber_db::CaliberDb::open(config.clone()));
    let user_db = Arc::new(caliber_user::UserDb::open(&config));
    let auth = Arc::new(caliber_user::Auth::with_cookie_secure(
        user_db,
        config.resolved().cookie_secure,
    ));

    let catalog = adapters::RealCatalog {
        db: db.clone(),
        config: config.clone(),
    };
    let users = adapters::RealUsers { auth };

    let stdin = std::io::stdin();
    let mut stdin_lock = stdin.lock();
    let interactive = std::io::stdin().is_terminal();
    let mut prompt_fn = |question: &str| -> Result<String, String> {
        rpassword::prompt_password(question).map_err(|e| e.to_string())
    };

    let output = if interactive {
        cli_core::run_cli(
            &catalog,
            &users,
            &args,
            &mut stdin_lock,
            Some(&mut prompt_fn as &mut dyn FnMut(&str) -> Result<String, String>),
        )
    } else {
        cli_core::run_cli(&catalog, &users, &args, &mut stdin_lock, None)
    };

    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(output.stdout.as_bytes());
    let _ = stdout.flush();
    let mut stderr = std::io::stderr();
    let _ = stderr.write_all(output.stderr.as_bytes());
    let _ = stderr.flush();
    std::process::exit(output.exit_code);
}
