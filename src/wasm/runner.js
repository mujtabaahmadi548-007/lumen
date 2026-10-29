/**
 * Lumen WebAssembly Execution Runner (`src/wasm/runner.js`)
 * Owned exclusively by Agent D.
 * Instantiates and runs compiled `.wasm` modules synchronously (`runWasmSync`)
 * and asynchronously (`runWasm`) in Node.js and the Browser.
 */

import {
  LumenRuntimeError,
  formatFloat64,
  alignUp,
  GC_HEADER_SIZE,
  GC_FLAGS,
  OBJ_KIND,
  MEM_LAYOUT,
} from "../contracts/index.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

const TRAP_CODES = Object.freeze({
  1: "division by zero",
  2: "integer overflow",
  3: "index out of bounds",
  4: "stack overflow",
  5: "out of memory",
  6: "assertion failed",
  7: "pop from empty array",
  8: "string slice out of bounds",
  9: "string index out of bounds",
});

/**
 * Create the host environment (`env`) import object and execution context for a Wasm run.
 */
function createHostEnv(options = {}) {
  let wasmInstance = null;
  let stdout = "";
  const stepTrace = [];

  function getMemory() {
    return wasmInstance.exports.memory;
  }

  function getMemoryBytes() {
    return new Uint8Array(getMemory().buffer);
  }

  function getMemoryView() {
    return new DataView(getMemory().buffer);
  }

  /**
   * Read a Lumen string object from Wasm linear memory:
   * - +0..+7:  8-byte GC header
   * - +8..+11: `byte_len : u32`
   * - +12..:   UTF-8 bytes
   */
  function readStringFromMemory(strPtr) {
    if (!strPtr || strPtr < 0) return "";
    const mem = getMemoryBytes();
    const view = getMemoryView();
    if (strPtr + 12 > mem.length) return "";
    const byteLen = view.getUint32(strPtr + 8, true);
    const start = strPtr + 12;
    const end = Math.min(start + byteLen, mem.length);
    return textDecoder.decode(mem.subarray(start, end));
  }

  /**
   * Allocate a new string object on the Wasm heap (`__heap_top`) in canonical layout:
   * - +0: `gc_flags = GC_FLAGS.NONE`
   * - +1: `obj_kind = OBJ_KIND.STRING`
   * - +2: `type_desc_id = 0`
   * - +4: `payload_size = align8(4 + utf8.length)`
   * - +8: `byte_len = utf8.length`
   * - +12: UTF-8 bytes
   */
  function allocStringInMemory(str) {
    const utf8 = textEncoder.encode(String(str));
    const byteLen = utf8.length;
    const payloadSize = alignUp(4 + byteLen, 8);
    const totalSize = GC_HEADER_SIZE + payloadSize;

    const heapTopGlobal = wasmInstance.exports.__heap_top;
    const baseAddr = heapTopGlobal
      ? alignUp(heapTopGlobal.value >>> 0, 8)
      : MEM_LAYOUT.HEAP_START;
    const nextTop = baseAddr + totalSize;

    const wasmMem = getMemory();
    const currentBytes = wasmMem.buffer.byteLength;
    if (nextTop > currentBytes) {
      const pagesNeeded = Math.ceil((nextTop - currentBytes) / 65536);
      const prevPages = wasmMem.grow(pagesNeeded);
      if (prevPages < 0) {
        throw new LumenRuntimeError("out of memory");
      }
    }

    if (heapTopGlobal) {
      heapTopGlobal.value = nextTop;
    }

    const mem = getMemoryBytes();
    const view = getMemoryView();
    mem.fill(0, baseAddr, nextTop);
    mem[baseAddr] = GC_FLAGS.NONE;
    mem[baseAddr + 1] = OBJ_KIND.STRING;
    view.setUint16(baseAddr + 2, 0, true);
    view.setUint32(baseAddr + 4, payloadSize, true);
    view.setUint32(baseAddr + 8, byteLen, true);
    mem.set(utf8, baseAddr + 12);

    return baseAddr;
  }

  const env = {
    __lumen_print_str(strPtr) {
      const s = readStringFromMemory(strPtr >>> 0);
      stdout += s;
      if (typeof options.onStdout === "function") {
        options.onStdout(s);
      }
    },

    __lumen_println_str(strPtr) {
      const s = readStringFromMemory(strPtr >>> 0) + "\n";
      stdout += s;
      if (typeof options.onStdout === "function") {
        options.onStdout(s);
      }
    },

    __lumen_print_i32(val) {
      const s = String(val | 0);
      stdout += s;
      if (typeof options.onStdout === "function") {
        options.onStdout(s);
      }
    },

    __lumen_println_i32(val) {
      const s = String(val | 0) + "\n";
      stdout += s;
      if (typeof options.onStdout === "function") {
        options.onStdout(s);
      }
    },

    __lumen_i32_to_str(val) {
      return allocStringInMemory(String(val | 0));
    },

    __lumen_i64_to_str(val) {
      const b = typeof val === "bigint" ? BigInt.asIntN(64, val) : BigInt(val | 0);
      return allocStringInMemory(b.toString());
    },

    __lumen_f64_to_str(val) {
      return allocStringInMemory(formatFloat64(val));
    },

    __lumen_bool_to_str(val) {
      return allocStringInMemory((val | 0) !== 0 ? "true" : "false");
    },

    __lumen_str_concat(ptrA, ptrB) {
      const strA = readStringFromMemory(ptrA >>> 0);
      const strB = readStringFromMemory(ptrB >>> 0);
      return allocStringInMemory(strA + strB);
    },

    __lumen_str_eq(ptrA, ptrB) {
      const a = ptrA >>> 0;
      const b = ptrB >>> 0;
      if (a === b) return 1;
      if (!a || !b) return 0;
      const mem = getMemoryBytes();
      const view = getMemoryView();
      const lenA = view.getUint32(a + 8, true);
      const lenB = view.getUint32(b + 8, true);
      if (lenA !== lenB) return 0;
      for (let i = 0; i < lenA; i++) {
        if (mem[a + 12 + i] !== mem[b + 12 + i]) return 0;
      }
      return 1;
    },

    __lumen_trap(codeOrPtr) {
      const u = codeOrPtr >>> 0;
      if (TRAP_CODES[u]) {
        throw new LumenRuntimeError(TRAP_CODES[u]);
      }
      if (u >= MEM_LAYOUT.STATIC_STRING_START) {
        const msg = readStringFromMemory(u);
        throw new LumenRuntimeError(msg || "unreachable");
      }
      throw new LumenRuntimeError("unreachable");
    },

    __lumen_debug_step(line, col, fnId, shadowFp) {
      const stepEvent = {
        line: line | 0,
        col: col | 0,
        fnId: fnId | 0,
        shadowFp: shadowFp >>> 0,
      };
      if (options.collectStepTrace) {
        stepTrace.push(stepEvent);
      }
      if (options.debugHooks && typeof options.debugHooks.onStep === "function") {
        options.debugHooks.onStep(stepEvent, wasmInstance, options.debugInfo);
      } else if (typeof options.onStep === "function") {
        options.onStep(stepEvent, wasmInstance, options.debugInfo);
      }
    },
  };

  return {
    imports: { env },
    setInstance(inst) {
      wasmInstance = inst;
    },
    getStdout() {
      return stdout;
    },
    getStepTrace() {
      return stepTrace;
    },
  };
}

