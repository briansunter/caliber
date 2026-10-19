//! `caliber-cli` command core — port of `src/cli.ts`.
//!
//! Fully testable: the catalog/users backends are traits, stdin is a
//! `Read`, and the hidden password prompt is a callback (the real binary
//! passes `rpassword`; tests pass a fake or `None` for non-TTY behavior).

use caliber_common::types::{BookListItem, ListOptions, SortField, SortOrder};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

use super::traits::{CatalogSource, UserAdmin};

pub const MIN_PASSWORD_LENGTH: usize = 8;

pub struct CliOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Hidden-prompt callback reference: shows the question, returns the typed
/// value. Two lifetimes (reference vs closure capture) so reborrows stay
/// possible.
pub type PasswordPrompt<'a, 'p> = &'a mut (dyn FnMut(&str) -> Result<String, String> + 'p);
pub struct CliError(pub String, pub i32);

impl CliError {
    fn usage(message: impl Into<String>) -> CliError {
        CliError(message.into(), 2)
    }
}

// ---------------------------------------------------------------------------
// Argument parsing (port of parseArgs)
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct ParsedArgs {
    pub command: Option<String>,
    pub positionals: Vec<String>,
    /// flag -> value; `true` for boolean flags, strings for value flags.
    pub flags: Vec<(String, Value)>,
}

pub fn parse_args(argv: &[String]) -> ParsedArgs {
    let mut parsed = ParsedArgs::default();
    let mut rest: &[String] = argv;
    if let Some(first) = argv.first() {
        if !first.starts_with('-') {
            parsed.command = Some(first.clone());
            rest = &argv[1..];
        }
    }
    let mut i = 0usize;
    while i < rest.len() {
        let token = &rest[i];
        if token == "--" {
            for item in &rest[i + 1..] {
                parsed.positionals.push(item.clone());
            }
            break;
        }
        if token == "--help" || token == "-h" {
            set_flag(&mut parsed.flags, "help", Value::Bool(true));
            i += 1;
            continue;
        }
        if let Some(body) = token.strip_prefix("--") {
            if body.is_empty() {
                i += 1;
                continue;
            }
            if let Some(eq) = body.find('=') {
                let key = &body[..eq];
                let value = &body[eq + 1..];
                if !key.is_empty() {
                    set_flag(&mut parsed.flags, key, Value::String(value.to_string()));
                }
                i += 1;
                continue;
            }
            let next = rest.get(i + 1);
            match next {
                Some(n) if !n.starts_with('-') => {
                    set_flag(&mut parsed.flags, body, Value::String(n.clone()));
                    i += 2;
                }
                _ => {
                    set_flag(&mut parsed.flags, body, Value::Bool(true));
                    i += 1;
                }
            }
            continue;
        }
        parsed.positionals.push(token.clone());
        i += 1;
    }
    parsed
}

fn set_flag(flags: &mut Vec<(String, Value)>, key: &str, value: Value) {
    if let Some(slot) = flags.iter_mut().find(|(k, _)| k == key) {
        slot.1 = value;
    } else {
        flags.push((key.to_string(), value));
    }
}

fn flag_value<'a>(parsed: &'a ParsedArgs, name: &str) -> Option<&'a Value> {
    parsed.flags.iter().find(|(k, _)| k == name).map(|(_, v)| v)
}

pub fn has_flag(parsed: &ParsedArgs, name: &str) -> bool {
    parsed.flags.iter().any(|(k, _)| k == name)
}

