#!/usr/bin/env bun

import { basename, join } from "node:path";
import {
  getAuthorByName,
  getBookByIdOptimized,
  getBookCount,
  getBookCoverPath,
  getBookFormatPath,
  getLibraryPath,
  getLibraryStats,
  initFTS,
  listBooksCursor,
  searchBooksByAuthor,
  searchBooksByTitle,
  searchBooksCursor,
  streamBooks,
  type BookListItem,
} from "./lib/calibre-optimized";

type SortField = "title" | "author" | "added" | "rating";
type SortOrder = "asc" | "desc";

type FlagValue = string | boolean;

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, FlagValue>;
}

const GLOBAL_FLAGS = new Set(["help"]);

const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  health: new Set([]),
  stats: new Set([]),
  count: new Set([]),
  list: new Set(["limit", "cursor", "sortBy", "sortOrder", "table"]),
  search: new Set(["query", "limit", "cursor", "table"]),
  get: new Set(["id"]),
  stream: new Set(["batchSize", "limit", "jsonl"]),
  "search-title": new Set(["title", "count", "table"]),
  "search-author": new Set(["author", "count", "table"]),
  "author-info": new Set(["author"]),
  "library-path": new Set([]),
  "format-path": new Set(["id", "format"]),
  "cover-path": new Set(["id"]),
  download: new Set(["id", "format", "out"]),
  cover: new Set(["id", "out"]),
  "init-fts": new Set([]),
};

class CLIError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CLIError";
    this.exitCode = exitCode;
  }
}

const HELP_TEXT = `
Caliber CLI

Usage:
  bun src/cli.ts <command> [options]
  bun run cli -- <command> [options]

Commands:
  health                         Show CLI health status
  stats                          Show library statistics
  count                          Show total book count
  list                           List books with cursor pagination
  search                         Search books with cursor pagination
  get                            Get a single book by id
  stream                         Stream books in batches
  search-title                   Search books by title only
  search-author                  Search books by author only
  author-info                    Get best matching author summary
  library-path                   Print configured Calibre library path
  format-path                    Print absolute path to a book format file
  cover-path                     Print absolute path to a book cover file
  download                       Copy a book format file to the current directory
  cover                          Copy a cover image to the current directory
  init-fts                       Run FTS initialization

Global options:
  --help, -h                     Show this help

Common options:
  --limit <n>                    Result limit (default depends on command)
  --cursor <value>               Pagination cursor
  --table                        Render list-style output in a terminal table

list options:
  --sortBy <title|author|added|rating>
  --sortOrder <asc|desc>

search options:
  --query <text>                 Query text (or first positional argument)

get options:
  --id <n>                       Book id

stream options:
  --batchSize <n>                Batch size (default: 1000)
  --limit <n>                    Max books to emit
  --jsonl                        Emit newline-delimited JSON objects

search-title options:
  --title <text>                 Title query (or first positional argument)
  --count <n>                    Max results (default: 10)

search-author options:
  --author <text>                Author query (or first positional argument)
  --count <n>                    Max results (default: 10)

author-info options:
  --author <text>                Author query (or first positional argument)

format-path options:
  --id <n>
  --format <fmt>

cover-path options:
  --id <n>

download options:
  --id <n>
  --format <fmt>
  --out <file>                   Output file path (default: source filename)

cover options:
  --id <n>
  --out <file>                   Output file path (default: <id>-cover.jpg)
`;

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  let rest: string[];

  const first = argv[0];
  if (first && !first.startsWith("-")) {
    command = first;
    rest = argv.slice(1);
  } else {
    rest = [...argv];
  }

  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token) continue;

    if (token === "--") {
      for (let j = i + 1; j < rest.length; j++) {
        const positional = rest[j];
        if (positional) positionals.push(positional);
      }
      break;
    }

    if (token === "--help" || token === "-h") {
      flags.set("help", true);
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      if (body.length === 0) continue;

      const equalsIndex = body.indexOf("=");
      if (equalsIndex !== -1) {
        const key = body.slice(0, equalsIndex);
        const value = body.slice(equalsIndex + 1);
        if (key.length > 0) flags.set(key, value);
        continue;
      }

      const next = rest[i + 1];
      if (next && !next.startsWith("-")) {
        flags.set(body, next);
        i += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    positionals.push(token);
  }

  return {
    command,
    positionals,
    flags,
  };
}

