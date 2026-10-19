//! MCP (Model Context Protocol) core — port of `src/lib/mcp-core.ts`,
//! `src/lib/mcp-utils.ts`, and the stdio framing of `src/mcp-server.ts`.
//!
//! The catalog source is a trait so the dispatch logic is unit-testable
//! against fixtures; the `caliber-mcp` binary wires the real data layer.

use caliber_common::types::BookListItem;
use serde_json::{json, Value};

/// Catalog surface required by the MCP tools.
pub trait McpSource: Send + Sync {
    fn search_books_by_title(&self, title: &str, limit: u32) -> Vec<BookListItem>;
    fn search_books_by_author(&self, author: &str, limit: u32) -> Vec<BookListItem>;
    fn get_author_by_name(&self, name: &str) -> Option<AuthorSummary>;
    /// searchBooksCursor({ query, limit }) — items only.
    fn search_books_paged(&self, query: &str, limit: u32) -> Vec<BookListItem>;
}

/// `getAuthorByName` result shape.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthorSummary {
    pub name: String,
    pub book_count: i64,
}

pub const PROTOCOL_VERSION: &str = "2024-11-05";
pub const SERVER_NAME: &str = "caliber-library-search";
pub const SERVER_VERSION: &str = "1.0.0";

pub fn server_capabilities() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        "capabilities": { "tools": { "listChanged": false } },
    })
}

pub fn tools() -> Value {
    json!([
        {
            "name": "search_book_title",
            "description": "Search the local library for books by title. Returns matching books with authors, series, and formats.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "The book title to search for (partial matches supported)" },
                    "count": { "type": "number", "description": "Maximum number of results to return", "default": 10 }
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
                    "author": { "type": "string", "description": "The author name to search for (partial matches supported)" },
                    "count": { "type": "number", "description": "Maximum number of results to return", "default": 10 }
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
                    "query": { "type": "string", "description": "Search query to find books" },
                    "count": { "type": "number", "description": "Maximum number of results to return", "default": 10 }
                },
                "required": ["query"]
            }
        }
    ])
}

/// `formatBook` from `src/lib/mcp-utils.ts`.
pub fn format_book(book: &BookListItem) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("\"{}\"", book.title));
    if !book.authors.is_empty() {
        parts.push(format!("by {}", book.authors.join(", ")));
    }
    if let Some(series) = &book.series {
        parts.push(format!("(Book {} in {})", book.series_index, series));
    }
    if !book.formats.is_empty() {
        parts.push(format!("[{}]", book.formats.join(", ")));
    }
    parts.join(" ")
}

fn clamp_count(args: &Value) -> u32 {
    match args.get("count") {
        Some(Value::Number(n)) if n.as_f64().map(|f| f.is_finite()).unwrap_or(false) => {
            let raw = n.as_f64().unwrap_or(10.0);
            let floored = raw.floor();
            let clamped = floored.clamp(1.0, 20.0);
            clamped as u32
        }
        _ => 10,
    }
}

fn number_arg(args: &Value, key: &str) -> Option<f64> {
    match args.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    }
}