fn string_flag(parsed: &ParsedArgs, name: &str) -> Option<String> {
    match flag_value(parsed, name) {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

const GLOBAL_FLAGS: &[&str] = &["help"];

fn command_flags(command: &str) -> Option<&'static [&'static str]> {
    Some(match command {
        "health" => &[],
        "stats" => &[],
        "count" => &[],
        "list" => &["limit", "cursor", "sortBy", "sortOrder", "table"],
        "search" => &["query", "limit", "cursor", "table"],
        "get" => &["id"],
        "stream" => &["batchSize", "limit", "jsonl"],
        "search-title" => &["title", "count", "table"],
        "search-author" => &["author", "count", "table"],
        "author-info" => &["author"],
        "library-path" => &[],
        "format-path" => &["id", "format"],
        "cover-path" => &["id"],
        "download" => &["id", "format", "out"],
        "cover" => &["id", "out"],
        "init-fts" => &[],
        "user" => &["password-stdin"],
        _ => return None,
    })
}

fn validate_flags(parsed: &ParsedArgs, command: &str) -> Result<(), CliError> {
    let Some(allowed) = command_flags(command) else {
        return Ok(());
    };
    for (flag, _) in &parsed.flags {
        if !GLOBAL_FLAGS.contains(&flag.as_str()) && !allowed.contains(&flag.as_str()) {
            return Err(CliError::usage(format!(
                "Unknown option --{flag} for command {command}"
            )));
        }
    }
    Ok(())
}

fn validate_positionals(parsed: &ParsedArgs, command: &str, max: usize) -> Result<(), CliError> {
    if parsed.positionals.len() > max {
        return Err(CliError::usage(format!(
            "Too many positional arguments for command {command}"
        )));
    }
    Ok(())
}

fn string_arg(
    parsed: &ParsedArgs,
    flag: &str,
    positional_index: Option<usize>,
    required: bool,
    description: &str,
) -> Result<String, CliError> {
    if let Some(v) = string_flag(parsed, flag) {
        if !v.trim().is_empty() {
            return Ok(v.trim().to_string());
        }
    }
    if let Some(index) = positional_index {
        if let Some(p) = parsed.positionals.get(index) {
            if !p.trim().is_empty() {
                return Ok(p.trim().to_string());
            }
        }
    }
    if required {
        return Err(CliError(
            format!("Missing required {description}. Use --{flag}."),
            1,
        ));
    }
    Ok(String::new())
}

fn parse_integer(value: &str, description: &str) -> Result<i64, CliError> {
    let ok =
        !value.is_empty() && value.chars().all(|c| c.is_ascii_digit() || c == '-') && value != "-";
    if !ok {
        return Err(CliError(format!("Invalid {description}: {value}"), 1));
    }
    value
        .parse::<i64>()
        .map_err(|_| CliError(format!("Invalid {description}: {value}"), 1))
}

fn number_arg(
    parsed: &ParsedArgs,
    name: &str,
    default: Option<i64>,
    min: Option<i64>,
    max: Option<i64>,
) -> Result<Option<i64>, CliError> {
    let Some(raw) = string_flag(parsed, name) else {
        return Ok(default);
    };
    let value = parse_integer(&raw, name)?;
    if let Some(min) = min {
        if value < min {
            return Err(CliError(format!("--{name} must be >= {min}"), 1));
        }
    }
    if let Some(max) = max {
        if value > max {
            return Err(CliError(format!("--{name} must be <= {max}"), 1));
        }
    }
    Ok(Some(value))
}

fn required_id(parsed: &ParsedArgs) -> Result<i64, CliError> {
    match number_arg(parsed, "id", None, Some(1), None)? {
        Some(id) => Ok(id),
        None => Err(CliError("Missing required --id <n>".into(), 1)),
    }
}

fn cli_sort_field(parsed: &ParsedArgs) -> Result<SortField, CliError> {
    match string_flag(parsed, "sortBy").as_deref() {
        None => Ok(SortField::Title),
        Some("title") => Ok(SortField::Title),
        Some("author") => Ok(SortField::Author),
        Some("added") => Ok(SortField::Added),
        Some("rating") => Ok(SortField::Rating),
        Some(other) => Err(CliError::usage(format!(
            "--sortBy must be one of: title, author, added, rating ({other} invalid)"
        ))),
    }
}

fn sort_order(parsed: &ParsedArgs) -> Result<SortOrder, CliError> {
    match string_flag(parsed, "sortOrder").as_deref() {
        None => Ok(SortOrder::Asc),
        Some("asc") => Ok(SortOrder::Asc),
        Some("desc") => Ok(SortOrder::Desc),
        Some(other) => Err(CliError::usage(format!(
            "--sortOrder must be one of: asc, desc ({other} invalid)"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

fn to_pretty_json(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

fn print_book_table(books: &[BookListItem]) -> String {
    if books.is_empty() {
        return "No books found.\n".to_string();
    }
    // Simple aligned table (the TS uses console.table; visual parity is not
    // part of the compatibility contract — JSON output is authoritative).
    let rows: Vec<(String, String, String, String, String)> = books
        .iter()
        .map(|b| {
            (
                b.id.to_string(),
                b.title.clone(),
                b.authors.join(", "),
                b.series.clone().unwrap_or_default(),
                b.formats.join(", "),
            )
        })
        .collect();
    let headers = ["id", "title", "authors", "series", "formats"];
    let mut widths: Vec<usize> = headers.iter().map(|h| h.len()).collect();
    for row in &rows {
        let cells = [
            row.0.as_str(),
            row.1.as_str(),
            row.2.as_str(),
            row.3.as_str(),
            row.4.as_str(),
        ];
        for (i, cell) in cells.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    let mut out = String::new();
    let header_line: String = headers
        .iter()
        .enumerate()
        .map(|(i, h)| format!("{:<width$}", h, width = widths[i]))
        .collect::<Vec<_>>()
        .join("  ");
    out.push_str(&header_line);
    out.push('\n');
    out.push_str(&"-".repeat(header_line.len()));
    out.push('\n');
    for row in &rows {
        let cells = [
            row.0.as_str(),
            row.1.as_str(),
            row.2.as_str(),
            row.3.as_str(),
            row.4.as_str(),
        ];
        let line: String = cells
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{:<width$}", c, width = widths[i]))
            .collect::<Vec<_>>()
            .join("  ");
        out.push_str(&line);
        out.push('\n');
    }
    out
}

fn copy_file(source: &Path, output: &Path) -> Result<(String, String, u64), CliError> {
    // Guard: copying a file onto itself would truncate it to 0 bytes with
    // std::fs::copy (the TS CLI can reach this via `download --out` naming
    // the source; report the size instead of destroying the file).
    let same_path = source == output
        || (output.exists()
            && std::fs::canonicalize(source).ok() == std::fs::canonicalize(output).ok());
    if same_path {
        let bytes = std::fs::metadata(source).map(|m| m.len()).unwrap_or(0);
        return Ok((
            source.display().to_string(),
            output.display().to_string(),
            bytes,
        ));
    }
    let bytes = std::fs::copy(source, output)
        .map_err(|_| CliError(format!("Source file not found: {}", source.display()), 1))?;
    Ok((
        source.display().to_string(),
        output.display().to_string(),
        bytes,
    ))
}

// ---------------------------------------------------------------------------
// Password input
// ---------------------------------------------------------------------------

fn read_password_input(
    parsed: &ParsedArgs,
    stdin: &mut dyn Read,
    prompt: Option<PasswordPrompt<'_, '_>>,
) -> Result<String, CliError> {
    if has_flag(parsed, "password-stdin") {
        let mut data = String::new();
        stdin
            .read_to_string(&mut data)
            .map_err(|e| CliError(format!("Could not read password from stdin: {e}"), 1))?;
        let password = data.trim_end_matches(['\r', '\n']).to_string();
        if password.is_empty() {
            return Err(CliError("Password read from stdin was empty".into(), 1));
        }
        return Ok(password);
    }
    let Some(prompt) = prompt else {
        return Err(CliError(
            "Interactive password prompt requires a terminal; use --password-stdin".into(),
            1,
        ));
    };
    let first = prompt("Password: ").map_err(|m| CliError(m, 1))?;
    let second = prompt("Confirm password: ").map_err(|m| CliError(m, 1))?;
    if first != second {
        return Err(CliError("Passwords do not match".into(), 1));
    }
    Ok(first)
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

pub fn run_cli<C: CatalogSource, U: UserAdmin>(
    catalog: &C,
    users: &U,
    argv: &[String],
    stdin: &mut dyn Read,
    prompt: Option<PasswordPrompt<'_, '_>>,
) -> CliOutput {
    match run_cli_inner(catalog, users, argv, stdin, prompt) {
        Ok((out, exit_code)) => CliOutput {
            stdout: out,
            stderr: String::new(),
            exit_code,
        },
        Err(err) => CliOutput {
            stdout: String::new(),
            stderr: format!(
                "Error: {}\n{}",
                err.0,
                if err.1 == 2 {
                    "\nUse --help for usage.\n"
                } else {
                    ""
                }
            ),
            exit_code: err.1,
        },
    }
}

type InnerResult = Result<(String, i32), CliError>;

fn run_cli_inner<C: CatalogSource, U: UserAdmin>(
    catalog: &C,
    users: &U,
    argv: &[String],
    stdin: &mut dyn Read,
    prompt: Option<PasswordPrompt<'_, '_>>,
) -> InnerResult {
    let inner = |stdin: &mut dyn Read, prompt: Option<PasswordPrompt<'_, '_>>| -> InnerResult {
        let parsed = parse_args(argv);
        let command = parsed
            .command
            .clone()
            .unwrap_or_else(|| "help".to_string())
            .to_lowercase();

        if has_flag(&parsed, "help") || command == "help" {
            return Ok((help_text().to_string(), 0));
        }

        // Every command may be the first process touching the library; user
        // management and init-fts handle initialization themselves (TS main).
        if !matches!(command.as_str(), "init-fts" | "user") {
            catalog.init();
        }

        let out = match command.as_str() {
            "health" => return cmd_health(catalog, &parsed),
            "stats" => {
                validate_flags(&parsed, "stats")?;
                validate_positionals(&parsed, "stats", 0)?;
                let stats = catalog.get_library_stats().map_err(|m| CliError(m, 1))?;
                to_pretty_json(&serde_json::to_value(&stats).unwrap_or(Value::Null))
            }
            "count" => {
                validate_flags(&parsed, "count")?;
                validate_positionals(&parsed, "count", 0)?;
                let count = catalog.get_book_count().map_err(|m| CliError(m, 1))?;
                to_pretty_json(&json!({ "count": count }))
            }
            "list" => cmd_list(catalog, &parsed)?,
            "search" => cmd_search(catalog, &parsed)?,
            "get" => {
                validate_flags(&parsed, "get")?;
                validate_positionals(&parsed, "get", 0)?;
                let id = required_id(&parsed)?;
                match catalog.get_book(id).map_err(|m| CliError(m, 1))? {
                    Some(book) => {
                        to_pretty_json(&serde_json::to_value(&book).unwrap_or(Value::Null))
                    }
                    None => return Err(CliError(format!("Book not found for id {id}"), 2)),
                }
            }
            "stream" => cmd_stream(catalog, &parsed)?,
            "search-title" => {
                validate_flags(&parsed, "search-title")?;
                validate_positionals(&parsed, "search-title", 1)?;
                let title = string_arg(&parsed, "title", Some(0), true, "title")?;
                let count = number_arg(&parsed, "count", Some(10), Some(1), Some(100))?
                    .unwrap_or(10) as u32;
                let books = catalog.search_books_by_title(&title, count);
                render_book_list(&parsed, books)?
            }
            "search-author" => {
                validate_flags(&parsed, "search-author")?;
                validate_positionals(&parsed, "search-author", 1)?;
                let author = string_arg(&parsed, "author", Some(0), true, "author")?;
                let count = number_arg(&parsed, "count", Some(10), Some(1), Some(100))?
                    .unwrap_or(10) as u32;
                let books = catalog.search_books_by_author(&author, count);
                render_book_list(&parsed, books)?
            }
            "author-info" => {
                validate_flags(&parsed, "author-info")?;
                validate_positionals(&parsed, "author-info", 1)?;
                let author = string_arg(&parsed, "author", Some(0), true, "author")?;
                match catalog.get_author_by_name(&author) {
                    Some(info) => {
                        to_pretty_json(&serde_json::to_value(&info).unwrap_or(Value::Null))
                    }
                    None => return Err(CliError(format!("No author matched: {author}"), 2)),
                }
            }
            "library-path" => {
                validate_flags(&parsed, "library-path")?;
                validate_positionals(&parsed, "library-path", 0)?;
                to_pretty_json(&json!({ "path": catalog.library_path().display().to_string() }))
            }
            "format-path" => {
                validate_flags(&parsed, "format-path")?;
                validate_positionals(&parsed, "format-path", 0)?;
                let id = required_id(&parsed)?;
                let format = string_arg(&parsed, "format", None, true, "format")?.to_uppercase();
                match catalog.book_format_path(id, &format) {
                    Some(path) => to_pretty_json(&json!({
                        "id": id, "format": format, "path": path.display().to_string()
                    })),
                    None => {
                        return Err(CliError(
                            format!("Format {format} not found for book id {id}"),
                            2,
                        ))
                    }
                }
            }
            "cover-path" => {
                validate_flags(&parsed, "cover-path")?;
                validate_positionals(&parsed, "cover-path", 0)?;
                let id = required_id(&parsed)?;
                match catalog.book_cover_path(id) {
                    Some(path) => {
                        to_pretty_json(&json!({ "id": id, "path": path.display().to_string() }))
                    }
                    None => return Err(CliError(format!("Cover not found for book id {id}"), 2)),
                }
            }
            "download" => {
                validate_flags(&parsed, "download")?;
                validate_positionals(&parsed, "download", 0)?;
                let id = required_id(&parsed)?;
                let format = string_arg(&parsed, "format", None, true, "format")?.to_uppercase();
                let source = catalog.book_format_path(id, &format).ok_or_else(|| {
                    CliError(format!("Format {format} not found for book id {id}"), 2)
                })?;
                let output = string_flag(&parsed, "out").unwrap_or_else(|| file_name_of(&source));
                let (s, o, bytes) = copy_file(Path::new(&source), Path::new(&output))?;
                to_pretty_json(&json!({ "sourcePath": s, "outputPath": o, "bytes": bytes }))
            }
            "cover" => {
                validate_flags(&parsed, "cover")?;
                validate_positionals(&parsed, "cover", 0)?;
                let id = required_id(&parsed)?;
                let source = catalog
                    .book_cover_path(id)
                    .ok_or_else(|| CliError(format!("Cover not found for book id {id}"), 2))?;
                let output =
                    string_flag(&parsed, "out").unwrap_or_else(|| format!("{id}-cover.jpg"));
                let (s, o, bytes) = copy_file(Path::new(&source), Path::new(&output))?;
                to_pretty_json(&json!({ "sourcePath": s, "outputPath": o, "bytes": bytes }))
            }
            "init-fts" => {
                validate_flags(&parsed, "init-fts")?;
                validate_positionals(&parsed, "init-fts", 0)?;
                catalog.init();
                to_pretty_json(&json!({ "initialized": true }))
            }
            "user" => {
                validate_flags(&parsed, "user")?;
                cmd_user(users, &parsed, stdin, prompt)?
            }
            other => return Err(CliError::usage(format!("Unknown command: {other}"))),
        };
        Ok((out, 0))
    };
    inner(stdin, prompt)
}

fn file_name_of(path: &PathBuf) -> String {
    path.file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

fn cmd_health<C: CatalogSource>(
    catalog: &C,
    parsed: &ParsedArgs,
) -> Result<(String, i32), CliError> {
    validate_flags(parsed, "health")?;
    validate_positionals(parsed, "health", 0)?;
    let library_path = catalog.library_path();
    let _db_path = library_path.join(catalog.db_name());
    let source_exists = catalog.source_db_exists();
    let (db_ok, book_count) = match catalog.get_book_count() {
        Ok(count) => (true, count),
        Err(_) => (false, 0),
    };
    let status_ok = source_exists && db_ok;
    let out = to_pretty_json(&json!({
        "status": if status_ok { "ok" } else { "error" },
        "timestamp": crate_time_ms(),
        "libraryPath": library_path.display().to_string(),
        "sourceDbExists": source_exists,
        "dbQueryable": db_ok,
        "bookCount": if db_ok { Value::from(book_count) } else { Value::Null },
    }));
    if !status_ok {
        // TS prints the JSON payload and sets process.exitCode = 1.
        return Ok((out, 1));
    }
    Ok((out, 0))
}

fn crate_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn render_book_list(parsed: &ParsedArgs, books: Vec<BookListItem>) -> Result<String, CliError> {
    if has_flag(parsed, "table") {
        return Ok(print_book_table(&books));
    }
    Ok(to_pretty_json(
        &serde_json::to_value(&books).unwrap_or(Value::Null),
    ))
}

fn cmd_list<C: CatalogSource>(catalog: &C, parsed: &ParsedArgs) -> Result<String, CliError> {
    validate_flags(parsed, "list")?;
    validate_positionals(parsed, "list", 0)?;
    let limit = number_arg(parsed, "limit", Some(50), Some(1), Some(100))?.unwrap_or(50) as u32;
    let cursor = string_flag(parsed, "cursor");
    let sort_by = cli_sort_field(parsed)?;
    let order = sort_order(parsed)?;

    let opts = ListOptions {
        cursor,
        limit: Some(limit),
        sort_by: Some(sort_by),
        sort_order: Some(order),
        ..Default::default()
    };
    let result = catalog.list_books(&opts).map_err(|m| CliError(m, 1))?;
    if has_flag(parsed, "table") {
        let mut out = print_book_table(&result.items);
        out.push_str(&format!(
            "nextCursor: {}\n",
            result.next_cursor.as_deref().unwrap_or("null")
        ));
        return Ok(out);
    }
    Ok(to_pretty_json(
        &serde_json::to_value(&result).unwrap_or(Value::Null),
    ))
}

fn cmd_search<C: CatalogSource>(catalog: &C, parsed: &ParsedArgs) -> Result<String, CliError> {
    validate_flags(parsed, "search")?;
    validate_positionals(parsed, "search", 1)?;
    let query = string_arg(parsed, "query", Some(0), true, "query")?;
    let limit = number_arg(parsed, "limit", Some(50), Some(1), Some(100))?.unwrap_or(50) as u32;
    let cursor = string_flag(parsed, "cursor");
    let opts = ListOptions {
        cursor,
        limit: Some(limit),
        ..Default::default()
    };
    let result = catalog
        .search_books(&opts, &query)
        .map_err(|m| CliError(m, 1))?;
    if has_flag(parsed, "table") {
        let mut out = print_book_table(&result.items);
        out.push_str(&format!(
            "nextCursor: {}\n",
            result.next_cursor.as_deref().unwrap_or("null")
        ));
        return Ok(out);
    }
    Ok(to_pretty_json(
        &serde_json::to_value(&result).unwrap_or(Value::Null),
    ))
}

fn cmd_stream<C: CatalogSource>(catalog: &C, parsed: &ParsedArgs) -> Result<String, CliError> {
    validate_flags(parsed, "stream")?;
    validate_positionals(parsed, "stream", 0)?;
    let batch_size =
        number_arg(parsed, "batchSize", Some(1000), Some(1), Some(10000))?.unwrap_or(1000) as u32;
    let limit = number_arg(parsed, "limit", None, Some(1), None)?;
    let jsonl = has_flag(parsed, "jsonl");
    let mut emitted: i64 = 0;
    let mut last_id: i64 = 0;

    let mut out = String::new();
    if !jsonl {
        out.push('[');
    }
    let mut first = true;
    loop {
        if let Some(max) = limit {
            if emitted >= max {
                break;
            }
        }
        let batch = catalog
            .stream_batch(last_id, batch_size)
            .map_err(|m| CliError(m, 1))?;
        if batch.is_empty() {
            break;
        }
        for book in &batch {
            if let Some(max) = limit {
                if emitted >= max {
                    break;
                }
            }
            let encoded = serde_json::to_string(book).unwrap_or_default();
            if jsonl {
                out.push_str(&encoded);
                out.push('\n');
            } else {
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&encoded);
            }
            emitted += 1;
            last_id = book.id;
        }
        if (batch.len() as u32) < batch_size {
            break;
        }
    }
    if !jsonl {
        out.push_str("]\n");
    }
    Ok(out)
}

fn cmd_user<U: UserAdmin>(
    users: &U,
    parsed: &ParsedArgs,
    stdin: &mut dyn Read,
    mut prompt: Option<PasswordPrompt<'_, '_>>,
) -> Result<String, CliError> {
    let subcommand = parsed.positionals.first().cloned();
    let args: Vec<String> = parsed.positionals.iter().skip(1).cloned().collect();
    match subcommand.as_deref() {
        Some("add") => {
            if args.len() != 1 {
                return Err(CliError::usage("Usage: user add <username>"));
            }
            let username = args[0].clone();
            if let Some((existing, has_password)) = users.get_credential(&username) {
                if has_password {
                    return Err(CliError(
                        format!(
                            "User {existing} already has a password; use 'user passwd' instead"
                        ),
                        1,
                    ));
                }
            }
            let password = read_password_input(parsed, stdin, prompt.as_deref_mut())?;
            if password.chars().count() < users.min_password_length() {
                return Err(CliError(
                    format!(
                        "Password must be at least {} characters",
                        users.min_password_length()
                    ),
                    1,
                ));
            }
            apply_password(users, &username, &password)
        }
        Some("passwd") => {
            if args.len() != 1 {
                return Err(CliError::usage("Usage: user passwd <username>"));
            }
            let username = args[0].clone();
            if users.get_credential(&username).is_none() {
                return Err(CliError::usage(format!("User not found: {username}")));
            }
            let password = read_password_input(parsed, stdin, prompt.as_deref_mut())?;
            if password.chars().count() < users.min_password_length() {
                return Err(CliError(
                    format!(
                        "Password must be at least {} characters",
                        users.min_password_length()
                    ),
                    1,
                ));
            }
            apply_password(users, &username, &password)
        }
        Some("list") => {
            if !args.is_empty() {
                return Err(CliError::usage("Usage: user list"));
            }
            let list: Vec<Value> = users
                .list_auth_users()
                .into_iter()
                .map(|u| {
                    json!({
                        "id": u.id,
                        "username": u.username,
                        "hasPassword": u.has_password,
                        "lastSeenAt": u.last_seen_at,
                    })
                })
                .collect();
            Ok(to_pretty_json(&json!({ "users": list })))
        }
        Some("remove") => {
            if args.len() != 1 {
                return Err(CliError::usage("Usage: user remove <username>"));
            }
            let username = args[0].clone();
            match users.delete_user(&username) {
                Some(removed) => Ok(to_pretty_json(&json!({ "removed": removed }))),
                None => Err(CliError::usage(format!("User not found: {username}"))),
            }
        }
        _ => Err(CliError::usage("Usage: user <add|passwd|list|remove> ...")),
    }
}

fn apply_password<U: UserAdmin>(
    users: &U,
    username: &str,
    password: &str,
) -> Result<String, CliError> {
    let (id, name) = users
        .set_password_for_user(username, password)
        .map_err(|m| CliError(m, 1))?;
    Ok(to_pretty_json(&json!({ "id": id, "username": name })))
}

pub fn help_text() -> &'static str {
    // Adapted from src/cli.ts HELP_TEXT; usage lines reference the Rust
    // binary. Command/flag documentation is unchanged.
    "Caliber CLI\n\nUsage:\n  caliber-cli <command> [options]\n\nCommands:\n  health                         Show CLI health status\n  stats                          Show library statistics\n  count                          Show total book count\n  list                           List books with cursor pagination\n  search                         Search books with cursor pagination\n  get                            Get a single book by id\n  stream                         Stream books in batches\n  search-title                   Search books by title only\n  search-author                  Search books by author only\n  author-info                    Get best matching author summary\n  library-path                   Print configured Calibre library path\n  format-path                    Print absolute path to a book format file\n  cover-path                     Print absolute path to a book cover file\n  download                       Copy a book format file to the current directory\n  cover                          Copy a cover image to the current directory\n  init-fts                       Run FTS initialization\n\nUser management (for use with CALIBER_AUTH_ENABLED=true):\n  user add <username>            Create a user (or set a password on an existing profile)\n  user passwd <username>         Change a user's password\n  user list                      List users\n  user remove <username>         Delete a user, their sessions, and their progress\n  --password-stdin               Read the password from stdin instead of a hidden prompt\n\nGlobal options:\n  --help, -h                     Show this help\n\nCommon options:\n  --limit <n>                    Result limit (default depends on command)\n  --cursor <value>               Pagination cursor\n  --table                        Render list-style output in a terminal table\n\nlist options:\n  --sortBy <title|author|added|rating>\n  --sortOrder <asc|desc>\n\nsearch options:\n  --query <text>                 Query text (or first positional argument)\n\nget options:\n  --id <n>                       Book id\n\nstream options:\n  --batchSize <n>                Batch size (default: 1000)\n  --limit <n>                    Max books to emit\n  --jsonl                        Emit newline-delimited JSON objects\n\nsearch-title options:\n  --title <text>                 Title query (or first positional argument)\n  --count <n>                    Max results (default: 10)\n\nsearch-author options:\n  --author <text>                Author query (or first positional argument)\n  --count <n>                    Max results (default: 10)\n\nauthor-info options:\n  --author <text>                Author query (or first positional argument)\n\nformat-path options:\n  --id <n>\n  --format <fmt>\n\ncover-path options:\n  --id <n>\n\ndownload options:\n  --id <n>\n  --format <fmt>\n  --out <file>                   Output file path (default: source filename)\n\ncover options:\n  --id <n>\n  --out <file>                   Output file path (default: <id>-cover.jpg)\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{MockCatalog, MockUsers};
    use std::io::Cursor;

    fn run(catalog: &MockCatalog, users: &MockUsers, args: &[&str]) -> CliOutput {
        let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let mut stdin = Cursor::new(Vec::<u8>::new());
        run_cli(catalog, users, &argv, &mut stdin, None)
    }

    fn run_with_stdin(
        catalog: &MockCatalog,
        users: &MockUsers,
        args: &[&str],
        input: &str,
    ) -> CliOutput {
        let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let mut stdin = Cursor::new(input.as_bytes().to_vec());
        run_cli(catalog, users, &argv, &mut stdin, None)
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_args_flags_and_positionals() {
        let parsed = parse_args(&args(&[
            "list",
            "extra",
            "--limit",
            "5",
            "--sortBy=author",
            "--table",
        ]));
        assert_eq!(parsed.command.as_deref(), Some("list"));
        assert_eq!(string_flag(&parsed, "limit").as_deref(), Some("5"));
        assert_eq!(string_flag(&parsed, "sortBy").as_deref(), Some("author"));
        assert!(has_flag(&parsed, "table"));
        assert_eq!(parsed.positionals, vec!["extra"]);

        // TS parseArgs greedily takes the next non-dash token as the flag
        // value, even for boolean-style flags: `--table extra` -> table="extra".
        let parsed = parse_args(&args(&["list", "--table", "extra"]));
        assert_eq!(string_flag(&parsed, "table").as_deref(), Some("extra"));
        assert!(parsed.positionals.is_empty());

        let parsed = parse_args(&args(&["search", "--", "--weird", "query"]));
        assert_eq!(parsed.positionals, vec!["--weird", "query"]);

        let parsed = parse_args(&args(&["-h"]));
        assert!(has_flag(&parsed, "help"));

        let parsed = parse_args(&args(&["get", "--id"]));
        assert!(has_flag(&parsed, "id")); // boolean when no value follows
    }

    #[test]
    fn help_and_unknown_command() {
        let catalog = MockCatalog::with_default_books();
        let users = MockUsers::default();
        let out = run(&catalog, &users, &["--help"]);
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.contains("Caliber CLI"));
        assert!(out.stdout.contains("user add <username>"));

        let out = run(&catalog, &users, &[]);
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.contains("Commands:"));

        let out = run(&catalog, &users, &["frobnicate"]);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("Unknown command: frobnicate"));
        assert!(out.stderr.contains("Use --help for usage."));
    }

    #[test]
    fn stats_count_health_shapes() {
        let catalog = MockCatalog::with_default_books();
        let users = MockUsers::default();

        let out = run(&catalog, &users, &["stats"]);
        assert_eq!(out.exit_code, 0);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["totalBooks"], 4);
        assert_eq!(body["totalAuthors"], 2);
        assert_eq!(body["totalSeries"], 2);

        let out = run(&catalog, &users, &["count"]);
        assert_eq!(
            serde_json::from_str::<Value>(&out.stdout).unwrap()["count"],
            4
        );

        let out = run(&catalog, &users, &["health"]);
        assert_eq!(out.exit_code, 0);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["sourceDbExists"], true);
        assert_eq!(body["bookCount"], 4);

        let broken = MockCatalog {
            source_exists: false,
            ready: false,
            count_fails: true,
            ..MockCatalog::with_default_books()
        };
        let out = run(&broken, &users, &["health"]);
        assert_eq!(out.exit_code, 1);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["status"], "error");
        assert!(body["bookCount"].is_null());
    }

    #[test]
    fn list_json_and_table() {
        let catalog = MockCatalog::with_default_books();
        let users = MockUsers::default();

        let out = run(&catalog, &users, &["list", "--limit", "2"]);
        assert_eq!(out.exit_code, 0);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["items"].as_array().unwrap().len(), 2);
        assert_eq!(body["hasMore"], true);
        assert!(body["nextCursor"].is_string());
        assert_eq!(body["items"][0]["title"], "Dune");
        // camelCase envelope + snake_case item fields (wire contract).
        assert!(out.stdout.contains("\"nextCursor\""));
        assert!(out.stdout.contains("\"series_index\""));

        let out = run(&catalog, &users, &["list", "--limit", "2", "--table"]);
        assert!(out.stdout.contains("nextCursor: mock:2"));
        assert!(out.stdout.contains("Dune"));

        let out = run(&catalog, &users, &["list", "--sortBy", "bogus"]);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("--sortBy must be one of"));
    }

    #[test]
    fn search_and_get() {
        let catalog = MockCatalog::with_default_books();
        let users = MockUsers::default();

        let out = run(&catalog, &users, &["search", "dune"]);
        assert_eq!(out.exit_code, 0);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["items"].as_array().unwrap().len(), 2);

        let out = run(&catalog, &users, &["get", "--id", "3"]);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["title"], "The Hobbit");
        assert_eq!(body["isbn"], "");

        let out = run(&catalog, &users, &["get", "--id", "99"]);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("Book not found for id 99"));

        let out = run(&catalog, &users, &["get"]);
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("Missing required --id"));
    }

    #[test]
    fn stream_json_array_and_jsonl() {
        let catalog = MockCatalog::with_default_books();
        let users = MockUsers::default();

        let out = run(&catalog, &users, &["stream", "--limit", "2"]);
        assert_eq!(out.exit_code, 0);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body.as_array().unwrap().len(), 2);
        assert!(out.stdout.ends_with("]\n"));

        let out = run(&catalog, &users, &["stream", "--limit", "3", "--jsonl"]);
        let lines: Vec<&str> = out.stdout.lines().collect();
        assert_eq!(lines.len(), 3);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["id"], 1);

        let out = run(&catalog, &users, &["stream", "--batchSize", "0"]);
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("--batchSize must be >= 1"));
    }

    #[test]
    fn author_search_tools() {
        let catalog = MockCatalog::with_default_books();
        let users = MockUsers::default();

        let out = run(&catalog, &users, &["search-author", "tolkien"]);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body.as_array().unwrap().len(), 2);

        let out = run(&catalog, &users, &["search-title", "hobbit"]);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body[0]["title"], "The Hobbit");

        let out = run(&catalog, &users, &["author-info", "herbert"]);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["name"], "Frank Herbert");
        assert_eq!(body["bookCount"], 2);

        let out = run(&catalog, &users, &["author-info", "nobody"]);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("No author matched"));
    }

    #[test]
    fn paths_and_download() {
        let mut catalog = MockCatalog::with_default_books();
        let users = MockUsers::default();

        let out = run(
            &catalog,
            &users,
            &["format-path", "--id", "2", "--format", "epub"],
        );
        assert_eq!(out.exit_code, 2); // no file mapped yet
        assert!(out.stderr.contains("Format EPUB not found for book id 2"));

        let dir = std::env::temp_dir().join(format!("caliber-cli-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let epub = dir.join("Dune Messiah.epub");
        std::fs::write(&epub, b"fake-epub-bytes").unwrap();
        catalog
            .format_paths
            .insert((2, "EPUB".to_string()), epub.clone());

        let out = run(
            &catalog,
            &users,
            &["format-path", "--id", "2", "--format", "epub"],
        );
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["format"], "EPUB");
        assert!(body["path"]
            .as_str()
            .unwrap()
            .ends_with("Dune Messiah.epub"));

        let cwd = std::env::current_dir().unwrap();
        std::env::set_current_dir(&dir).unwrap();
        // Default output name equals the source basename; cwd is the source
        // dir here, so the same-path guard must report the size (not truncate).
        let out = run(
            &catalog,
            &users,
            &["download", "--id", "2", "--format", "EPUB"],
        );
        std::env::set_current_dir(cwd).unwrap();
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["bytes"], 15u64);
        assert_eq!(
            std::fs::read(&epub).unwrap().len(),
            15,
            "source must survive same-path download"
        );
        // Deterministic explicit output.
        let out = run(
            &catalog,
            &users,
            &[
                "download",
                "--id",
                "2",
                "--format",
                "EPUB",
                "--out",
                dir.join("out.epub").to_str().unwrap(),
            ],
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        assert_eq!(std::fs::read(dir.join("out.epub")).unwrap().len(), 15);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_flag_rejected() {
        let catalog = MockCatalog::with_default_books();
        let users = MockUsers::default();
        let out = run(&catalog, &users, &["list", "--frobnicate"]);
        assert_eq!(out.exit_code, 2);
        assert!(out
            .stderr
            .contains("Unknown option --frobnicate for command list"));
    }

    #[test]
    fn user_management_flows() {
        let catalog = MockCatalog::with_default_books();
        let users = MockUsers::with_users(&[("alice", true), ("bob", false)]);

        // add: stdin password
        let out = run_with_stdin(
            &catalog,
            &users,
            &["user", "add", "carol", "--password-stdin"],
            "correct horse battery\n",
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["username"], "carol");

        // add existing password holder
        let out = run_with_stdin(
            &catalog,
            &users,
            &["user", "add", "alice", "--password-stdin"],
            "password123\n",
        );
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("already has a password"));

        // short password
        let out = run_with_stdin(
            &catalog,
            &users,
            &["user", "add", "dave", "--password-stdin"],
            "short\n",
        );
        assert_eq!(out.exit_code, 1);
        assert!(out
            .stderr
            .contains("Password must be at least 8 characters"));

        // empty stdin password
        let out = run_with_stdin(
            &catalog,
            &users,
            &["user", "add", "erin", "--password-stdin"],
            "\n",
        );
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("was empty"));

        // interactive prompt unavailable without a terminal
        let out = run(&catalog, &users, &["user", "add", "frank"]);
        assert_eq!(out.exit_code, 1);
        assert!(out
            .stderr
            .contains("requires a terminal; use --password-stdin"));

        // passwd unknown user
        let out = run_with_stdin(
            &catalog,
            &users,
            &["user", "passwd", "ghost", "--password-stdin"],
            "password123\n",
        );
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("User not found: ghost"));

        // passwd existing profile without password
        let out = run_with_stdin(
            &catalog,
            &users,
            &["user", "passwd", "bob", "--password-stdin"],
            "password123\n",
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);

        // list
        let out = run(&catalog, &users, &["user", "list"]);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        let list = body["users"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["username"], "alice");
        assert_eq!(list[0]["hasPassword"], true);

        // remove
        let out = run(&catalog, &users, &["user", "remove", "alice"]);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["removed"], "alice");

        let out = run(&catalog, &users, &["user", "remove", "ghost"]);
        assert_eq!(out.exit_code, 2);

        // prompt-based happy path with a fake prompt callback
        let argv = args(&["user", "add", "gina"]);
        let mut stdin = Cursor::new(Vec::<u8>::new());
        let mut prompt = |q: &str| -> Result<String, String> {
            assert!(q.to_lowercase().contains("password"));
            Ok("prompt-password".to_string())
        };
        let out = run_cli(
            &catalog,
            &users,
            &argv,
            &mut stdin,
            Some(&mut prompt as &mut dyn FnMut(&str) -> Result<String, String>),
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        assert!(out.stdout.contains("\"username\": \"gina\""));

        // mismatched prompts
        let argv = args(&["user", "add", "heidi"]);
        let mut stdin = Cursor::new(Vec::<u8>::new());
        let mut n = 0;
        let mut prompt = move |_q: &str| -> Result<String, String> {
            n += 1;
            Ok(if n == 1 { "one".into() } else { "two".into() })
        };
        let out = run_cli(
            &catalog,
            &users,
            &argv,
            &mut stdin,
            Some(&mut prompt as &mut dyn FnMut(&str) -> Result<String, String>),
        );
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("Passwords do not match"));
    }

    #[test]
    fn init_fts_and_library_path() {
        let catalog = MockCatalog::with_default_books();
        let users = MockUsers::default();
        let out = run(&catalog, &users, &["init-fts"]);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["initialized"], true);

        let out = run(&catalog, &users, &["library-path"]);
        let body: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(body["path"], "/tmp/mock-library");
    }
}
