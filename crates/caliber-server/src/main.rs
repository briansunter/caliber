//! caliber-server entry point: wires the real backends (CaliberDb + UserDb /
//! Auth) into the router and runs it. The library surface (`build_router`,
//! `run`, `app_state`) is exercised by the mock-based route tests; this main
//! is deliberately thin.

use caliber_server::adapters::{RealDb, RealUsers};
use std::sync::Arc;

fn main() -> std::io::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async_main())
}

async fn async_main() -> std::io::Result<()> {
    let config = caliber_common::Config::load();

    // initFTS semantics: a failed init leaves the server up (ready=false) so
    // the Settings UI can select a different library.
    let db = Arc::new(caliber_db::CaliberDb::open(config.clone()));
    db.init();

    let user_db = Arc::new(caliber_user::UserDb::open(&config));
    let auth = Arc::new(caliber_user::Auth::with_cookie_secure(
        user_db,
        config.resolved().cookie_secure,
    ));

    let state = caliber_server::app_state(
        config.clone(),
        Arc::new(RealDb { db, config }),
        Arc::new(RealUsers { auth }),
        caliber_server::resolve_static_dir(),
    );
    caliber_server::run(state).await
}