function normalizeCommand(command: string | undefined): string {
  return (command ?? "help").toLowerCase();
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name);
}

function getRawFlag(parsed: ParsedArgs, name: string): FlagValue | undefined {
  return parsed.flags.get(name);
}

function getStringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = getRawFlag(parsed, name);
  return typeof value === "string" ? value : undefined;
}

function validateFlags(parsed: ParsedArgs, command: string): void {
  const commandFlags = COMMAND_FLAGS[command];
  if (!commandFlags) return;

  for (const flag of parsed.flags.keys()) {
    if (!GLOBAL_FLAGS.has(flag) && !commandFlags.has(flag)) {
      throw new CLIError(`Unknown option --${flag} for command ${command}`, 2);
    }
  }
}

function validatePositionals(parsed: ParsedArgs, command: string, max: number): void {
  if (parsed.positionals.length > max) {
    throw new CLIError(`Too many positional arguments for command ${command}`, 2);
  }
}

function getStringArg(
  parsed: ParsedArgs,
  options: { flag: string; positionalIndex?: number; required?: boolean; description: string },
): string {
  const fromFlag = getStringFlag(parsed, options.flag);
  if (fromFlag && fromFlag.trim().length > 0) {
    return fromFlag.trim();
  }

  if (typeof options.positionalIndex === "number") {
    const positional = parsed.positionals[options.positionalIndex];
    if (positional && positional.trim().length > 0) {
      return positional.trim();
    }
  }

  if (options.required) {
    throw new CLIError(`Missing required ${options.description}. Use --${options.flag}.`);
  }

  return "";
}

function parseInteger(value: string, description: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new CLIError(`Invalid ${description}: ${value}`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new CLIError(`Invalid ${description}: ${value}`);
  }
  return parsed;
}

function getNumberArg(
  parsed: ParsedArgs,
  name: string,
  options: { defaultValue?: number; min?: number; max?: number } = {},
): number | undefined {
  const raw = getStringFlag(parsed, name);

  if (raw === undefined) {
    return options.defaultValue;
  }

  const value = parseInteger(raw, name);

  if (typeof options.min === "number" && value < options.min) {
    throw new CLIError(`--${name} must be >= ${options.min}`);
  }

  if (typeof options.max === "number" && value > options.max) {
    throw new CLIError(`--${name} must be <= ${options.max}`);
  }

  return value;
}

function getRequiredId(parsed: ParsedArgs): number {
  const id = getNumberArg(parsed, "id", { min: 1 });
  if (typeof id !== "number") {
    throw new CLIError("Missing required --id <n>");
  }
  return id;
}

function getSortField(parsed: ParsedArgs): SortField {
  const sortBy = getStringFlag(parsed, "sortBy") ?? "title";
  if (sortBy === "title" || sortBy === "author" || sortBy === "added" || sortBy === "rating") {
    return sortBy;
  }
  throw new CLIError("--sortBy must be one of: title, author, added, rating");
}

function getSortOrder(parsed: ParsedArgs): SortOrder {
  const sortOrder = getStringFlag(parsed, "sortOrder") ?? "asc";
  if (sortOrder === "asc" || sortOrder === "desc") {
    return sortOrder;
  }
  throw new CLIError("--sortOrder must be one of: asc, desc");
}

function printJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function outputFileCopy(sourcePath: string, outputPath: string): Promise<void> {
  const sourceFile = Bun.file(sourcePath);
  const exists = await sourceFile.exists();
  if (!exists) {
    throw new CLIError(`Source file not found: ${sourcePath}`);
  }

  await Bun.write(outputPath, sourceFile);
  const stat = await sourceFile.stat();

  printJSON({
    sourcePath,
    outputPath,
    bytes: stat.size,
  });
}

