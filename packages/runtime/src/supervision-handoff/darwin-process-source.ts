import { createRequire } from "node:module";
import { constants } from "node:os";

/** Read-only ABI boundary. No process enumeration, signals, handles or jobs. */
export interface DarwinProcessSource {
  bootSession(): string;
  bsdInfo(pid: number, includeZombies?: boolean): { bytes: Buffer; count: number; errno: number };
  executable(pid: number): { bytes: Buffer; count: number; errno: number };
}
// Public Darwin proc_bsdinfo ABI: 48 bytes of scalars, 48 bytes of names,
// 24 bytes of scalars, then the two uint64_t start-time fields (136 total).
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h
export const BSD_INFO_BYTES = 136;
export const PID_PATH_BYTES = 4096;
type DarwinHostSource = DarwinProcessSource & { memoryPressureLevel(): number };
let source: DarwinHostSource | undefined;
export function nativeDarwinProcessSource(): DarwinHostSource {
  if (source) return source;
  // Optional native capability: Node must import the SDK without resolving Bun.
  const { dlopen, ptr, read } = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
  const proc = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
    proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
  });
  const system = dlopen("/usr/lib/libSystem.B.dylib", {
    __error: { args: [], returns: "ptr" },
    sysctlbyname: { args: ["ptr", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
  });
  const errno = () => { const pointer = system.symbols.__error(); return pointer === null ? constants.errno.EIO : read.i32(pointer); };
  source = {
    memoryPressureLevel() {
      const name = Buffer.from("kern.memorystatus_vm_pressure_level\0");
      const value = new Int32Array(1), size = new BigUint64Array([4n]);
      if (system.symbols.sysctlbyname(ptr(name), ptr(value), ptr(size), null, 0) !== 0 || size[0] !== 4n) {
        throw new Error("macOS memory pressure is unavailable");
      }
      return value[0]!;
    },
    bootSession() {
      const name = Buffer.from("kern.bootsessionuuid\0"), bytes = Buffer.alloc(64), size = new BigUint64Array([64n]);
      if (system.symbols.sysctlbyname(ptr(name), ptr(bytes), ptr(size), null, 0) !== 0) return "";
      const count = Number(size[0]);
      if (count < 2 || count > bytes.length || bytes[count - 1] !== 0) return "";
      return bytes.subarray(0, count - 1).toString("utf8");
    },
    bsdInfo(pid, includeZombies = false) {
      const bytes = Buffer.alloc(BSD_INFO_BYTES);
      const count = proc.symbols.proc_pidinfo(pid, 3, includeZombies ? 1 : 0, ptr(bytes), bytes.length); // PROC_PIDTBSDINFO, arg=1 includes zombies
      return { bytes, count, errno: count === 0 ? errno() : 0 };
    },
    executable(pid) {
      const bytes = Buffer.alloc(PID_PATH_BYTES);
      const count = proc.symbols.proc_pidpath(pid, ptr(bytes), bytes.length);
      return { bytes, count, errno: count <= 0 ? errno() : 0 };
    },
  };
  return source;
}
