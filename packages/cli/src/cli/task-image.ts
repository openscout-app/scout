import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AttachmentUpload } from "@openscout/protocol";

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export async function readTaskImage(path: string): Promise<AttachmentUpload> {
  const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!mediaType) throw new Error("--image must be PNG, JPEG, GIF, or WebP");
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  const maxBytes = 25 * 1024 * 1024;
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size || info.size > maxBytes) throw new Error("image must be a non-empty file of at most 25 MiB");
    const chunks: Buffer[] = []; let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error("image exceeds 25 MiB");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (!size) throw new Error("image is empty");
    return { data: Buffer.concat(chunks).toString("base64"), mediaType, fileName: basename(path) };
  } finally { await file.close(); }
}
