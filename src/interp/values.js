/**
 * Lumen Reference Interpreter Runtime Values (`src/interp/values.js`)
 * Owned exclusively by Agent E.
 *
 * Implements exact Wasm-compatible runtime values and arithmetic semantics:
 * - `i32`: 32-bit signed integers with wrapping (`| 0`, `Math.imul`)
 * - `i64`: 64-bit signed BigInts with wrapping (`BigInt.asIntN(64, ...)`)
 * - `f64`: 64-bit IEEE 754 floats (`Number`)
 * - `bool`: `Boolean`
 * - `string`: UTF-8 byte sequence (`Uint8Array` / `Buffer.from(str, "utf8")` semantics)
 * - `array`: `{ kind: "array", elements: Value[] }` (reference type, shared on assignment/passing)
 * - `struct`: `{ kind: "struct", name: string, fields: Map<string, Value> }` (reference type, shared on assignment/passing)
 * - `enum`: `{ kind: "enum", enumName: string, variantName: string, args: Value[] }`
 * - `closure`: `{ kind: "closure", params: string[], body: Node, env: Scope }`
 * - `void`: `null`
 */

import {
  LumenRuntimeError,
  checkedDivI32,
  checkedRemI32,
  checkedDivI64,
  checkedRemI64,
  truncSatF64ToI32,
  truncSatF64ToI64,
  formatFloat64,
  fnv1aHashBytes,
  fnv1aCombineI32,
} from "../contracts/index.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export { LumenRuntimeError };
export const RuntimeError = LumenRuntimeError;

// ============================================================================
// 1. Primitive Constructors & Exact Wasm Arithmetic Helpers
// ============================================================================

export function toI32(n) {
  if (typeof n === "bigint") {
    return Number(BigInt.asIntN(32, n)) | 0;
  }
  if (typeof n === "boolean") {
    return n ? 1 : 0;
  }
  return Number(n) | 0;
}

export function toI64(n) {
  if (typeof n === "bigint") {
    return BigInt.asIntN(64, n);
  }
  if (typeof n === "boolean") {
    return n ? 1n : 0n;
  }
  if (typeof n === "number") {
    return truncSatF64ToI64(n);
  }
  return BigInt.asIntN(64, BigInt(n));
}

export function toF64(n) {
  if (typeof n === "bigint") {
    return Number(n);
  }
  if (typeof n === "boolean") {
    return n ? 1.0 : 0.0;
  }
  return Number(n);
}

export function toBool(b) {
  return Boolean(b);
}

export function castToI32(val) {
  if (typeof val === "bigint") {
    return Number(BigInt.asIntN(32, val)) | 0;
  }
  if (typeof val === "boolean") {
    return val ? 1 : 0;
  }
  return truncSatF64ToI32(val);
}

export function castToI64(val) {
  if (typeof val === "bigint") {
    return BigInt.asIntN(64, val);
  }
  if (typeof val === "boolean") {
    return val ? 1n : 0n;
  }
  return truncSatF64ToI64(val);
}

// Exact 32-bit signed integer arithmetic matching Wasm i32 instructions
export const I32 = Object.freeze({
  add(a, b) {
    return ((a | 0) + (b | 0)) | 0;
  },
  sub(a, b) {
    return ((a | 0) - (b | 0)) | 0;
  },
  mul(a, b) {
    return Math.imul(a | 0, b | 0) | 0;
  },
  divS(a, b) {
    return checkedDivI32(a, b);
  },
  remS(a, b) {
    return checkedRemI32(a, b);
  },
  and(a, b) {
    return (a | 0) & (b | 0);
  },
  or(a, b) {
    return (a | 0) | (b | 0);
  },
  xor(a, b) {
    return (a | 0) ^ (b | 0);
  },
  shl(a, b) {
    return (a | 0) << ((b | 0) & 31);
  },
  shrS(a, b) {
    return (a | 0) >> ((b | 0) & 31);
  },
  neg(a) {
    return (-(a | 0)) | 0;
  },
  not(a) {
    return ~(a | 0);
  },
});

