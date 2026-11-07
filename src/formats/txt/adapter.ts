import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { decodeTxt } from "./decode.js";
import { parseTxtDocument } from "./chapters.js";

export async function openTxt(path: string, sourceRevision: string) {
  const bytes = await readFile(path);
  const decoded = decodeTxt(bytes);
  const fallbackTitle = basename(path, extname(path));
  return { ...parseTxtDocument(decoded.text, sourceRevision, fallbackTitle), encoding: decoded.encoding };
}