pub fn execute_tool<S: McpSource>(source: &S, name: &str, args: &Value) -> Result<String, String> {
    let count = clamp_count(args);
    let string_arg = |key: &str| -> Option<String> {
        match args.get(key) {
            Some(Value::String(s)) => {
                let trimmed = s.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            }
            _ => None,
        }
    };
    let _ = number_arg; // reserved for numeric args parity checks

    match name {
        "search_book_title" => {
            let Some(title) = string_arg("title") else {
                return Err("title must be a non-empty string".into());
            };
            let books = source.search_books_by_title(&title, count);
            let mut out = format!("Library search for title: \"{title}\"\n");
            out.push_str(&"=".repeat(60));
            out.push_str("\n\n");
            if books.is_empty() {
                out.push_str("No books found with that title.\n");
            } else {
                out.push_str(&format!("Found {} book(s):\n\n", books.len()));
                for (i, book) in books.iter().enumerate() {
                    out.push_str(&format!("{}. {}\n", i + 1, format_book(book)));
                }
            }
            Ok(out)
        }
        "search_author" => {
            let Some(author) = string_arg("author") else {
                return Err("author must be a non-empty string".into());
            };
            let author_info = source.get_author_by_name(&author);
            let books = source.search_books_by_author(&author, count);
            let mut out = format!("Library search for author: \"{author}\"\n");
            out.push_str(&"=".repeat(60));
            out.push_str("\n\n");
            if let Some(info) = author_info {
                out.push_str(&format!(
                    "Author: {} ({} book(s) in library)\n\n",
                    info.name, info.book_count
                ));
            }
            if books.is_empty() {
                out.push_str("No books found by that author.\n");
            } else {
                out.push_str(&format!("Showing {} book(s):\n\n", books.len()));
                for (i, book) in books.iter().enumerate() {
                    out.push_str(&format!("{}. {}\n", i + 1, format_book(book)));
                }
            }
            Ok(out)
        }
        "search_library" => {
            let Some(query) = string_arg("query") else {
                return Err("query must be a non-empty string".into());
            };
            let books = source.search_books_paged(&query, count);
            let mut out = format!("Library search: \"{query}\"\n");
            out.push_str(&"=".repeat(60));
            out.push_str("\n\n");
            if books.is_empty() {
                out.push_str("No books found matching that query.\n");
            } else {
                out.push_str(&format!("Found {} book(s):\n\n", books.len()));
                for (i, book) in books.iter().enumerate() {
                    out.push_str(&format!("{}. {}\n", i + 1, format_book(book)));
                }
            }
            Ok(out)
        }
        other => Err(format!("Unknown tool: {other}")),
    }
}

fn jsonrpc_ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_err(id: Value, code: i64, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Port of `handleJSONRPC`. Returns None for notifications (null/absent id).
pub fn handle_jsonrpc<S: McpSource>(source: &S, request: &Value) -> Option<Value> {
    let id = request.get("id")?;
    if id.is_null() {
        return None;
    }
    let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");

    match method {
        "initialize" => Some(jsonrpc_ok(id.clone(), server_capabilities())),
        "tools/list" => Some(jsonrpc_ok(id.clone(), json!({ "tools": tools() }))),
        "tools/call" => {
            let params = request.get("params");
            let valid_params = params.map(|p| p.is_object()).unwrap_or(false);
            if !valid_params {
                return Some(jsonrpc_err(
                    id.clone(),
                    -32602,
                    "Invalid tool call parameters".into(),
                ));
            }
            let params = params.unwrap();
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if name.is_empty() {
                return Some(jsonrpc_err(
                    id.clone(),
                    -32602,
                    "Tool name is required".into(),
                ));
            }
            let args = match params.get("arguments") {
                Some(Value::Object(map)) => Value::Object(map.clone()),
                _ => json!({}),
            };
            match execute_tool(source, name, &args) {
                Ok(text) => Some(jsonrpc_ok(
                    id.clone(),
                    json!({ "content": [ { "type": "text", "text": text } ] }),
                )),
                Err(message) => Some(jsonrpc_err(
                    id.clone(),
                    -32603,
                    format!("Tool execution failed: {message}"),
                )),
            }
        }
        other => Some(jsonrpc_err(
            id.clone(),
            -32601,
            format!("Method not found: {other}"),
        )),
    }
}

// ---------------------------------------------------------------------------
// stdio framing (port of mcp-server.ts main loop)
// ---------------------------------------------------------------------------

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Incremental line framing with the 1MB cap. Feed decoded chunks in; get
/// complete (newline-terminated) response lines out, including the
/// "frame too large" error the TS server emits on overflow.
pub struct StdioFramer {
    pending: String,
}

impl StdioFramer {
    pub fn new() -> Self {
        StdioFramer {
            pending: String::new(),
        }
    }

    pub fn push<S: McpSource>(&mut self, source: &S, chunk: &str) -> Vec<String> {
        self.pending.push_str(chunk);
        let mut out = Vec::new();
        if self.pending.len() > MAX_FRAME_BYTES {
            out.push(format!(
                "{}\n",
                json!({ "jsonrpc": "2.0", "id": null,
                        "error": { "code": -32600, "message": "Request frame is too large" } })
            ));
            self.pending.clear();
            return out;
        }
        self.drain(source, &mut out);
        out
    }

    /// Process any buffered remainder at EOF.
    pub fn finish<S: McpSource>(&mut self, source: &S) -> Vec<String> {
        let mut out = Vec::new();
        self.drain(source, &mut out);
        if !self.pending.trim().is_empty() {
            self.handle_line(source, &self.pending.clone(), &mut out);
            self.pending.clear();
        }
        out
    }

    fn drain<S: McpSource>(&mut self, source: &S, out: &mut Vec<String>) {
        while let Some(pos) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=pos).collect();
            let line = line.trim_end_matches('\n').to_string();
            self.handle_line(source, &line, out);
        }
    }

    fn handle_line<S: McpSource>(&self, source: &S, line: &str, out: &mut Vec<String>) {
        if line.trim().is_empty() {
            return;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(request) => {
                if let Some(response) = handle_jsonrpc(source, &request) {
                    out.push(format!("{response}\n"));
                }
            }
            Err(err) => out.push(format!(
                "{}\n",
                json!({ "jsonrpc": "2.0", "id": null,
                        "error": { "code": -32700, "message": format!("Parse error: {err}") } })
            )),
        }
    }
}

