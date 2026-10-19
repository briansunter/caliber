// Server/CLI spawn command selection for the black-box test suites.
//
// By default the tests exercise the TypeScript implementation exactly as
// before. Setting CALIBER_TEST_SERVER / CALIBER_TEST_CLI redirects the
// spawned processes at another implementation (the Rust backend) so the
// same compatibility suite runs against it, e.g.:
//
//   cargo build -p caliber-server --release
//   CALIBER_TEST_SERVER="./target/release/caliber-server" bun test tests/integration.test.ts
//   CALIBER_TEST_SERVER="./target/release/caliber-server" bun test tests/auth.test.ts
//   CALIBER_TEST_CLI="./target/release/caliber-cli" ... (auth.test.ts CLI suites)
//
// The command string is split on whitespace; no shell is involved.

export interface SpawnCommand {
  cmd: string;
  args: string[];
}

function parseCommand(raw: string | undefined, fallback: SpawnCommand): SpawnCommand {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  return { cmd: parts[0], args: parts.slice(1) };
}

export function serverCommand(): SpawnCommand {
  return parseCommand(process.env.CALIBER_TEST_SERVER, {
    cmd: process.execPath,
    args: ["src/index.ts"],
  });
}

export function cliCommand(): SpawnCommand {
  return parseCommand(process.env.CALIBER_TEST_CLI, {
    cmd: "bun",
    args: ["src/cli.ts"],
  });
}
