#!/usr/bin/env python3
"""
MCP Server for Book Search
Provides web search capabilities for book titles and authors using Brave or Tavily API
"""

import os
import json
import urllib.request
import urllib.parse
from typing import Optional
from mcp.server import Server
from mcp.types import TextContent, Tool

# API configuration
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")
DEFAULT_SEARCH_ENGINE = os.getenv("DEFAULT_SEARCH_ENGINE", "brave")  # "brave" or "tavily"


def search_brave(query: str, count: int = 5) -> dict:
    """Search using Brave Search API"""
    if not BRAVE_API_KEY:
        return {"error": "BRAVE_API_KEY not set"}

    url = "https://api.search.brave.com/res/v1/web/search"
    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_API_KEY
    }
    params = urllib.parse.urlencode({
        "q": query,
        "count": min(count, 20),
        "offset": 0,
        "mkt": "en-US",
        "safesearch": "moderate",
        "freshness": "all",
        "text_decorations": "false"
    })

    req = urllib.request.Request(f"{url}?{params}", headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode('utf-8'))
            return {
                "results": [
                    {
                        "title": item.get("title", ""),
                        "url": item.get("url", ""),
                        "description": item.get("description", ""),
                        "published": item.get("published", "")
                    }
                    for item in data.get("web", {}).get("results", [])
                ]
            }
    except Exception as e:
        return {"error": str(e)}


def search_tavily(query: str, count: int = 5) -> dict:
    """Search using Tavily Search API"""
    if not TAVILY_API_KEY:
        return {"error": "TAVILY_API_KEY not set"}

    url = "https://api.tavily.com/search"
    data = json.dumps({
        "api_key": TAVILY_API_KEY,
        "query": query,
        "search_depth": "basic",
        "max_results": min(count, 20),
        "include_answer": False,
        "include_raw_content": False,
        "include_images": False
    }).encode('utf-8')

    headers = {
        "Content-Type": "application/json"
    }

    req = urllib.request.Request(url, data=data, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode('utf-8'))
            return {
                "results": [
                    {
                        "title": item.get("title", ""),
                        "url": item.get("url", ""),
                        "description": item.get("content", ""),
                        "published": ""
                    }
                    for item in data.get("results", [])
                ]
            }
    except Exception as e:
        return {"error": str(e)}


def search_web(query: str, count: int = 5, engine: Optional[str] = None) -> dict:
    """Search the web using the specified or default search engine"""
    engine = engine or DEFAULT_SEARCH_ENGINE

    if engine == "tavily":
        return search_tavily(query, count)
    else:
        return search_brave(query, count)


# Create MCP server
server = Server("book-search")


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available tools"""
    return [
        Tool(
            name="search_book_title",
            description="Search the web for information about a book by its title",
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "The book title to search for"
                    },
                    "author": {
                        "type": "string",
                        "description": "Optional author name to refine search"
                    },
                    "count": {
                        "type": "integer",
                        "description": "Number of results to return (max 20)",
                        "default": 5
                    }
                },
                "required": ["title"]
            }
        ),
        Tool(
            name="search_author",
            description="Search the web for information about an author",
            inputSchema={
                "type": "object",
                "properties": {
                    "author": {
                        "type": "string",
                        "description": "The author name to search for"
                    },
                    "count": {
                        "type": "integer",
                        "description": "Number of results to return (max 20)",
                        "default": 5
                    }
                },
                "required": ["author"]
            }
        ),
        Tool(
            name="search_book_info",
            description="General web search for book information (reviews, summaries, etc.)",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query for book information"
                    },
                    "count": {
                        "type": "integer",
                        "description": "Number of results to return (max 20)",
                        "default": 5
                    }
                },
                "required": ["query"]
            }
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Handle tool calls"""

    if name == "search_book_title":
        title = arguments.get("title", "")
        author = arguments.get("author", "")
        count = arguments.get("count", 5)

        # Build search query
        query = f'"{title}" book'
        if author:
            query += f' author:"{author}"'

        results = search_web(query, count)

        if "error" in results:
            return [TextContent(type="text", text=f"Search error: {results['error']}")]

        # Format results
        output = f"Search results for book: '{title}'"
        if author:
            output += f" by {author}"
        output += "\n" + "=" * 60 + "\n\n"

        for i, result in enumerate(results.get("results", []), 1):
            output += f"{i}. {result['title']}\n"
            output += f"   URL: {result['url']}\n"
            output += f"   {result['description'][:200]}...\n\n"

        return [TextContent(type="text", text=output)]

    elif name == "search_author":
        author = arguments.get("author", "")
        count = arguments.get("count", 5)

        query = f'"{author}" author biography books'
        results = search_web(query, count)

        if "error" in results:
            return [TextContent(type="text", text=f"Search error: {results['error']}")]

        output = f"Search results for author: '{author}'\n"
        output += "=" * 60 + "\n\n"

        for i, result in enumerate(results.get("results", []), 1):
            output += f"{i}. {result['title']}\n"
            output += f"   URL: {result['url']}\n"
            output += f"   {result['description'][:200]}...\n\n"

        return [TextContent(type="text", text=output)]

    elif name == "search_book_info":
        query = arguments.get("query", "")
        count = arguments.get("count", 5)

        search_query = f"{query} book review summary"
        results = search_web(search_query, count)

        if "error" in results:
            return [TextContent(type="text", text=f"Search error: {results['error']}")]

        output = f"Search results: '{query}'\n"
        output += "=" * 60 + "\n\n"

        for i, result in enumerate(results.get("results", []), 1):
            output += f"{i}. {result['title']}\n"
            output += f"   URL: {result['url']}\n"
            output += f"   {result['description'][:200]}...\n\n"

        return [TextContent(type="text", text=output)]

    else:
        return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def main():
    """Run the MCP server using stdio transport"""
    from mcp.server.stdio import stdio_server

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
