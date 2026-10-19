//! MCP JSON-RPC dispatch (port of src/mcp.ts + src/lib/mcp-core.ts) and the
//! `/mcp` HTTP route handler.
//!
//! Contract deviation (documented in PARITY.md): `handle_jsonrpc` takes the
//! server state because Rust has no ambient DB globals — the TS
//! `handleMCPRequest`/`handleJSONRPC` pair read the singleton connection.

use crate::cache::{error_json, json_response};
use crate::state::SharedState;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

/// TS `formatBook` (src/lib/mcp-utils.ts).
pub fn format_book(book: &caliber_common::BookListItem) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("\"{}\"", book.title));
    if !book.authors.is_empty() {
        parts.push(format!("by {}", book.authors.join(", ")));
    }
    if let Some(series) = &book.series {
        parts.push(format!(
            "(Book {} in {series})",
            crate::helpers::js_number_string(book.series_index)
        ));
    }
    if !book.formats.is_empty() {
        parts.push(format!("[{}]", book.formats.join(", ")));
    }
    parts.join(" ")
}

fn separator() -> String {
    "=".repeat(60)
}

fn tools_value() -> Value {
    json!([
        {
            "name": "search_book_title",
            "description": "Search the local library for books by title. Returns matching books with authors, series, and formats.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "The book title to search for (partial matches supported)"
                    },
                    "count": {
                        "type": "number",
                        "description": "Maximum number of results to return",
                        "default": 10
                    }
                },
                "required": ["title"]
            }
        },
        {
            "name": "search_author",
            "description": "Search the local library for books by author name. Returns all books by matching authors.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "author": {
                        "type": "string",
                        "description": "The author name to search for (partial matches supported)"
                    },
                    "count": {
                        "type": "number",
                        "description": "Maximum number of results to return",
                        "default": 10
                    }
                },
                "required": ["author"]
            }
        },
        {
            "name": "search_library",
            "description": "General search across the local library (title, author, series). Returns matching books.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query to find books"
                    },
                    "count": {
                        "type": "number",
                        "description": "Maximum number of results to return",
                        "default": 10
                    }
                },
                "required": ["query"]
            }
        }
    ])
}

fn execute_tool_sync(
    db: &std::sync::Arc<dyn crate::backend::CaliberBackend + Send + Sync>,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let count_arg = args
        .get("count")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite())
        .unwrap_or(10.0);
    let count = 1.max(20).min(count_arg.floor() as u32);

    match name {
        "search_book_title" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("");
            if title.is_empty() {
                return Err("title must be a non-empty string".into());
            }
            let books = db.search_books_by_title(title, count);
            let mut output = format!("Library search for title: \"{title}\"\n{}\n\n", separator());
            if books.is_empty() {
                output.push_str("No books found with that title.\n");
            } else {
                output.push_str(&format!("Found {} book(s):\n\n", books.len()));
                for (i, book) in books.iter().enumerate() {
                    output.push_str(&format!("{}. {}\n", i + 1, format_book(book)));
                }
            }
            Ok(output)
        }
        "search_author" => {
            let author = args
                .get("author")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("");
            if author.is_empty() {
                return Err("author must be a non-empty string".into());
            }
            let author_info = db.get_author_by_name(author);
            let books = db.search_books_by_author(author, count);
            let mut output = format!(
                "Library search for author: \"{author}\"\n{}\n\n",
                separator()
            );
            if let Some(info) = &author_info {
                output.push_str(&format!(
                    "Author: {} ({} book(s) in library)\n\n",
                    info.name, info.book_count
                ));
            }
            if books.is_empty() {
                output.push_str("No books found by that author.\n");
            } else {
                output.push_str(&format!("Showing {} book(s):\n\n", books.len()));
                for (i, book) in books.iter().enumerate() {
                    output.push_str(&format!("{}. {}\n", i + 1, format_book(book)));
                }
            }
            Ok(output)
        }
        "search_library" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("");
            if query.is_empty() {
                return Err("query must be a non-empty string".into());
            }
            let opts = caliber_common::ListOptions {
                limit: Some(count),
                ..Default::default()
            };
            let result = db
                .search_books(&opts, query)
                .map_err(|_| "search failed".to_string())?;
            let mut output = format!("Library search: \"{query}\"\n{}\n\n", separator());
            if result.items.is_empty() {
                output.push_str("No books found matching that query.\n");
            } else {
                output.push_str(&format!("Found {} book(s):\n\n", result.items.len()));
                for (i, item) in result.items.iter().enumerate() {
                    output.push_str(&format!("{}. {}\n", i + 1, format_book(item)));
                }
            }
            Ok(output)
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}