function printBookTable(books: BookListItem[]): void {
  if (books.length === 0) {
    process.stdout.write("No books found.\n");
    return;
  }

  const rows = books.map((book) => ({
    id: book.id,
    title: book.title,
    authors: book.authors.join(", "),
    series: book.series,
    formats: book.formats.join(", "),
  }));

  console.table(rows);
}

async function handleStream(parsed: ParsedArgs): Promise<void> {
  const batchSize =
    getNumberArg(parsed, "batchSize", { defaultValue: 1000, min: 1, max: 10000 }) ?? 1000;
  const limit = getNumberArg(parsed, "limit", { min: 1 });
  const jsonl = hasFlag(parsed, "jsonl");

  let emitted = 0;

  if (jsonl) {
    streamLoop: for await (const batch of streamBooks(batchSize)) {
      for (const book of batch) {
        if (typeof limit === "number" && emitted >= limit) {
          break streamLoop;
        }
        process.stdout.write(`${JSON.stringify(book)}\n`);
        emitted += 1;
      }
    }

    return;
  }

  process.stdout.write("[");
  let first = true;

  streamLoop: for await (const batch of streamBooks(batchSize)) {
    for (const book of batch) {
      if (typeof limit === "number" && emitted >= limit) {
        break streamLoop;
      }

      if (!first) {
        process.stdout.write(",");
      }
      first = false;
      process.stdout.write(JSON.stringify(book));
      emitted += 1;
    }
  }

  process.stdout.write("]\n");
}

