---
name: Caliber Book Search
description: |
  Search your local Calibre book library using MCP tools.

  Triggers:
  - "search my library for..."
  - "find books by..."
  - "look up author..."
  - "what books do I have..."
  - "search caliber..."
  - "find in my library..."
---

# Caliber Book Search

Use the MCP tools from the caliber-mcp plugin to search your local book library.

## Available Tools

### search_book_title
Search for books by title (partial matches supported, case-insensitive).

**When to use:**
- User asks about a specific book title
- Looking for books with certain words in the title
- Finding a book they remember partially

**Example queries:**
- "Search my library for Dune"
- "Do I have Foundation?"
- "Find books with 'dragon' in the title"

### search_author
Search for books by author name.

**When to use:**
- User asks about an author
- Finding all books by a specific writer
- Checking which books by an author are in the library

**Example queries:**
- "What books do I have by Asimov?"
- "Search for Frank Herbert"
- "Find author Stephen King"

### search_library
General search across title, author, and series.

**When to use:**
- Broad search across all fields
- Multi-word queries
- Not sure if it's in title or author

**Example queries:**
- "Search for asimov foundation"
- "Find me sci-fi books"
- "Look up foundation series"

## Response Format

When presenting results:
1. State how many books were found
2. List books with: title, author, series (if any), formats
3. If no results, suggest alternative searches

## Examples

User: "Do I have any Dune books?"
→ Use search_book_title with title="dune"

User: "What Asimov books do I have?"
→ Use search_author with author="asimov"

User: "Find foundation series"
→ Use search_library with query="foundation"

User: "Search for asimov foundation"
→ Use search_library with query="asimov foundation"
