// A growing JSONL file, read a piece at a time. Each complete line is handed
// over once, so a reader that polls a long transcript does work in proportion
// to what was appended, not to the whole file on every poll. A line still
// being written waits for the read that sees its end.

import { open } from "node:fs/promises";

const PIECE_BYTES = 4 * 1024 * 1024;
/** A single line longer than this is passed over, not held in memory. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;

export type LineTail = {
  /** The file's size at the last read. */
  size(): number;
  /** Whether the last read left an unfinished line at the end of the file. */
  unfinished(): boolean;
  /**
   * Hand over the complete lines appended since the last read. False when the
   * file cannot be read. Reads never overlap: one that starts while another
   * runs waits for it, and then sees only what that one left.
   */
  read(onLine: (line: string) => void): Promise<boolean>;
};

export function openLineTail(
  path: string,
  offset = 0,
  options: {
    /**
     * Called when the file is found shorter than what was already read: it was
     * replaced. Reading then starts again from its first line. Without this, a
     * shorter file reads as nothing new.
     */
    onReplaced?: () => void;
  } = {},
): LineTail {
  let position = Math.max(0, offset);
  let seen = position;
  let last: Promise<unknown> = Promise.resolve();

  const readOnce = async (onLine: (line: string) => void): Promise<boolean> => {
    let handle;
    try {
      handle = await open(path, "r");
    } catch {
      return false;
    }
    try {
      const { size } = await handle.stat();
      if (size < position && options.onReplaced) {
        position = 0;
        options.onReplaced();
      }
      seen = size;
      let want = PIECE_BYTES;
      while (position < size) {
        const buffer = Buffer.alloc(Math.min(want, size - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) break;
        const piece = buffer.subarray(0, bytesRead);
        const end = piece.lastIndexOf(NEWLINE);
        if (end < 0) {
          // One line longer than the piece: its end is not written yet, or
          // it needs a larger piece.
          if (position + bytesRead >= size) break;
          if (want >= MAX_LINE_BYTES) position += bytesRead;
          else want *= 2;
          continue;
        }
        for (const line of piece.subarray(0, end).toString("utf8").split("\n")) onLine(line);
        position += end + 1;
        want = PIECE_BYTES;
      }
      return true;
    } catch {
      return false;
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  return {
    size: () => seen,
    unfinished: () => seen > position,
    read(onLine) {
      const next = last.then(() => readOnce(onLine));
      last = next.catch(() => undefined);
      return next;
    },
  };
}
