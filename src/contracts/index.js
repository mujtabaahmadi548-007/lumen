/**
 * Lumen Shared Contracts (`src/contracts/index.js`)
 * Owned exclusively by the Lead Engineer.
 * All agents (A-G) MUST obey the AST, Type, Diagnostic, LIR, Runtime Semantics,
 * and Dynamic Memory Layout schemas defined here.
 */

// ============================================================================
// 1. Source Spans & Diagnostics
// ============================================================================

export const ErrorCodes = Object.freeze({
  // Lexer (E0001 - E0099)
  LEX_UNEXPECTED_CHAR: "E0001",
  LEX_UNTERMINATED_STRING: "E0002",
  LEX_INVALID_ESCAPE: "E0003",
  LEX_INVALID_NUMBER: "E0004",
  LEX_UNTERMINATED_COMMENT: "E0005",

  // Parser (E0101 - E0199)
  PARSE_UNEXPECTED_TOKEN: "E0101",
  PARSE_EXPECTED_TOKEN: "E0102",
  PARSE_EXPECTED_EXPR: "E0103",
  PARSE_EXPECTED_TYPE: "E0104",
  PARSE_EXPECTED_PATTERN: "E0105",
  PARSE_INVALID_ASSIGN_TARGET: "E0106",
  PARSE_EXPECTED_DECL: "E0107",

  // Type Checker (E0201 - E0299)
  TYPE_MISMATCH: "E0201",
  TYPE_UNDEFINED_VAR: "E0202",
  TYPE_UNDEFINED_TYPE: "E0203",
  TYPE_UNDEFINED_FN: "E0204",
  TYPE_ARITY_MISMATCH: "E0205",
  TYPE_IMMUTABLE_ASSIGN: "E0206",
  TYPE_UNKNOWN_FIELD: "E0207",
  TYPE_MISSING_FIELD: "E0208",
  TYPE_DUPLICATE_FIELD: "E0209",
  TYPE_UNKNOWN_VARIANT: "E0210",
  TYPE_NOT_INDEXABLE: "E0211",
  TYPE_INDEX_NOT_INT: "E0212",
  TYPE_NOT_CALLABLE: "E0213",
  TYPE_INVALID_CAST: "E0214",
  TYPE_GENERIC_ARITY: "E0215",
  TYPE_CANNOT_INFER: "E0216",
  TYPE_RETURN_MISMATCH: "E0217",
  TYPE_MISSING_RETURN: "E0218",
  TYPE_BREAK_OUTSIDE_LOOP: "E0219",
  TYPE_DUPLICATE_SYMBOL: "E0220",
  TYPE_CONDITION_NOT_BOOL: "E0221",
  TYPE_BINARY_OP_MISMATCH: "E0222",
  TYPE_UNARY_OP_MISMATCH: "E0223",

  // Pattern Matching & Exhaustiveness (E0301 - E0399)
  MATCH_NON_EXHAUSTIVE: "E0301",
  MATCH_REDUNDANT_ARM: "E0302",
  MATCH_PATTERN_ARITY: "E0303",

  // Modules & Imports (E0401 - E0499)
  MOD_NOT_FOUND: "E0401",
  MOD_SYMBOL_NOT_FOUND: "E0402",
  MOD_CIRCULAR_IMPORT: "E0403",
  MOD_PRIVATE_SYMBOL: "E0404",
});

export function createSpan(
  file = "<input>",
  startLine = 1,
  startCol = 1,
  endLine = startLine,
  endCol = startCol,
  startOffset = 0,
  endOffset = 0
) {
  return {
    file,
    startLine,
    startCol,
    endLine,
    endCol,
    startOffset,
    endOffset,
  };
}

export function mergeSpans(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    file: a.file || b.file,
    startLine: a.startLine,
    startCol: a.startCol,
    endLine: b.endLine,
    endCol: b.endCol,
    startOffset: a.startOffset,
    endOffset: b.endOffset,
  };
}

export function createDiagnostic({
  code,
  severity = "error",
  message,
  span,
  sourceLine = "",
  suggestion = null,
}) {
  return {
    code: code || "E0000",
    severity,
    message,
    span: span || createSpan(),
    sourceLine: sourceLine || "",
    suggestion: suggestion || null,
  };
}

