import { randomUUID } from "node:crypto";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { ReaderError } from "../../shared/errors.js";
import { quickFingerprint } from "../library/fingerprint.js";
import { TRASH_DIRECTORY_NAME, hasTrashDirectorySegment } from "../storage/trash-directory.js";

export interface TrashRecord {
  id: string;
  bookId: string | null;
  originalPath: string;
  trashPath: string;
  fileSize: number | null;
  contentHash: string | null;
  deletedAt: string;
  restoredAt: string | null;
}

export interface RestoreResult {
  success: boolean;
  conflict?: boolean;
  conflictingPath?: string;
}

export class TrashBinService {
  constructor(
    private readonly db: Database.Database,
    private readonly root: string
  ) {}

  private resolveCandidate(candidate: string): string {
    return isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(this.root, candidate);
  }

  private checkBoundary(absolutePath: string): void {
    const rel = relative(this.root, absolutePath);
    // `relative` returns the absolute target path when the two paths are on different
    // drives, and that does NOT start with "..". Without the `:` check,
    // `path.relative("E:\\root", "C:\\evil.txt")` reads as contained.
    if (rel.startsWith("..") || rel.includes(":") || absolutePath === this.root) {
      throw new ReaderError("FILE_NOT_READABLE", "路径不在授权根目录内");
    }
    if (hasTrashDirectorySegment(absolutePath)) {
      throw new ReaderError("FILE_NOT_READABLE", "不能操作回收站内文件");
    }
  }

  async trashFile(authorizedRoot: string, candidate: string, bookId?: string): Promise<TrashRecord> {
    const normalizedRoot = resolve(authorizedRoot);
    const absolutePath = this.resolveCandidate(candidate);
    this.checkBoundary(absolutePath);

    // Re-verify file exists
    let fileStat: { size: number; mtimeMs: number };
    try {
      fileStat = await stat(absolutePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ReaderError("INVALID_PACKAGE", `文件不存在或不可访问: ${msg}`);
    }

    const fingerprint = await quickFingerprint(absolutePath).then((fp) => fp.fingerprint);

    // Idempotency: check if this file was already trashed
    const existing = this.db.prepare(
      "SELECT * FROM trash_records WHERE original_path = ? AND restored_at IS NULL LIMIT 1"
    ).get(absolutePath) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        id: existing.id as string,
        bookId: existing.book_id as string | null,
        originalPath: existing.original_path as string,
        trashPath: existing.trash_path as string,
        fileSize: existing.file_size as number | null,
        contentHash: existing.content_hash as string | null,
        deletedAt: existing.deleted_at as string,
        restoredAt: existing.restored_at as string | null,
      };
    }

    const trashDir = join(normalizedRoot, TRASH_DIRECTORY_NAME);
    await mkdir(trashDir, { recursive: true });

    const ext = relative(this.root, absolutePath).includes(".")
      ? relative(this.root, absolutePath).split(".").pop()!
      : "bin";
    const trashName = `${randomUUID()}.${ext}`;
    const trashPath = join(trashDir, trashName);

    // Step 1: Move file to trash
    await rename(absolutePath, trashPath);

    // Step 2: Write database record
    const id = randomUUID();
    const now = new Date().toISOString();

    try {
      this.db.prepare(
        "INSERT INTO trash_records(id, book_id, original_path, trash_path, file_size, content_hash, deleted_at) VALUES (?,?,?,?,?,?,?)"
      ).run(id, bookId ?? null, absolutePath, trashPath, fileStat.size, fingerprint, now);
    } catch (dbErr: unknown) {
      // Compensation: move file back to original path if DB write fails
      try { await rename(trashPath, absolutePath); } catch {
        // Recovery-required: file is in trash, DB has no record
        throw new ReaderError("INVALID_REQUEST", "文件移动已完成但记录写入失败，请手动检查回收站");
      }
      throw dbErr;
    }

    return {
      id, bookId: bookId ?? null, originalPath: absolutePath, trashPath,
      fileSize: fileStat.size, contentHash: fingerprint, deletedAt: now, restoredAt: null,
    };
  }

  listTrash(): TrashRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM trash_records WHERE restored_at IS NULL ORDER BY deleted_at DESC"
    ).all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRecord(r));
  }

  async restoreFile(id: string): Promise<RestoreResult> {
    const row = this.db.prepare("SELECT * FROM trash_records WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ReaderError("INVALID_REQUEST", "回收记录不存在");

    const originalPath = row.original_path as string;
    const trashPath = row.trash_path as string;
    const restoredAt = row.restored_at as string | null;

    // Already restored — idempotent
    if (restoredAt) return { success: true };

    // Verify paths belong to this service's root
    this.checkBoundary(originalPath);
    if (!hasTrashDirectorySegment(trashPath)) {
      throw new ReaderError("INVALID_REQUEST", "回收路径无效");
    }

    // Check original path occupancy
    try {
      await stat(originalPath);
      return { success: false, conflict: true, conflictingPath: originalPath };
    } catch { /* path is free */ }

    await mkdir(dirname(originalPath), { recursive: true });
    await rename(trashPath, originalPath);

    const now = new Date().toISOString();
    this.db.prepare("UPDATE trash_records SET restored_at = ? WHERE id = ?").run(now, id);

    return { success: true };
  }

  private mapRecord(r: Record<string, unknown>): TrashRecord {
    return {
      id: r.id as string,
      bookId: r.book_id as string | null,
      originalPath: r.original_path as string,
      trashPath: r.trash_path as string,
      fileSize: r.file_size as number | null,
      contentHash: r.content_hash as string | null,
      deletedAt: r.deleted_at as string,
      restoredAt: r.restored_at as string | null,
    };
  }
}
