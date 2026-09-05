import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// Limit allocation and I/O by bytes, including for sparse/multi-gigabyte logs.
export function readLogTail(file, maxBytes = 12000) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const count = readSync(fd, buffer, 0, length, Math.max(0, size - length));
    let start = 0;
    if (size > length) {
      while (start < count && (buffer[start] & 0xc0) === 0x80) start += 1;
    }
    return buffer.subarray(start, count).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function readLogPreview(file, maxBytes = 256 * 1024) {
  const text = readLogTail(file, maxBytes);
  return Buffer.byteLength(text) >= maxBytes - 4
    ? `[Showing the last ${maxBytes} bytes; full log remains on disk.]\n${text}`
    : text;
}