// Exact 64-bit signed integer arithmetic matching Wasm i64 instructions
export const I64 = Object.freeze({
  add(a, b) {
    return BigInt.asIntN(64, toI64(a) + toI64(b));
  },
  sub(a, b) {
    return BigInt.asIntN(64, toI64(a) - toI64(b));
  },
  mul(a, b) {
    return BigInt.asIntN(64, toI64(a) * toI64(b));
  },
  divS(a, b) {
    return checkedDivI64(toI64(a), toI64(b));
  },
  remS(a, b) {
    return checkedRemI64(toI64(a), toI64(b));
  },
  and(a, b) {
    return BigInt.asIntN(64, toI64(a) & toI64(b));
  },
  or(a, b) {
    return BigInt.asIntN(64, toI64(a) | toI64(b));
  },
  xor(a, b) {
    return BigInt.asIntN(64, toI64(a) ^ toI64(b));
  },
  shl(a, b) {
    const shift = toI64(b) & 63n;
    return BigInt.asIntN(64, toI64(a) << shift);
  },
  shrS(a, b) {
    const shift = toI64(b) & 63n;
    return BigInt.asIntN(64, toI64(a) >> shift);
  },
  neg(a) {
    return BigInt.asIntN(64, -toI64(a));
  },
  not(a) {
    return BigInt.asIntN(64, ~toI64(a));
  },
});

// ============================================================================
// 2. Reference-Type Compound Value Constructors
//    (Structs, arrays, and strings are reference types: never cloned on assignment)
// ============================================================================

export function createArray(elements = []) {
  return {
    kind: "array",
    elements: Array.isArray(elements) ? elements : Array.from(elements),
  };
}

export function createStruct(name, fieldsInput = new Map()) {
  const fields =
    fieldsInput instanceof Map
      ? fieldsInput
      : new Map(Object.entries(fieldsInput));
  return {
    kind: "struct",
    name,
    fields,
  };
}

export function createEnum(enumName, variantName, args = []) {
  return {
    kind: "enum",
    enumName: enumName || "",
    variantName,
    args: Array.isArray(args) ? args : Array.from(args),
  };
}

export function createClosure(params, body, env, meta = {}) {
  return {
    kind: "closure",
    params,
    body,
    env,
    ...meta,
  };
}

export function createRange(start, end, inclusive = false) {
  return {
    kind: "range",
    start,
    end,
    inclusive,
  };
}

// ============================================================================
// 3. String Helpers (UTF-8 Byte Semantics & FNV-1a 32-bit Hash)
// ============================================================================

export function toUtf8Bytes(str) {
  if (str instanceof Uint8Array) {
    return str;
  }
  if (str && typeof str === "object" && str.bytes instanceof Uint8Array) {
    return str.bytes;
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(String(str ?? ""), "utf8"));
  }
  return textEncoder.encode(String(str ?? ""));
}

export function fromUtf8Bytes(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("utf8");
  }
  return textDecoder.decode(bytes);
}

export function strByteLen(str) {
  return toUtf8Bytes(str).length | 0;
}

export function strSliceBytes(str, start, end) {
  const bytes = toUtf8Bytes(str);
  const st = start | 0;
  const en = end | 0;
  if (st < 0 || en < st || en > bytes.length) {
    throw new LumenRuntimeError("index out of bounds");
  }
  return fromUtf8Bytes(bytes.subarray(st, en));
}

export function strCharAtByte(str, index) {
  const bytes = toUtf8Bytes(str);
  const idx = index | 0;
  if (idx < 0 || idx >= bytes.length) {
    throw new LumenRuntimeError("index out of bounds");
  }
  return bytes[idx] & 0xff;
}

export function strConcatBytes(a, b) {
  const bytesA = toUtf8Bytes(a);
  const bytesB = toUtf8Bytes(b);
  const combined = new Uint8Array(bytesA.length + bytesB.length);
  combined.set(bytesA, 0);
  combined.set(bytesB, bytesA.length);
  return fromUtf8Bytes(combined);
}

export function strEqualsBytes(a, b) {
  const bytesA = toUtf8Bytes(a);
  const bytesB = toUtf8Bytes(b);
  if (bytesA.length !== bytesB.length) return false;
  for (let i = 0; i < bytesA.length; i++) {
    if (bytesA[i] !== bytesB[i]) return false;
  }
  return true;
}

export function strCompareBytes(a, b) {
  const bytesA = toUtf8Bytes(a);
  const bytesB = toUtf8Bytes(b);
  const minLen = Math.min(bytesA.length, bytesB.length);
  for (let i = 0; i < minLen; i++) {
    if (bytesA[i] !== bytesB[i]) {
      return bytesA[i] < bytesB[i] ? -1 : 1;
    }
  }
  if (bytesA.length === bytesB.length) return 0;
  return bytesA.length < bytesB.length ? -1 : 1;
}

/**
 * Standard 32-bit FNV-1a hash over UTF-8 bytes via shared contract helper.
 */
export function fnv1aHash32(str) {
  return fnv1aHashBytes(toUtf8Bytes(str));
}

// ============================================================================
// 4. Value Formatting, Deep Equality & Hashing (Matching Wasm Output 100%)
// ============================================================================

export function formatFloat(f) {
  return formatFloat64(f);
}

