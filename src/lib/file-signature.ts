import { statSync } from "node:fs";

export interface SourceSignature {
  size: number;
  mtimeMs: number;
  walSize?: number;
  walMtimeMs?: number;
  shmSize?: number;
  shmMtimeMs?: number;
}

export function getSourceSignature(path: string): SourceSignature {
  const stat = statSync(path);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function getOptionalSidecarSignature(path: string): { size: number; mtimeMs: number } {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

/**
 * SQLite may keep the newest Calibre changes in -wal/-shm files. Include
 * those files when deciding whether the writable snapshot is stale.
 */
export function getDatabaseSignature(path: string): SourceSignature {
  const source = getSourceSignature(path);
  const wal = getOptionalSidecarSignature(`${path}-wal`);
  const shm = getOptionalSidecarSignature(`${path}-shm`);
  return {
    ...source,
    walSize: wal.size,
    walMtimeMs: wal.mtimeMs,
    shmSize: shm.size,
    shmMtimeMs: shm.mtimeMs,
  };
}

export function isSameSignature(
  a: SourceSignature | null,
  b: SourceSignature,
): boolean {
  return Boolean(
    a &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      (a.walSize ?? 0) === (b.walSize ?? 0) &&
      (a.walMtimeMs ?? 0) === (b.walMtimeMs ?? 0) &&
      (a.shmSize ?? 0) === (b.shmSize ?? 0) &&
      (a.shmMtimeMs ?? 0) === (b.shmMtimeMs ?? 0),
  );
}