// ============================================================================
// 2. Semantic Types (`Type`)
//   NOTE: Structs, arrays, and strings are REFERENCE types (`gc_ref`).
// ============================================================================

let nextTypeVarId = 1;
export function resetTypeVarCounter() {
  nextTypeVarId = 1;
}

export const Types = {
  I32: Object.freeze({ tag: "prim", name: "i32" }),
  I64: Object.freeze({ tag: "prim", name: "i64" }),
  F64: Object.freeze({ tag: "prim", name: "f64" }),
  BOOL: Object.freeze({ tag: "prim", name: "bool" }),
  STRING: Object.freeze({ tag: "prim", name: "string" }),
  VOID: Object.freeze({ tag: "prim", name: "void" }),
  ERROR: Object.freeze({ tag: "error" }),

  array(elem) {
    return { tag: "array", elem };
  },
  struct(name, typeArgs = [], fields = [], defTypeParams = []) {
    return { tag: "struct", name, typeArgs, fields, defTypeParams };
  },
  enum(name, typeArgs = [], variants = [], defTypeParams = []) {
    return { tag: "enum", name, typeArgs, variants, defTypeParams };
  },
  fn(params, ret, typeParams = []) {
    return { tag: "fn", params, ret, typeParams };
  },
  typevar(name = null) {
    return { tag: "typevar", id: nextTypeVarId++, name, bound: null };
  },
  typeparam(name) {
    return { tag: "typeparam", name };
  },
};

export function unwrapType(t) {
  let cur = t;
  while (cur && cur.tag === "typevar" && cur.bound) {
    cur = cur.bound;
  }
  return cur || Types.VOID;
}

export function typeToString(t) {
  const ty = unwrapType(t);
  if (!ty) return "void";
  switch (ty.tag) {
    case "prim":
      return ty.name;
    case "array":
      return `[${typeToString(ty.elem)}]`;
    case "struct":
    case "enum":
      if (ty.typeArgs && ty.typeArgs.length > 0) {
        return `${ty.name}<${ty.typeArgs.map(typeToString).join(", ")}>`;
      }
      return ty.name;
    case "fn": {
      const tp =
        ty.typeParams && ty.typeParams.length > 0
          ? `<${ty.typeParams.join(", ")}>`
          : "";
      return `fn${tp}(${ty.params.map(typeToString).join(", ")}) -> ${typeToString(ty.ret)}`;
    }
    case "typeparam":
      return ty.name;
    case "typevar":
      return ty.name ? `?${ty.name}` : `?T${ty.id}`;
    case "error":
      return "<error>";
    default:
      return String(ty.tag);
  }
}

export function typesEqual(a, b) {
  const ta = unwrapType(a);
  const tb = unwrapType(b);
  if (ta === tb) return true;
  if (!ta || !tb) return false;
  if (ta.tag === "error" || tb.tag === "error") return true;
  if (ta.tag !== tb.tag) return false;
  switch (ta.tag) {
    case "prim":
      return ta.name === tb.name;
    case "array":
      return typesEqual(ta.elem, tb.elem);
    case "struct":
    case "enum":
      if (ta.name !== tb.name) return false;
      if ((ta.typeArgs?.length || 0) !== (tb.typeArgs?.length || 0)) return false;
      for (let i = 0; i < (ta.typeArgs?.length || 0); i++) {
        if (!typesEqual(ta.typeArgs[i], tb.typeArgs[i])) return false;
      }
      return true;
    case "fn":
      if (ta.params.length !== tb.params.length) return false;
      for (let i = 0; i < ta.params.length; i++) {
        if (!typesEqual(ta.params[i], tb.params[i])) return false;
      }
      return typesEqual(ta.ret, tb.ret);
    case "typeparam":
      return ta.name === tb.name;
    case "typevar":
      return ta.id === tb.id;
    default:
      return false;
  }
}

export function isGcManagedType(t) {
  const ty = unwrapType(t);
  if (!ty) return false;
  if (ty.tag === "prim") return ty.name === "string";
  return (
    ty.tag === "array" ||
    ty.tag === "struct" ||
    ty.tag === "enum" ||
    ty.tag === "fn"
  );
}