/**
 * Normalize any runtime error / WebAssembly trap into a uniform `{ errorText, exitCode: 1 }`.
 */
function normalizeRuntimeError(err) {
  if (err instanceof LumenRuntimeError) {
    return err.format();
  }
  const msg = String(err?.message || err || "trap");
  if (/divide by zero|remainder by zero|division by zero/i.test(msg)) {
    return "runtime error: division by zero";
  }
  if (/integer overflow/i.test(msg)) {
    return "runtime error: integer overflow";
  }
  if (/call stack size exceeded|stack overflow/i.test(msg)) {
    return "runtime error: stack overflow";
  }
  if (/out of bounds memory access|index out of bounds/i.test(msg)) {
    return "runtime error: index out of bounds";
  }
  if (msg.startsWith("runtime error: ")) {
    return msg;
  }
  return `runtime error: ${msg}`;
}

/**
 * Synchronously instantiate and execute a WebAssembly binary module.
 *
 * @param {Uint8Array} wasmBytes
 * @param {object} [options]
 * @returns {{ stdout: string, errorText: string, returnValue: any, exitCode: number, stepTrace: object[], instance: WebAssembly.Instance | null }}
 */
export function runWasmSync(wasmBytes, options = {}) {
  const host = createHostEnv(options);
  let instance = null;

  try {
    const mod = new WebAssembly.Module(wasmBytes);
    instance = new WebAssembly.Instance(mod, host.imports);
    host.setInstance(instance);

    const entryName = options.entry || "main";
    const entryFn = instance.exports[entryName];
    if (typeof entryFn !== "function") {
      throw new LumenRuntimeError(`missing entry function '${entryName}'`);
    }

    const returnValue = entryFn(...(options.args || []));
    return {
      stdout: host.getStdout(),
      errorText: "",
      returnValue: returnValue ?? null,
      exitCode: 0,
      stepTrace: host.getStepTrace(),
      instance,
    };
  } catch (err) {
    return {
      stdout: host.getStdout(),
      errorText: normalizeRuntimeError(err),
      returnValue: null,
      exitCode: 1,
      stepTrace: host.getStepTrace(),
      instance,
    };
  }
}

/**
 * Asynchronously instantiate and execute a WebAssembly binary module.
 *
 * @param {Uint8Array} wasmBytes
 * @param {object} [options]
 * @returns {Promise<{ stdout: string, errorText: string, returnValue: any, exitCode: number, stepTrace: object[], instance: WebAssembly.Instance | null }>}
 */
export async function runWasm(wasmBytes, options = {}) {
  const host = createHostEnv(options);
  let instance = null;

  try {
    const result = await WebAssembly.instantiate(wasmBytes, host.imports);
    instance = result.instance || result;
    host.setInstance(instance);

    const entryName = options.entry || "main";
    const entryFn = instance.exports[entryName];
    if (typeof entryFn !== "function") {
      throw new LumenRuntimeError(`missing entry function '${entryName}'`);
    }

    const returnValue = entryFn(...(options.args || []));
    return {
      stdout: host.getStdout(),
      errorText: "",
      returnValue: returnValue ?? null,
      exitCode: 0,
      stepTrace: host.getStepTrace(),
      instance,
    };
  } catch (err) {
    return {
      stdout: host.getStdout(),
      errorText: normalizeRuntimeError(err),
      returnValue: null,
      exitCode: 1,
      stepTrace: host.getStepTrace(),
      instance,
    };
  }
}