impl Default for StdioFramer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::MockCatalog;

    fn source() -> MockCatalog {
        MockCatalog::with_default_books()
    }

    fn call(source: &MockCatalog, payload: Value) -> Option<Value> {
        handle_jsonrpc(source, &payload)
    }

    fn request(id: Value, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    #[test]
    fn initialize_returns_capabilities() {
        let s = source();
        let resp = call(&s, request(1.into(), "initialize", json!({}))).unwrap();
        assert_eq!(resp["id"], 1);
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(
            resp["result"]["serverInfo"]["name"],
            "caliber-library-search"
        );
        assert_eq!(
            resp["result"]["capabilities"]["tools"]["listChanged"],
            false
        );
    }

    #[test]
    fn tools_list_has_three_tools() {
        let s = source();
        let resp = call(&s, request("t".into(), "tools/list", json!({}))).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(
            names,
            vec!["search_book_title", "search_author", "search_library"]
        );
        assert_eq!(tools[0]["inputSchema"]["required"][0], "title");
    }

    #[test]
    fn tool_call_search_book_title_output_format() {
        let s = source();
        let resp = call(
            &s,
            request(
                2.into(),
                "tools/call",
                json!({
                    "name": "search_book_title",
                    "arguments": { "title": "dune", "count": 2 }
                }),
            ),
        )
        .unwrap();
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("Library search for title: \"dune\"\n"));
        assert!(text.contains(&"=".repeat(60)));
        assert!(text.contains("Found 2 book(s):"));
        assert!(text.contains("1. \"Dune\" by Frank Herbert [EPUB]"));
        assert!(text.contains("2. \"Dune Messiah\" by Frank Herbert (Book 2 in Dune) [EPUB, PDF]"));
    }

    #[test]
    fn tool_call_search_author_includes_summary() {
        let s = source();
        let resp = call(
            &s,
            request(
                3.into(),
                "tools/call",
                json!({
                    "name": "search_author",
                    "arguments": { "author": "tolkien" }
                }),
            ),
        )
        .unwrap();
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("Library search for author: \"tolkien\"\n"));
        assert!(text.contains("Author: J. R. R. Tolkien (2 book(s) in library)"));
        assert!(text.contains("Showing 2 book(s):"));
    }

    #[test]
    fn tool_call_search_library_empty_result() {
        let s = source();
        let resp = call(
            &s,
            request(
                4.into(),
                "tools/call",
                json!({
                    "name": "search_library",
                    "arguments": { "query": "zzzz" }
                }),
            ),
        )
        .unwrap();
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("No books found matching that query."));
    }

    #[test]
    fn tool_call_errors() {
        let s = source();
        // missing name
        let resp = call(
            &s,
            request(5.into(), "tools/call", json!({ "arguments": {} })),
        )
        .unwrap();
        assert_eq!(resp["error"]["code"], -32602);
        assert_eq!(resp["error"]["message"], "Tool name is required");

        // params not an object
        let resp = call(&s, request(6.into(), "tools/call", json!([]))).unwrap();
        assert_eq!(resp["error"]["code"], -32602);
        assert_eq!(resp["error"]["message"], "Invalid tool call parameters");

        // unknown tool
        let resp = call(
            &s,
            request(
                7.into(),
                "tools/call",
                json!({ "name": "nope", "arguments": {} }),
            ),
        )
        .unwrap();
        assert_eq!(resp["error"]["code"], -32603);
        assert!(resp["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Tool execution failed: Unknown tool: nope"));

        // empty required arg
        let resp = call(
            &s,
            request(
                8.into(),
                "tools/call",
                json!({ "name": "search_book_title", "arguments": { "title": "  " } }),
            ),
        )
        .unwrap();
        assert!(resp["error"]["message"]
            .as_str()
            .unwrap()
            .contains("title must be a non-empty string"));

        // count is clamped to 1..=20, non-finite falls back to default
        let resp = call(
            &s,
            request(9.into(), "tools/call", json!({ "name": "search_library", "arguments": { "query": "dune", "count": 1000 } })),
        )
        .unwrap();
        assert!(resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Found 2 book(s)"));
    }

    #[test]
    fn notifications_return_none() {
        let s = source();
        // null id
        assert!(call(
            &s,
            json!({ "jsonrpc": "2.0", "id": null, "method": "initialize" })
        )
        .is_none());
        // absent id
        assert!(call(&s, json!({ "jsonrpc": "2.0", "method": "initialize" })).is_none());
    }

    #[test]
    fn method_not_found() {
        let s = source();
        let resp = call(&s, request(10.into(), "resources/list", json!({}))).unwrap();
        assert_eq!(resp["error"]["code"], -32601);
        assert_eq!(resp["error"]["message"], "Method not found: resources/list");
    }

    #[test]
    fn format_book_shape() {
        let s = source();
        let books = s.search_books_by_title("messiah", 1);
        assert_eq!(
            format_book(&books[0]),
            "\"Dune Messiah\" by Frank Herbert (Book 2 in Dune) [EPUB, PDF]"
        );
    }

    #[test]
    fn stdio_framer_lines_and_overflow() {
        let s = source();
        let mut framer = StdioFramer::new();

        // two requests in one chunk -> two response lines
        let chunk = format!(
            "{}\n{}\n",
            serde_json::to_string(&request(1.into(), "initialize", json!({}))).unwrap(),
            serde_json::to_string(&request(2.into(), "tools/list", json!({}))).unwrap()
        );
        let out = framer.push(&s, &chunk);
        assert_eq!(out.len(), 2);
        let first: Value = serde_json::from_str(out[0].trim_end()).unwrap();
        assert_eq!(first["result"]["protocolVersion"], "2024-11-05");

        // partial line held until newline or EOF
        let out = framer.push(
            &s,
            &format!("{}", request(3.into(), "initialize", json!({})).to_string()),
        );
        assert!(out.is_empty());
        let out = framer.push(&s, "\n");
        assert_eq!(out.len(), 1);

        // EOF flushes a trailing frame without newline
        let out = framer.push(
            &s,
            &serde_json::to_string(&request(4.into(), "initialize", json!({}))).unwrap(),
        );
        assert!(out.is_empty());
        let out = framer.finish(&s);
        assert_eq!(out.len(), 1);
        let parsed: Value = serde_json::from_str(out[0].trim_end()).unwrap();
        assert_eq!(parsed["id"], 4);

        // oversized frame -> -32600 and buffer reset (next line works)
        let mut big = String::new();
        big.push_str(&"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"x\",\"padding\":\"");
        big.push_str(&"a".repeat(MAX_FRAME_BYTES));
        big.push_str("\"}");
        let out = framer.push(&s, &big);
        assert_eq!(out.len(), 1);
        let err: Value = serde_json::from_str(out[0].trim_end()).unwrap();
        assert_eq!(err["error"]["code"], -32600);
        assert_eq!(err["error"]["message"], "Request frame is too large");
        let out = framer.push(
            &s,
            &format!(
                "{}\n",
                serde_json::to_string(&request(5.into(), "initialize", json!({}))).unwrap()
            ),
        );
        assert_eq!(out.len(), 1);

        // parse error -> -32700
        let out = framer.push(&s, "this is not json\n");
        assert_eq!(out.len(), 1);
        let err: Value = serde_json::from_str(out[0].trim_end()).unwrap();
        assert_eq!(err["error"]["code"], -32700);
        assert!(err["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("Parse error"));
    }
}