export function semanticTypeToLirType(t) {
  const ty = unwrapType(t);
  if (!ty) return "void";
  if (ty.tag === "prim") {
    switch (ty.name) {
      case "i32":
      case "bool":
        return "i32";
      case "i64":
        return "i64";
      case "f64":
        return "f64";
      case "string":
        return "gc_ref";
      case "void":
        return "void";
    }
  }
  if (
    ty.tag === "array" ||
    ty.tag === "struct" ||
    ty.tag === "enum" ||
    ty.tag === "fn"
  ) {
    return "gc_ref";
  }
  return "i32";
}

export function mangleTypeName(t) {
  const ty = unwrapType(t);
  if (!ty) return "void";
  switch (ty.tag) {
    case "prim":
      return ty.name;
    case "array":
      return `Arr_${mangleTypeName(ty.elem)}`;
    case "struct":
    case "enum":
      if (ty.typeArgs && ty.typeArgs.length > 0) {
        return `${ty.name}$${ty.typeArgs.map(mangleTypeName).join("$")}`;
      }
      return ty.name;
    case "fn":
      return `Fn_${ty.params.map(mangleTypeName).join("_")}_to_${mangleTypeName(ty.ret)}`;
    case "typeparam":
      return ty.name;
    default:
      return "any";
  }
}

// ============================================================================
// 3. Shared Runtime Semantics Helpers (Interpreter & Wasm Host Must Share!)
// ============================================================================

export class LumenRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "LumenRuntimeError";
    this.lumenMessage = message;
  }
   format() {
    return `runtime error: ${this.lumenMessage}`;
  }
}

/**
 * Shared float-to-string formatter used by BOTH the Reference Interpreter and the Wasm host import.
 */
export function formatFloat64(val) {
  const n = Number(val);
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  if (Object.is(n, -0)) return "-0";
  return String(n);
}

/**
 * Saturating conversion from f64 to i32 (matches Wasm `i32.trunc_sat_f64_s` = 0xfc 0x00).
 */
export function truncSatF64ToI32(val) {
  const n = Number(val);
  if (Number.isNaN(n)) return 0;
  if (n >= 2147483647.0) return 2147483647;
  if (n <= -2147483648.0) return -2147483648;
  return Math.trunc(n) | 0;
}

/**
 * Saturating conversion from f64 to i64 (matches Wasm `i64.trunc_sat_f64_s` = 0xfc 0x02).
 */
export function truncSatF64ToI64(val) {
  const n = Number(val);
  if (Number.isNaN(n)) return 0n;
  if (n >= 9223372036854775807.0) return 9223372036854775807n;
  if (n <= -9223372036854775808.0) return -9223372036854775808n;
  return BigInt(Math.trunc(n));
}

/**
 * Checked 32-bit signed division (traps on / 0 and INT_MIN / -1).
 */
export function checkedDivI32(a, b) {
  const ia = a | 0;
  const ib = b | 0;
  if (ib === 0) throw new LumenRuntimeError("division by zero");
  if (ia === -2147483648 && ib === -1) {
    throw new LumenRuntimeError("integer overflow");
  }
  return (ia / ib) | 0;
}

/**
 * Checked 32-bit signed remainder (traps on % 0; INT_MIN % -1 is 0).
 */
export function checkedRemI32(a, b) {
  const ia = a | 0;
  const ib = b | 0;
  if (ib === 0) throw new LumenRuntimeError("division by zero");
  if (ia === -2147483648 && ib === -1) return 0;
  return ia % ib | 0;
}

/**
 * Checked 64-bit signed division (traps on / 0n and INT64_MIN / -1n).
 */
export function checkedDivI64(a, b) {
  const ia = BigInt.asIntN(64, BigInt(a));
  const ib = BigInt.asIntN(64, BigInt(b));
  if (ib === 0n) throw new LumenRuntimeError("division by zero");
  if (ia === -9223372036854775808n && ib === -1n) {
    throw new LumenRuntimeError("integer overflow");
  }
  return BigInt.asIntN(64, ia / ib);
}

/**
 * Checked 64-bit signed remainder (traps on % 0n; INT64_MIN % -1n is 0n).
 */