export function formatInt(n) {
  return String(n | 0);
}

export function formatI64(n) {
  return String(BigInt.asIntN(64, BigInt(n)));
}

export function formatBool(b) {
  return b ? "true" : "false";
}

export function formatValue(val) {
  if (val === null || val === undefined) {
    return "";
  }
  if (typeof val === "string") {
    return val;
  }
  if (val instanceof Uint8Array) {
    return fromUtf8Bytes(val);
  }
  if (typeof val === "number") {
    return formatFloat64(val);
  }
  if (typeof val === "bigint") {
    return String(BigInt.asIntN(64, val));
  }
  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }
  if (typeof val === "object") {
    switch (val.kind) {
      case "array":
        return `[${val.elements.map((e) => formatValueRepr(e)).join(", ")}]`;
      case "struct": {
        const parts = [];
        for (const [k, v] of val.fields.entries()) {
          parts.push(`${k}: ${formatValueRepr(v)}`);
        }
        return `${val.name} { ${parts.join(", ")} }`;
      }
      case "enum":
        if (val.args && val.args.length > 0) {
          return `${val.variantName}(${val.args.map((a) => formatValueRepr(a)).join(", ")})`;
        }
        return val.variantName;
      case "closure":
        return "<fn>";
      default:
        return String(val);
    }
  }
  return String(val);
}

function formatValueRepr(val) {
  if (typeof val === "string") {
    return val;
  }
  return formatValue(val);
}

export function valuesEqual(a, b) {
  if (a === b) {
    if (typeof a === "number" && Number.isNaN(a)) return false;
    return true;
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return strEqualsBytes(a, b);
  }
  if (typeof a === "number" && typeof b === "number") {
    return a === b;
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    return BigInt.asIntN(64, a) === BigInt.asIntN(64, b);
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (typeof a === "object" && typeof b === "object") {
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
      case "array":
        if (a.elements.length !== b.elements.length) return false;
        for (let i = 0; i < a.elements.length; i++) {
          if (!valuesEqual(a.elements[i], b.elements[i])) return false;
        }
        return true;
      case "struct":
        if (a.name !== b.name) return false;
        if (a.fields.size !== b.fields.size) return false;
        for (const [k, v] of a.fields.entries()) {
          if (!b.fields.has(k)) return false;
          if (!valuesEqual(v, b.fields.get(k))) return false;
        }
        return true;
      case "enum":
        if (a.variantName !== b.variantName) return false;
        if (a.enumName && b.enumName && a.enumName !== b.enumName) return false;
        if (a.args.length !== b.args.length) return false;
        for (let i = 0; i < a.args.length; i++) {
          if (!valuesEqual(a.args[i], b.args[i])) return false;
        }
        return true;
      case "closure":
        return a === b;
      default:
        return false;
    }
  }
  return false;
}

export function hashValue(val) {
  const FNV_OFFSET = 2166136261 | 0;
  if (val === null || val === undefined) {
    return 0;
  }
  if (typeof val === "string" || val instanceof Uint8Array) {
    return fnv1aHashBytes(toUtf8Bytes(val));
  }
  if (typeof val === "boolean") {
    return fnv1aCombineI32(FNV_OFFSET, val ? 1 : 0);
  }
  if (typeof val === "number") {
    if (Number.isInteger(val) && !Object.is(val, -0) && val >= -2147483648 && val <= 2147483647) {
      return fnv1aCombineI32(FNV_OFFSET, val | 0);
    }
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, val, true);
    return fnv1aHashBytes(new Uint8Array(buf));
  }
  if (typeof val === "bigint") {
    const v = BigInt.asIntN(64, val);
    const lo = Number(BigInt.asIntN(32, v)) | 0;
    const hi = Number(BigInt.asIntN(32, v >> 32n)) | 0;
    let h = fnv1aCombineI32(FNV_OFFSET, lo);
    return fnv1aCombineI32(h, hi);
  }
  if (typeof val === "object") {
    let h = FNV_OFFSET;
    switch (val.kind) {
      case "struct":
        for (const [, fieldVal] of val.fields.entries()) {
          h = fnv1aCombineI32(h, hashValue(fieldVal));
        }
        return h | 0;
      case "enum":
        h = fnv1aCombineI32(
          h,
          val.tagIndex !== undefined ? val.tagIndex | 0 : fnv1aHash32(val.variantName)
        );
        for (const arg of val.args || []) {
          h = fnv1aCombineI32(h, hashValue(arg));
        }
        return h | 0;
      case "array":
        for (const elem of val.elements || []) {
          h = fnv1aCombineI32(h, hashValue(elem));
        }
        return h | 0;
      default:
        return 0;
    }
  }
  return 0;
}