/// Port of `handleJSONRPC`: notifications (missing/null id) return `None`
/// (the HTTP layer answers 202).
pub async fn handle_jsonrpc(state: &SharedState, request: Value) -> Option<Value> {
    let id = match request.get("id") {
        Some(Value::Null) | None => return None,
        Some(id) => id.clone(),
    };
    let method = request.get("method").and_then(|v| v.as_str()).unwrap_or("");

    match method {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": { "name": "caliber-library-search", "version": "1.0.0" },
                "capabilities": { "tools": { "listChanged": false } }
            }
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tools_value() }
        })),
        "tools/call" => {
            let params = match request.get("params") {
                Some(p) if p.is_object() => p.clone(),
                _ => {
                    return Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32602, "message": "Invalid tool call parameters" }
                    }))
                }
            };
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32602, "message": "Tool name is required" }
                }));
            }
            let arguments = match params.get("arguments") {
                Some(a) if a.is_object() => a.clone(),
                _ => json!({}),
            };
            let db = state.db.clone();
            let owned_name = name.to_string();
            let result = tokio::task::spawn_blocking(move || {
                execute_tool_sync(&db, &owned_name, &arguments)
            })
            .await
            .unwrap_or_else(|err| Err(format!("tool panicked: {err}")));
            match result {
                Ok(text) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [ { "type": "text", "text": text } ]
                    }
                })),
                Err(message) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32603,
                        "message": format!("Tool execution failed: {message}")
                    }
                })),
            }
        }
        _ => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {method}") }
        })),
    }
}

/// Port of the `/mcp` POST route: 404 when disabled, batch support, 202 for
/// pure notifications, and a 400 `-32700` parse error for malformed JSON.
/// (The TS OPTIONS/non-POST branches live in mcp.ts's `handleMCPRequest`
/// but are unreachable through the Bun route table, which registers POST
/// only — unmatched methods fall through to the SPA.)
pub async fn mcp_route(State(state): State<SharedState>, request: axum::body::Body) -> Response {
    if !state.config.resolved().mcp_enabled {
        return error_json(404, "MCP is disabled");
    }
    let body_bytes = match http_body_util::BodyExt::collect(request).await {
        Ok(collected) => collected.to_bytes(),
        Err(err) => {
            return json_response(
                400,
                &json!({
                    "jsonrpc": "2.0",
                    "error": { "code": -32700, "message": format!("Parse error: {err}") }
                }),
                &[],
            )
        }
    };
    let parsed: Result<Value, _> = serde_json::from_slice(&body_bytes);
    let body = match parsed {
        Ok(body) => body,
        Err(err) => {
            return json_response(
                400,
                &json!({
                    "jsonrpc": "2.0",
                    "error": { "code": -32700, "message": format!("Parse error: {err}") }
                }),
                &[],
            )
        }
    };

    if body.is_array() {
        let requests: Vec<Value> = body.as_array().cloned().unwrap_or_default();
        let mut responses = Vec::new();
        for item in requests {
            if let Some(response) = handle_jsonrpc(&state, item).await {
                responses.push(response);
            }
        }
        if responses.is_empty() {
            return axum::http::Response::builder()
                .status(StatusCode::ACCEPTED)
                .body(axum::body::Body::empty())
                .unwrap();
        }
        return json_response(200, &Value::Array(responses), &[]);
    }

    match handle_jsonrpc(&state, body).await {
        Some(response) => json_response(200, &response, &[]),
        None => axum::http::Response::builder()
            .status(StatusCode::ACCEPTED)
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::empty())
            .unwrap(),
    }
}