export function checkedRemI64(a, b) {
  const ia = BigInt.asIntN(64, BigInt(a));
  const ib = BigInt.asIntN(64, BigInt(b));
  if (ib === 0n) throw new LumenRuntimeError("division by zero");
  if (ia === -9223372036854775808n && ib === -1n) return 0n;
  return BigInt.asIntN(64, ia % ib);
}

/**
 * FNV-1a 32-bit hash over UTF-8 bytes (used by both Interpreter and Wasm `str_hash` and `hash<T>`).
 */
export function fnv1aHashBytes(bytes) {
  let h = 2166136261 | 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] & 0xff;
    h = Math.imul(h, 16777619) | 0;
  }
  return h | 0;
}

export function fnv1aCombineI32(h, val) {
  let hash = h | 0;
  let v = val | 0;
  for (let i = 0; i < 4; i++) {
    hash ^= v & 0xff;
    hash = Math.imul(hash, 16777619) | 0;
    v >>>= 8;
  }
  return hash | 0;
}

// ============================================================================
// 4. Dynamic Wasm Linear Memory & Garbage Collector Constants
//    All offsets (mem_load, mem_store, pointerOffsets) are measured from
//    the object start (header = offset 0).
// ============================================================================

export function alignUp(value, alignment = 16) {
  return (value + (alignment - 1)) & ~(alignment - 1);
}

/**
 * Dynamically compute the Wasm linear memory layout from the actual static data size.
 * The mark worklist (64 KB) is strictly separate from the shadow stack (256 KB).
 */
export function computeMemoryLayout({
  staticStringsSize = 0,
  typeTableSize = 0,
  globalRootsCount = 0,
} = {}) {
  const nullGuardEnd = 0x00100; // 256B null-trap guard & scratch area
  const staticStringStart = nullGuardEnd;
  const typeTableStart = alignUp(staticStringStart + Math.max(16, staticStringsSize), 16);
  const globalRootsStart = alignUp(typeTableStart + Math.max(32, typeTableSize), 16);
  const globalRootsSize = Math.max(16, (globalRootsCount + 1) * 4);
  const gcWorklistStart = alignUp(globalRootsStart + globalRootsSize, 16);
  const gcWorklistSize = 0x10000; // 64 KB dedicated mark worklist
  const gcWorklistEnd = gcWorklistStart + gcWorklistSize;
  const shadowStackStart = alignUp(gcWorklistEnd, 16);
  const shadowStackSize = 0x40000; // 256 KB shadow stack (65,536 root slots)
  const shadowStackEnd = shadowStackStart + shadowStackSize;
  const heapStart = alignUp(shadowStackEnd, 16);
  const minBytes = heapStart + 0x100000; // at least 1 MB initial heap room
  const initialPages = Math.max(16, Math.ceil(minBytes / 65536));

  return Object.freeze({
    NULL_GUARD_END: nullGuardEnd,
    STATIC_STRING_START: staticStringStart,
    TYPE_TABLE_START: typeTableStart,
    GLOBAL_ROOTS_START: globalRootsStart,
    GLOBAL_ROOTS_COUNT: globalRootsCount,
    GC_WORKLIST_START: gcWorklistStart,
    GC_WORKLIST_END: gcWorklistEnd,
    SHADOW_STACK_START: shadowStackStart,
    SHADOW_STACK_END: shadowStackEnd,
    HEAP_START: heapStart,
    INITIAL_PAGES: initialPages,
    MAX_PAGES: 1024, // 64 MB max
  });
}

export const MEM_LAYOUT = computeMemoryLayout();

export const GC_HEADER_SIZE = 8;

export const GC_FLAGS = Object.freeze({
  NONE: 0,
  MARK: 1,       // Bit 0: reachable during GC mark phase
  FREE: 2,       // Bit 1: currently on a free list
  PINNED: 4,     // Bit 2: static / immortal object (e.g., string literal in static pool)
  PTR_ELEMS: 8,  // Bit 3: for ARRAY/RAW_BUFFER objects, indicates elements are `gc_ref` pointers
});