async function runCommand(parsed: ParsedArgs): Promise<void> {
  const command = normalizeCommand(parsed.command);

  if (hasFlag(parsed, "help") || command === "help") {
    process.stdout.write(HELP_TEXT);
    return;
  }

  switch (command) {
    case "health": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      const libraryPath = getLibraryPath();
      const dbPath = join(libraryPath, process.env.CALIBRE_DB_NAME || "metadata.db");
      const sourceExists = await Bun.file(dbPath).exists();
      let dbOk = false;
      let bookCount = 0;
      try {
        bookCount = getBookCount();
        dbOk = true;
      } catch {}
      printJSON({
        status: sourceExists && dbOk ? "ok" : "error",
        timestamp: Date.now(),
        libraryPath,
        sourceDbExists: sourceExists,
        dbQueryable: dbOk,
        bookCount: dbOk ? bookCount : null,
      });
      if (!sourceExists || !dbOk) {
        process.exitCode = 1;
      }
      return;
    }

    case "stats": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      printJSON(getLibraryStats());
      return;
    }

    case "count": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      printJSON({ count: getBookCount() });
      return;
    }

    case "list": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      const limit = getNumberArg(parsed, "limit", { defaultValue: 50, min: 1, max: 100 }) ?? 50;
      const cursor = getStringFlag(parsed, "cursor");
      const sortBy = getSortField(parsed);
      const sortOrder = getSortOrder(parsed);

      const result = listBooksCursor({
        cursor,
        limit,
        sortBy,
        sortOrder,
      });

      if (hasFlag(parsed, "table")) {
        printBookTable(result.items);
        process.stdout.write(`nextCursor: ${result.nextCursor ?? "null"}\n`);
        return;
      }

      printJSON(result);
      return;
    }

    case "search": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 1);
      const query = getStringArg(parsed, {
        flag: "query",
        positionalIndex: 0,
        required: true,
        description: "query",
      });
      const limit = getNumberArg(parsed, "limit", { defaultValue: 50, min: 1, max: 100 }) ?? 50;
      const cursor = getStringFlag(parsed, "cursor");

      const result = searchBooksCursor({ query, cursor, limit });

      if (hasFlag(parsed, "table")) {
        printBookTable(result.items);
        process.stdout.write(`nextCursor: ${result.nextCursor ?? "null"}\n`);
        return;
      }

      printJSON(result);
      return;
    }

    case "get": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      const id = getRequiredId(parsed);
      const book = getBookByIdOptimized(id);
      if (!book) {
        throw new CLIError(`Book not found for id ${id}`, 2);
      }
      printJSON(book);
      return;
    }

    case "stream": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      await handleStream(parsed);
      return;
    }

    case "search-title": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 1);
      const title = getStringArg(parsed, {
        flag: "title",
        positionalIndex: 0,
        required: true,
        description: "title",
      });
      const count = getNumberArg(parsed, "count", { defaultValue: 10, min: 1, max: 100 }) ?? 10;
      const result = searchBooksByTitle(title, count);

      if (hasFlag(parsed, "table")) {
        printBookTable(result);
        return;
      }

      printJSON(result);
      return;
    }

    case "search-author": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 1);
      const author = getStringArg(parsed, {
        flag: "author",
        positionalIndex: 0,
        required: true,
        description: "author",
      });
      const count = getNumberArg(parsed, "count", { defaultValue: 10, min: 1, max: 100 }) ?? 10;
      const result = searchBooksByAuthor(author, count);

      if (hasFlag(parsed, "table")) {
        printBookTable(result);
        return;
      }

      printJSON(result);
      return;
    }

    case "author-info": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 1);
      const author = getStringArg(parsed, {
        flag: "author",
        positionalIndex: 0,
        required: true,
        description: "author",
      });
      const result = getAuthorByName(author);
      if (!result) {
        throw new CLIError(`No author matched: ${author}`, 2);
      }
      printJSON(result);
      return;
    }

    case "library-path": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      printJSON({ path: getLibraryPath() });
      return;
    }

    case "format-path": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      const id = getRequiredId(parsed);
      const format = getStringArg(parsed, {
        flag: "format",
        required: true,
        description: "format",
      }).toUpperCase();

      const path = getBookFormatPath(id, format);
      if (!path) {
        throw new CLIError(`Format ${format} not found for book id ${id}`, 2);
      }

      printJSON({ id, format, path });
      return;
    }

    case "cover-path": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      const id = getRequiredId(parsed);
      const path = getBookCoverPath(id);
      if (!path) {
        throw new CLIError(`Cover not found for book id ${id}`, 2);
      }

      printJSON({ id, path });
      return;
    }

    case "download": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      const id = getRequiredId(parsed);
      const format = getStringArg(parsed, {
        flag: "format",
        required: true,
        description: "format",
      }).toUpperCase();

      const sourcePath = getBookFormatPath(id, format);
      if (!sourcePath) {
        throw new CLIError(`Format ${format} not found for book id ${id}`, 2);
      }

      const outputPath = getStringFlag(parsed, "out") ?? basename(sourcePath);
      await outputFileCopy(sourcePath, outputPath);
      return;
    }

    case "cover": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      const id = getRequiredId(parsed);
      const sourcePath = getBookCoverPath(id);
      if (!sourcePath) {
        throw new CLIError(`Cover not found for book id ${id}`, 2);
      }

      const fallbackName = `${id}-cover.jpg`;
      const outputPath = getStringFlag(parsed, "out") ?? fallbackName;
      await outputFileCopy(sourcePath, outputPath);
      return;
    }

    case "init-fts": {
      validateFlags(parsed, command);
      validatePositionals(parsed, command, 0);
      initFTS();
      printJSON({ initialized: true });
      return;
    }

    default:
      throw new CLIError(`Unknown command: ${command}`, 2);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(Bun.argv.slice(2));

  try {
    await runCommand(parsed);
  } catch (error) {
    if (error instanceof CLIError) {
      process.stderr.write(`Error: ${error.message}\n`);
      if (error.exitCode === 2) {
        process.stderr.write("\nUse --help for usage.\n");
      }
      process.exit(error.exitCode);
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

void main();