/**
 * Canonical Object Layouts (all offsets measured from object start `header = offset 0`):
 * - Header: +0..+7  ([gc_flags: u8, obj_kind: u8, type_desc_id: u16, payload_size: u32])
 * - STRING (1):     +8 = byte_len (u32), +12.. = UTF-8 bytes
 * - ARRAY (2):      +8 = length (u32), +12 = capacity (u32), +16 = data_ptr (gc_ref), +20 = elem_size (u32)
 * - STRUCT (3):     field i at +(8 + 8 * i)
 * - ENUM (4):       variant_tag (i32) at +8 (pad +12..+15), variant field i at +(16 + 8 * i)
 * - CLOSURE_ENV (5):captured variable i at +(8 + 8 * i)
 * - BOX (6):        boxed value at +8
 * - CLOSURE (7):    fn_table_idx (i32) at +8, env_ptr (gc_ref) at +12
 * - RAW_BUFFER (8): +8 = length (u32), +12 = elem_size (u32), elements at +(16 + elem_size * i)
 */
export const OBJ_KIND = Object.freeze({
  STRING: 1,
  ARRAY: 2,
  STRUCT: 3,
  ENUM: 4,
  CLOSURE_ENV: 5,
  BOX: 6,
  CLOSURE: 7,
  RAW_BUFFER: 8,
});

// ============================================================================
// 5. Built-in Function Names (Including generic `eq<T>` and `hash<T>`)
// ============================================================================

export const BUILTIN_NAMES = new Set([
  "print",
  "println",
  "int_to_string",
  "i64_to_string",
  "float_to_string",
  "bool_to_string",
  "int_to_float",
  "float_to_int",
  "i32_to_i64",
  "i64_to_i32",
  "str_len",
  "str_concat",
  "str_slice",
  "str_char_at",
  "str_from_char_code",
  "str_eq",
  "str_hash",
  "str_to_int",
  "array_len",
  "array_push",
  "array_pop",
  "array_new",
  "eq",
  "hash",
  "sqrt",
  "sin",
  "cos",
  "abs_f64",
  "abs_i32",
  "floor",
  "ceil",
  "pow",
  "gc_collect",
  "gc_live_bytes",
  "gc_total_allocated",
  "gc_collection_count",
  "clock_ms",
  "assert",
  "panic",
]);

// ============================================================================
// 6. AST & LIR Validation (`validateLir`)
// ============================================================================

export const VALID_LIR_STMT_OPS = new Set([
  "local_set",
  "global_set",
  "mem_store",
  "if",
  "loop",
  "block",
  "br",
  "br_if",
  "return",
  "expr",
  "debug_loc",
  "trap",
]);

export const VALID_LIR_EXPR_OPS = new Set([
  "const_i32",
  "const_i64",
  "const_f64",
  "const_string",
  "local_get",
  "global_get",
  "binop",
  "unop",
  "conv",
  "call",
  "call_indirect",
  "call_builtin",
  "mem_load",
  "gc_alloc",
  "seq",
  "if_expr",
]);

export function assertValidProgramAst(ast) {
  if (!ast || ast.kind !== "Program" || !Array.isArray(ast.decls)) {
    throw new Error(`Invalid Program AST: expected kind="Program" with decls array`);
  }
  return true;
}

/**
 * Returns true if evaluating `expr` can trigger a function call or heap allocation.
 */
export function exprMayAllocOrCall(expr) {
  if (!expr || typeof expr !== "object") return false;
  switch (expr.op) {
    case "call":
    case "call_indirect":
    case "call_builtin":
    case "gc_alloc":
      return true;
    case "binop":
      return exprMayAllocOrCall(expr.left) || exprMayAllocOrCall(expr.right);
    case "unop":
    case "conv":
      return exprMayAllocOrCall(expr.operand);
    case "mem_load":
      return exprMayAllocOrCall(expr.ptr);
    case "seq":
      return (
        (expr.stmts || []).some(stmtMayAllocOrCall) ||
        exprMayAllocOrCall(expr.result)
      );
    case "if_expr":
      return (
        exprMayAllocOrCall(expr.cond) ||
        (expr.thenStmts || []).some(stmtMayAllocOrCall) ||
        exprMayAllocOrCall(expr.thenExpr) ||
        (expr.elseStmts || []).some(stmtMayAllocOrCall) ||
        exprMayAllocOrCall(expr.elseExpr)
      );
    default:
      return false;
  }
}

export function stmtMayAllocOrCall(stmt) {
  if (!stmt || typeof stmt !== "object") return false;
  switch (stmt.op) {
    case "local_set":
    case "global_set":
      return exprMayAllocOrCall(stmt.value);
    case "mem_store":
      return exprMayAllocOrCall(stmt.ptr) || exprMayAllocOrCall(stmt.value);
    case "if":
      return (
        exprMayAllocOrCall(stmt.cond) ||
        (stmt.thenBody || []).some(stmtMayAllocOrCall) ||
        (stmt.elseBody || []).some(stmtMayAllocOrCall)
      );
    case "loop":
    case "block":
      return (stmt.body || []).some(stmtMayAllocOrCall);
    case "br_if":
      return exprMayAllocOrCall(stmt.cond);
    case "return":
      return stmt.value ? exprMayAllocOrCall(stmt.value) : false;
    case "expr":
      return exprMayAllocOrCall(stmt.expr);
    default:
      return false;
  }
}

/**
 * Returns true if `expr` is already safely rooted in a local or global (or static constant),
 * meaning it does not produce a fresh unrooted `gc_ref` on the Wasm operand stack, OR is a `seq`
 * whose result is a rooted local/global.
 */
function isRootedGcExpr(expr) {
  if (!expr) return true;
  if (expr.type !== "gc_ref") return true;
  if (
    expr.op === "local_get" ||
    expr.op === "global_get" ||
    expr.op === "const_string" ||
    expr.op === "const_i32"
  ) {
    return true;
  }
  if (expr.op === "seq") {
    return isRootedGcExpr(expr.result);
  }
  return false;
}

/**
 * Strictly validates an LIR Module:
 * 1. Rejects any unknown statement or expression `op` name (e.g. catches `" call_builtin"`).
 * 2. Verifies all `mem_load`, `mem_store`, and `pointerOffsets` are >= 8 (measured from header = offset 0).
 * 3. Verifies Rule 10: No unrooted `gc_ref` value sits on the Wasm operand stack across a call or allocation.
 */
export function validateLir(lirModule) {
  if (
    !lirModule ||
    !Array.isArray(lirModule.functions) ||
    !Array.isArray(lirModule.typeDescriptors)
  ) {
    throw new Error(
      `Invalid LIR Module: expected functions and typeDescriptors arrays`
    );
  }

  for (const td of lirModule.typeDescriptors) {
    if (!Array.isArray(td.pointerOffsets)) {
      throw new Error(
        `Invalid LIR TypeDescriptor '${td.name}': pointerOffsets must be an array`
      );
    }
    for (const off of td.pointerOffsets) {
      if (typeof off !== "number" || off < GC_HEADER_SIZE) {
        throw new Error(
          `Invalid LIR TypeDescriptor '${td.name}': pointer offset ${off} must be >= ${GC_HEADER_SIZE} (measured from header = offset 0)`
        );
      }
    }
  }

  function checkExprListForStackGcSafety(exprs, fnName, contextDesc) {
    // If exprs[j] (for j > i) can allocate or call, then exprs[i] (if type === "gc_ref")
    // MUST be a rooted expression (local_get / global_get / const_string), NOT an unrooted call/gc_alloc on the operand stack!
    for (let i = 0; i < exprs.length; i++) {
      const e = exprs[i];
      if (e && e.type === "gc_ref" && !isRootedGcExpr(e)) {
        for (let j = i + 1; j < exprs.length; j++) {
          if (exprMayAllocOrCall(exprs[j])) {
            throw new Error(
              `LIR GC Stack Safety Violation in '${fnName}' (${contextDesc}): unrooted gc_ref expression (op='${e.op}') sits on operand stack across subsequent allocating/calling operand (op='${exprs[j].op}')`
            );
          }
        }
      }
    }
  }

  function visitExpr(expr, fnName) {
    if (!expr || typeof expr !== "object") {
      throw new Error(`Invalid LIR expression in '${fnName}': ${ JSON.stringify(expr) }`);
    }
    if (!VALID_LIR_EXPR_OPS.has(expr.op)) {
      throw new Error(
        `Invalid LIR expression op '${expr.op}' in function '${fnName}'`
      );
    }
    switch (expr.op) {
      case "const_i32":
      case "const_i64":
      case "const_f64":
      case "const_string":
      case "local_get":
      case "global_get":
        break;
      case "binop":
        visitExpr(expr.left, fnName);
        visitExpr(expr.right, fnName);
        checkExprListForStackGcSafety([expr.left, expr.right], fnName, `binop ${expr.kind}`);
        break;
      case "unop":
      case "conv":
        visitExpr(expr.operand, fnName);
        break;
      case "call":
        for (const a of expr.args || []) visitExpr(a, fnName);
        checkExprListForStackGcSafety(expr.args || [], fnName, `call ${expr.funcName}`);
        break;
      case "call_indirect": {
        const all = [...(expr.args || []), expr.envPtr, expr.fnTableIndex].filter(Boolean);
        for (const a of all) visitExpr(a, fnName);
        checkExprListForStackGcSafety(all, fnName, `call_indirect`);
        break;
      }
      case "call_builtin":
        for (const a of expr.args || []) visitExpr(a, fnName);
        checkExprListForStackGcSafety(
          expr.args || [],
          fnName,
          `call_builtin ${expr.builtin}`
        );
        break;
      case "mem_load":
        if (typeof expr.offset !== "number" || expr.offset < GC_HEADER_SIZE) {
          throw new Error(
            `Invalid mem_load offset ${expr.offset} in '${fnName}': must be >= ${GC_HEADER_SIZE} (header = offset 0)`
          );
        }
        visitExpr(expr.ptr, fnName);
        break;
      case "gc_alloc":
        visitExpr(expr.payloadSize, fnName);
        break;
      case "seq":
        for (const s of expr.stmts || []) visitStmt(s, fnName);
        visitExpr(expr.result, fnName);
        break;
      case "if_expr":
        visitExpr(expr.cond, fnName);
        for (const s of expr.thenStmts || []) visitStmt(s, fnName);
        visitExpr(expr.thenExpr, fnName);
        for (const s of expr.elseStmts || []) visitStmt(s, fnName);
        visitExpr(expr.elseExpr, fnName);
        break;
    }
  }

  function visitStmt(stmt, fnName) {
    if (!stmt || typeof stmt !== "object") {
      throw new Error(`Invalid LIR statement in '${fnName}': ${JSON.stringify(stmt)}`);
    }
    if (!VALID_LIR_STMT_OPS.has(stmt.op)) {
      throw new Error(
        `Invalid LIR statement op '${stmt.op}' in function '${fnName}'`
      );
    }
    switch (stmt.op) {
      case "local_set":
      case "global_set":
        visitExpr(stmt.value, fnName);
        break;
      case "mem_store":
        if (typeof stmt.offset !== "number" || stmt.offset < GC_HEADER_SIZE) {
          throw new Error(
            `Invalid mem_store offset ${stmt.offset} in '${fnName}': must be >= ${GC_HEADER_SIZE} (header = offset 0)`
          );
        }
        visitExpr(stmt.ptr, fnName);
        visitExpr(stmt.value, fnName);
        checkExprListForStackGcSafety(
          [stmt.ptr, stmt.value],
          fnName,
          `mem_store at +${stmt.offset}`
        );
        break;
      case "if":
        visitExpr(stmt.cond, fnName);
        for (const s of stmt.thenBody || []) visitStmt(s, fnName);
        for (const s of stmt.elseBody || []) visitStmt(s, fnName);
        break;
      case "loop":
      case "block":
        for (const s of stmt.body || []) visitStmt(s, fnName);
        break;
      case "br":
      case "debug_loc":
      case "trap":
        break;
      case "br_if":
        visitExpr(stmt.cond, fnName);
        break;
      case "return":
        if (stmt.value) visitExpr(stmt.value, fnName);
        break;
      case "expr":
        visitExpr(stmt.expr, fnName);
        break;
    }
  }

  for (const fn of lirModule.functions) {
    for (const stmt of fn.body || []) {
      visitStmt(stmt, fn.name);
    }
  }

  return true;
}

export const assertValidLirModule = validateLir;
