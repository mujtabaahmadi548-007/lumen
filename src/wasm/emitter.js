/**
 * Lumen Raw WebAssembly Binary Emitter (`src/wasm/emitter.js`)
 * Owned exclusively by Agent D.
 * Compiles validated LIR (`LirModule`) directly to WebAssembly binary bytecode (`.wasm`)
 * with zero external dependencies.
 */

import {
  computeMemoryLayout,
  alignUp,
  GC_HEADER_SIZE,
  GC_FLAGS,
  OBJ_KIND,
} from "../contracts/index.js";
import { ByteBuffer, stringToUtf8 } from "./leb128.js";
import {
  WasmValType,
  ExportKind,
  WasmOp,
  lirTypeToWasmValType,
} from "./opcodes.js";
import {
  buildTypeSection,
  buildImportSection,
  buildFunctionSection,
  buildTableSection,
  buildMemorySection,
  buildGlobalSection,
  buildExportSection,
  buildElementSection,
  buildCodeSection,
  buildDataSection,
  assembleWasmModule,
} from "./sections.js";

/**
 * Encode a pinned static string object in canonical Lumen layout:
 * - +0..+7:  8-byte GC header `[gc_flags=PINNED(4), obj_kind=STRING(1), type_desc_id=0, payload_size=align8(4 + utf8.length)]`
 * - +8..+11: `byte_len : u32` (`utf8.length`)
 * - +12..:   UTF-8 bytes (zero-padded to 8-byte alignment)
 *
 * @param {string} str
 * @returns {{ bytes: Uint8Array, byteLen: number, payloadSize: number }}
 */
export function encodeStaticStringObject(str) {
  const utf8 = stringToUtf8(str);
  const byteLen = utf8.length;
  const payloadSize = alignUp(4 + byteLen, 8);
  const totalSize = GC_HEADER_SIZE + payloadSize;
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);

  bytes[0] = GC_FLAGS.PINNED;
  bytes[1] = OBJ_KIND.STRING;
  view.setUint16(2, 0, true); // type_desc_id = 0
  view.setUint32(4, payloadSize, true); // payload_size
  view.setUint32(8, byteLen, true); // byte_len at +8
  bytes.set(utf8, 12); // UTF-8 bytes at +12

  return { bytes, byteLen, payloadSize };
}

/**
 * Emit a raw WebAssembly binary module from an LIR module.
 *
 * @param {object} lirModule
 * @param {object} [options]
 * @param {boolean} [options.debug=false]
 * @param {boolean} [options.gcStress=false]
 * @returns {{ wasmBytes: Uint8Array, debugInfo: object, memoryLayout: object }}
 */
export function emitWasm(lirModule, options = {}) {
  const debug = Boolean(options.debug);

  // -------------------------------------------------------------------------
  // 1. Collect & Intern Static Strings (from LIR module + any inline literals)
  // -------------------------------------------------------------------------
  const idToString = new Map();
  const valueToId = new Map();
  let nextSyntheticStringId = 0;

  function registerStringEntry(id, value) {
    const strVal = String(value ?? "");
    const numId = typeof id === "number" ? id : nextSyntheticStringId;
    if (numId >= nextSyntheticStringId) {
      nextSyntheticStringId = numId + 1;
    }
    idToString.set(numId, strVal);
    if (!valueToId.has(strVal)) {
      valueToId.set(strVal, numId);
    }
    return numId;
  }

  function internStringValue(value) {
    const strVal = String(value ?? "");
    if (valueToId.has(strVal)) {
      return valueToId.get(strVal);
    }
    return registerStringEntry(nextSyntheticStringId++, strVal);
  }

  const rawStringList =
    lirModule.stringLiterals ||
    lirModule.stringPool ||
    lirModule.strings ||
    [];

  for (let i = 0; i < rawStringList.length; i++) {
    const entry = rawStringList[i];
    if (typeof entry === "string") {
      registerStringEntry(i, entry);
    } else if (entry && typeof entry === "object") {
      const id = entry.id ?? entry.stringId ?? i;
      const val = entry.value ?? entry.text ?? "";
      registerStringEntry(id, val);
    }
  }

  // Always intern empty string and built-in runtime error messages
  const emptyStrId = internStringValue("");
  const divZeroStrId = internStringValue("division by zero");
  const overflowStrId = internStringValue("integer overflow");
  const assertFailStrId = internStringValue("assertion failed");

  // Pre-scan all statements/expressions for inline string literals or trap messages
  function scanExprStrings(expr) {
    if (!expr || typeof expr !== "object") return;
    switch (expr.op) {
      case "const_string":
        if (typeof expr.value === "string") {
          if (typeof expr.stringId === "number") {
            registerStringEntry(expr.stringId, expr.value);
          } else if (typeof expr.id === "number") {
            registerStringEntry(expr.id, expr.value);
          } else {
            internStringValue(expr.value);
          }
        }
        break;
      case "binop":
        scanExprStrings(expr.left);
        scanExprStrings(expr.right);
        break;
      case "unop":
      case "conv":
        scanExprStrings(expr.operand);
        break;
      case "call":
      case "call_builtin":
        for (const a of expr.args || []) scanExprStrings(a);
        break;
      case "call_indirect":
        for (const a of expr.args || []) scanExprStrings(a);
        scanExprStrings(expr.envPtr);
        scanExprStrings(expr.fnTableIndex);
        break;
      case "mem_load":
        scanExprStrings(expr.ptr);
        break;
      case "gc_alloc":
        scanExprStrings(expr.payloadSize);
        break;
      case "seq":
        for (const s of expr.stmts || []) scanStmtStrings(s);
        scanExprStrings(expr.result);
        break;
      case "if_expr":
        scanExprStrings(expr.cond);
        for (const s of expr.thenStmts || []) scanStmtStrings(s);
        scanExprStrings(expr.thenExpr);
        for (const s of expr.elseStmts || []) scanStmtStrings(s);
        scanExprStrings(expr.elseExpr);
        break;
    }
  }

  function scanStmtStrings(stmt) {
    if (!stmt || typeof stmt !== "object") return;
    switch (stmt.op) {
      case "local_set":
      case "global_set":
        scanExprStrings(stmt.value);
        break;
      case "mem_store":
        scanExprStrings(stmt.ptr);
        scanExprStrings(stmt.value);
        break;
      case "if":
        scanExprStrings(stmt.cond);
        for (const s of stmt.thenBody || []) scanStmtStrings(s);
        for (const s of stmt.elseBody || []) scanStmtStrings(s);
        break;
      case "loop":
      case "block":
        for (const s of stmt.body || []) scanStmtStrings(s);
        break;
      case "br_if":
        scanExprStrings(stmt.cond);
        break;
      case "return":
        if (stmt.value) scanExprStrings(stmt.value);
        break;
      case "expr":
        scanExprStrings(stmt.expr);
        break;
      case "trap":
        internStringValue(stmt.message || "unreachable");
        break;
    }
  }

  for (const fn of lirModule.functions || []) {
    for (const stmt of fn.body || []) {
      scanStmtStrings(stmt);
    }
  }

  // Build static string data blob & pointer map
  const baseLayout = computeMemoryLayout();
  const staticStringStart = baseLayout.STATIC_STRING_START;
  const stringIdToPtr = new Map();
  const stringValueToPtr = new Map();
  const debugStringMap = {};

  const staticStringBuffer = new ByteBuffer(256);
  for (const [id, strVal] of idToString.entries()) {
    // Align each static string object to 8 bytes
    while (staticStringBuffer.length % 8 !== 0) {
      staticStringBuffer.writeByte(0);
    }
    const ptr = staticStringStart + staticStringBuffer.length;
    const encoded = encodeStaticStringObject(strVal);
    staticStringBuffer.writeBytes(encoded.bytes);
    stringIdToPtr.set(id, ptr);
    if (!stringValueToPtr.has(strVal)) {
      stringValueToPtr.set(strVal, ptr);
    }
    debugStringMap[id] = {
      id,
      ptr,
      value: strVal,
      byteLen: encoded.byteLen,
    };
  }

  const staticStringBytes = staticStringBuffer.toUint8Array();
  const globalRootsCount = Array.isArray(lirModule.globals)
    ? lirModule.globals.filter((g) => g.type === "gc_ref").length
    : 0;

  // Compute dynamic memory layout from actual static data size (Rule 13)
  const memoryLayout = computeMemoryLayout({
    staticStringsSize: staticStringBytes.length,
    typeTableSize: 0,
    globalRootsCount,
  });

  function resolveStringPtr(exprOrId) {
    if (typeof exprOrId === "number") {
      return stringIdToPtr.get(exprOrId) ?? stringIdToPtr.get(emptyStrId);
    }
    if (typeof exprOrId === "string") {
      return stringValueToPtr.get(exprOrId) ?? stringIdToPtr.get(emptyStrId);
    }
    if (exprOrId && typeof exprOrId === "object") {
      if (
        typeof exprOrId.stringId === "number" &&
        stringIdToPtr.has(exprOrId.stringId)
      ) {
        return stringIdToPtr.get(exprOrId.stringId);
      }
      if (typeof exprOrId.id === "number" && stringIdToPtr.has(exprOrId.id)) {
        return stringIdToPtr.get(exprOrId.id);
      }
      if (
        typeof exprOrId.value === "string" &&
        stringValueToPtr.has(exprOrId.value)
      ) {
        return stringValueToPtr.get(exprOrId.value);
      }
    }
    return stringIdToPtr.get(emptyStrId);
  }

  // -------------------------------------------------------------------------
  // 2. Type Section & Host Imports
  // -------------------------------------------------------------------------
  const funcTypes = [];
  const funcTypeKeyToIndex = new Map();

  function getOrAddFuncType(paramTypes, resultTypes) {
    const key = `${paramTypes.join(",")}->${resultTypes.join(",")}`;
    if (funcTypeKeyToIndex.has(key)) {
      return funcTypeKeyToIndex.get(key);
    }
    const idx = funcTypes.length;
    funcTypes.push({ params: paramTypes, results: resultTypes });
    funcTypeKeyToIndex.set(key, idx);
    return idx;
  }

  const imports = [];
  function addHostImport(name, paramTypes, resultTypes) {
    const typeIndex = getOrAddFuncType(paramTypes, resultTypes);
    const funcIndex = imports.length;
    imports.push({
      module: "env",
      name,
      kind: ExportKind.FUNC,
      typeIndex,
    });
    return funcIndex;
  }

  const impPrintStr = addHostImport("__lumen_print_str", [WasmValType.I32], []);
  const impPrintlnStr = addHostImport("__lumen_println_str", [WasmValType.I32], []);
  const impPrintI32 = addHostImport("__lumen_print_i32", [WasmValType.I32], []);
  const impPrintlnI32 = addHostImport("__lumen_println_i32", [WasmValType.I32], []);
  const impI32ToStr = addHostImport(
    "__lumen_i32_to_str",
    [WasmValType.I32],
    [WasmValType.I32]
  );
  const impI64ToStr = addHostImport(
    "__lumen_i64_to_str",
    [WasmValType.I64],
    [WasmValType.I32]
  );
  const impF64ToStr = addHostImport(
    "__lumen_f64_to_str",
    [WasmValType.F64],
    [WasmValType.I32]
  );
  const impBoolToStr = addHostImport(
    "__lumen_bool_to_str",
    [WasmValType.I32],
    [WasmValType.I32]
  );
  const impStrConcat = addHostImport(
    "__lumen_str_concat",
    [WasmValType.I32, WasmValType.I32],
    [WasmValType.I32]
  );
  const impStrSlice = addHostImport(
    "__lumen_str_slice",
    [WasmValType.I32, WasmValType.I32, WasmValType.I32],
    [WasmValType.I32]
  );
  const impStrCharAt = addHostImport(
    "__lumen_str_char_at",
    [WasmValType.I32, WasmValType.I32],
    [WasmValType.I32]
  );
  const impStrFromCharCode = addHostImport(
    "__lumen_str_from_char_code",
    [WasmValType.I32],
    [WasmValType.I32]
  );
  const impStrEq = addHostImport(
    "__lumen_str_eq",
    [WasmValType.I32, WasmValType.I32],
    [WasmValType.I32]
  );
  const impStrCmp = addHostImport(
    "__lumen_str_cmp",
    [WasmValType.I32, WasmValType.I32],
    [WasmValType.I32]
  );
  const impStrHash = addHostImport(
    "__lumen_str_hash",
    [WasmValType.I32],
    [WasmValType.I32]
  );
  const impStrToInt = addHostImport(
    "__lumen_str_to_int",
    [WasmValType.I32],
    [WasmValType.I32]
  );
  const impF64Sin = addHostImport(
    "__lumen_f64_sin",
    [WasmValType.F64],
    [WasmValType.F64]
  );
  const impF64Cos = addHostImport(
    "__lumen_f64_cos",
    [WasmValType.F64],
    [WasmValType.F64]
  );
  const impF64Pow = addHostImport(
    "__lumen_f64_pow",
    [WasmValType.F64, WasmValType.F64],
    [WasmValType.F64]
  );
  const impF64Rem = addHostImport(
    "__lumen_f64_rem",
    [WasmValType.F64, WasmValType.F64],
    [WasmValType.F64]
  );
  const impClockMs = addHostImport("__lumen_clock_ms", [], [WasmValType.F64]);
  const impAssertFail = addHostImport(
    "__lumen_assert_fail",
    [WasmValType.I32],
    []
  );
  const impTrap = addHostImport("__lumen_trap", [WasmValType.I32], []);
  const impAlloc = addHostImport(
    "__lumen_alloc",
    [WasmValType.I32, WasmValType.I32, WasmValType.I32],
    [WasmValType.I32]
  );
  const impGrowArray = addHostImport(
    "__lumen_grow_array",
    [WasmValType.I32, WasmValType.I32],
    [WasmValType.I32]
  );

  let impDebugStep = -1;
  if (debug) {
    impDebugStep = addHostImport(
      "__lumen_debug_step",
      [WasmValType.I32, WasmValType.I32, WasmValType.I32, WasmValType.I32],
      []
    );
  }

  const numImportedFuncs = imports.length;

  // -------------------------------------------------------------------------
  // 3. Globals Section (`__heap_top`, `__shadow_sp`, plus any LIR globals)
  // -------------------------------------------------------------------------
  const wasmGlobals = [];
  const globalNameToIndex = new Map();

  function addGlobal(name, valType, mutable, initExprBytes) {
    const idx = wasmGlobals.length;
    wasmGlobals.push({
      name,
      valType,
      mutable,
      initBytes: initExprBytes,
    });
    globalNameToIndex.set(name, idx);
    return idx;
  }

  const heapTopInit = new ByteBuffer(8)
    .writeByte(WasmOp.i32_const)
    .writeS32(memoryLayout.HEAP_START)
    .toUint8Array();
  const globalHeapTopIdx = addGlobal(
    "__heap_top",
    WasmValType.I32,
    true,
    heapTopInit
  );

  const shadowSpInit = new ByteBuffer(8)
    .writeByte(WasmOp.i32_const)
    .writeS32(memoryLayout.SHADOW_STACK_START)
    .toUint8Array();
  const globalShadowSpIdx = addGlobal(
    "__shadow_sp",
    WasmValType.I32,
    true,
    shadowSpInit
  );

  for (const g of lirModule.globals || []) {
    const valType = lirTypeToWasmValType(g.type || "i32");
    const initBuf = new ByteBuffer(12);
    if (valType === WasmValType.I64) {
      initBuf.writeByte(WasmOp.i64_const).writeS64(g.initValue ?? 0n);
    } else if (valType === WasmValType.F64) {
      initBuf.writeByte(WasmOp.f64_const).writeF64(g.initValue ?? 0.0);
    } else {
      initBuf.writeByte(WasmOp.i32_const).writeS32(g.initValue ?? 0);
    }
    addGlobal(g.name, valType, true, initBuf.toUint8Array());
  }

  // -------------------------------------------------------------------------
  // 4. Register User Functions & Signatures
  // -------------------------------------------------------------------------
  const functions = lirModule.functions || [];
  const funcNameToWasmIndex = new Map();
  const definedFuncTypeIndices = [];
  const exportsList = [
    { name: "memory", kind: ExportKind.MEM, index: 0 },
    { name: "__heap_top", kind: ExportKind.GLOBAL, index: globalHeapTopIdx },
    { name: "__shadow_sp", kind: ExportKind.GLOBAL, index: globalShadowSpIdx },
  ];

  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i];
    const wasmFuncIdx = numImportedFuncs + i;
    funcNameToWasmIndex.set(fn.name, wasmFuncIdx);

    const paramValTypes = (fn.params || []).map((p) =>
      lirTypeToWasmValType(p.type || "i32")
    );
    const retLirType = fn.returnType || fn.retType || "void";
    const resultValTypes =
      retLirType === "void" ? [] : [lirTypeToWasmValType(retLirType)];

    const typeIdx = getOrAddFuncType(paramValTypes, resultValTypes);
    definedFuncTypeIndices.push(typeIdx);

    if (fn.name === "main" || fn.isExported !== false) {
      exportsList.push({
        name: fn.name,
        kind: ExportKind.FUNC,
        index: wasmFuncIdx,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 5. Compile Function Bodies & Populate Debug Info
  // -------------------------------------------------------------------------
  const codeBodies = [];
  const debugFunctions = {};
  const functionNameMap = {};

  for (let fnIdx = 0; fnIdx < functions.length; fnIdx++) {
    const fn = functions[fnIdx];
    const fnId = typeof fn.id === "number" ? fn.id : fnIdx;
    const retLirType = fn.returnType || fn.retType || "void";

    // Map LIR local IDs / names to Wasm local indices
    const localIdToWasmIdx = new Map();
    const localNameToWasmIdx = new Map();
    const localIdToLirType = new Map();
    const nonParamLocalValTypes = [];
    const debugLocals = [];

    const params = fn.params || [];
    for (let pIdx = 0; pIdx < params.length; pIdx++) {
      const p = params[pIdx];
      const lid = p.id ?? p.localId ?? pIdx;
      const pType = p.type || "i32";
      localIdToWasmIdx.set(lid, pIdx);
      localIdToLirType.set(lid, pType);
      if (p.name) {
        localNameToWasmIdx.set(p.name, pIdx);
      }
      debugLocals.push({
        name: p.name || `param_${pIdx}`,
        localId: lid,
        wasmLocalIdx: pIdx,
        type: pType,
        isParam: true,
        shadowSlotIndex: -1,
      });
    }

    function allocateLocal(lid, name, lirType) {
      if (lid !== undefined && localIdToWasmIdx.has(lid)) {
        return localIdToWasmIdx.get(lid);
      }
      const wasmIdx = params.length + nonParamLocalValTypes.length;
      const lType = (!lirType || lirType === "void") ? "i32" : lirType;
      nonParamLocalValTypes.push(lirTypeToWasmValType(lType));
      if (lid !== undefined) {
        localIdToWasmIdx.set(lid, wasmIdx);
        localIdToLirType.set(lid, lType);
      }
      if (name) {
        localNameToWasmIdx.set(name, wasmIdx);
      }
      debugLocals.push({
        name: name || `local_${wasmIdx}`,
        localId: lid ?? wasmIdx,
        wasmLocalIdx: wasmIdx,
        type: lType,
        isParam: false,
        shadowSlotIndex: -1,
      });
      return wasmIdx;
    }

    for (let lIdx = 0; lIdx < (fn.locals || []).length; lIdx++) {
      const loc = fn.locals[lIdx];
      if (loc.isParam) continue;
      const lid = loc.id ?? loc.localId ?? params.length + lIdx;
      if (localIdToWasmIdx.has(lid)) continue;
      allocateLocal(lid, loc.name, loc.type || "i32");
    }

    // Pre-scan body for any local_get/local_set not explicitly declared in fn.locals
    function prescanLocalsInExpr(expr) {
      if (!expr || typeof expr !== "object") return;
      switch (expr.op) {
        case "local_get": {
          const lid = expr.localId ?? expr.id;
          if (lid !== undefined && !localIdToWasmIdx.has(lid)) {
            allocateLocal(lid, expr.name, expr.type || "i32");
          }
          break;
        }
        case "binop":
          prescanLocalsInExpr(expr.left);
          prescanLocalsInExpr(expr.right);
          break;
        case "unop":
        case "conv":
          prescanLocalsInExpr(expr.operand);
          break;
        case "call":
        case "call_builtin":
          for (const a of expr.args || []) prescanLocalsInExpr(a);
          break;
        case "call_indirect":
          for (const a of expr.args || []) prescanLocalsInExpr(a);
          prescanLocalsInExpr(expr.envPtr);
          prescanLocalsInExpr(expr.fnTableIndex);
          break;
        case "mem_load":
          prescanLocalsInExpr(expr.ptr);
          break;
        case "gc_alloc":
          prescanLocalsInExpr(expr.payloadSize);
          break;
        case "seq":
          for (const s of expr.stmts || []) prescanLocalsInStmt(s);
          prescanLocalsInExpr(expr.result);
          break;
        case "if_expr":
          prescanLocalsInExpr(expr.cond);
          for (const s of expr.thenStmts || []) prescanLocalsInStmt(s);
          prescanLocalsInExpr(expr.thenExpr);
          for (const s of expr.elseStmts || []) prescanLocalsInStmt(s);
          prescanLocalsInExpr(expr.elseExpr);
          break;
      }
    }

    function prescanLocalsInStmt(stmt) {
      if (!stmt || typeof stmt !== "object") return;
      switch (stmt.op) {
        case "local_set": {
          const lid = stmt.localId ?? stmt.id;
          if (lid !== undefined && !localIdToWasmIdx.has(lid)) {
            allocateLocal(lid, stmt.name, stmt.value?.type || "i32");
          }
          prescanLocalsInExpr(stmt.value);
          break;
        }
        case "global_set":
          prescanLocalsInExpr(stmt.value);
          break;
        case "mem_store":
          prescanLocalsInExpr(stmt.ptr);
          prescanLocalsInExpr(stmt.value);
          break;
        case "if":
          prescanLocalsInExpr(stmt.cond);
          for (const s of stmt.thenBody || []) prescanLocalsInStmt(s);
          for (const s of stmt.elseBody || []) prescanLocalsInStmt(s);
          break;
        case "loop":
        case "block":
          for (const s of stmt.body || []) prescanLocalsInStmt(s);
          break;
        case "br_if":
          prescanLocalsInExpr(stmt.cond);
          break;
        case "return":
          if (stmt.value) prescanLocalsInExpr(stmt.value);
          break;
        case "expr":
          prescanLocalsInExpr(stmt.expr);
          break;
      }
    }

    for (const stmt of fn.body || []) {
      prescanLocalsInStmt(stmt);
    }

    // Reusable scratch local pool per LIR type (safe across arbitrary nested expressions)
    const scratchPoolByType = new Map();
    let scratchCounter = 0;

    function acquireScratchLocal(lirType) {
      const pool = scratchPoolByType.get(lirType);
      if (pool && pool.length > 0) {
        return pool.pop();
      }
      const id = `__scratch_${scratchCounter++}`;
      return allocateLocal(id, id, lirType);
    }

    function releaseScratchLocal(lirType, wasmIdx) {
      let pool = scratchPoolByType.get(lirType);
      if (!pool) {
        pool = [];
        scratchPoolByType.set(lirType, pool);
      }
      pool.push(wasmIdx);
    }

    function resolveLocalIdx(ref) {
      if (typeof ref === "number" && localIdToWasmIdx.has(ref)) {
        return localIdToWasmIdx.get(ref);
      }
      if (typeof ref === "string" && localNameToWasmIdx.has(ref)) {
        return localNameToWasmIdx.get(ref);
      }
      if (ref && typeof ref === "object") {
        const lid = ref.localId ?? ref.id;
        if (lid !== undefined && localIdToWasmIdx.has(lid)) {
          return localIdToWasmIdx.get(lid);
        }
        if (ref.name && localNameToWasmIdx.has(ref.name)) {
          return localNameToWasmIdx.get(ref.name);
        }
      }
      return 0;
    }

    const bodyBuf = new ByteBuffer(256);
    // Wasm structured control flow stack: EVERY `block`, `loop`, and `if` pushes an entry!
    const labelStack = [];

    function resolveBranchDepth(label) {
      for (let i = labelStack.length - 1; i >= 0; i--) {
        if (labelStack[i] === label) {
          return labelStack.length - 1 - i;
        }
      }
      throw new Error(
        `Unknown branch label '${label}' in function '${fn.name}'`
      );
    }

    function emitTrapWithStrId(strId) {
      const msgPtr = stringIdToPtr.get(strId);
      bodyBuf.writeByte(WasmOp.i32_const).writeS32(msgPtr);
      bodyBuf.writeByte(WasmOp.call).writeU32(impTrap);
      bodyBuf.writeByte(WasmOp.unreachable);
    }

    function emitExpr(expr) {
      if (!expr) return;
      switch (expr.op) {
        case "const_i32":
          bodyBuf.writeByte(WasmOp.i32_const).writeS32(expr.value | 0);
          break;

        case "const_i64":
          bodyBuf.writeByte(WasmOp.i64_const).writeS64(expr.value ?? 0n);
          break;

        case "const_f64":
          bodyBuf.writeByte(WasmOp.f64_const).writeF64(Number(expr.value || 0));
          break;

        case "const_string": {
          const ptr = resolveStringPtr(expr);
          bodyBuf.writeByte(WasmOp.i32_const).writeS32(ptr);
          break;
        }

        case "local_get": {
          const idx = resolveLocalIdx(expr);
          bodyBuf.writeByte(WasmOp.local_get).writeU32(idx);
          break;
        }

        case "global_get": {
          const gIdx = globalNameToIndex.get(expr.name) ?? 0;
          bodyBuf.writeByte(WasmOp.global_get).writeU32(gIdx);
          break;
        }

        case "binop": {
          const kind = expr.kind || expr.opKind || "";
          const operandType = expr.left?.type || expr.type || "i32";

          // Short-circuit logical AND / OR
          if (kind === "&&" || kind === "logical_and") {
            emitExpr(expr.left);
            bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.I32);
            labelStack.push(null);
            emitExpr(expr.right);
            bodyBuf.writeByte(WasmOp.else);
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(0);
            labelStack.pop();
            bodyBuf.writeByte(WasmOp.end);
            break;
          }
          if (kind === "||" || kind === "logical_or") {
            emitExpr(expr.left);
            bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.I32);
            labelStack.push(null);
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(1);
            bodyBuf.writeByte(WasmOp.else);
            emitExpr(expr.right);
            labelStack.pop();
            bodyBuf.writeByte(WasmOp.end);
            break;
          }

          // String concatenation, equality, and lexicographical comparisons
          if (
            operandType === "gc_ref" &&
            (expr.type === "gc_ref" || kind === "str_concat") &&
            (kind === "+" || kind === "add" || kind === "str_concat")
          ) {
            emitExpr(expr.left);
            emitExpr(expr.right);
            bodyBuf.writeByte(WasmOp.call).writeU32(impStrConcat);
            break;
          }
          if (
            operandType === "gc_ref" &&
            (kind === "==" || kind === "eq" || kind === "eq_str" || kind === "!=" || kind === "ne" || kind === "ne_str")
          ) {
            emitExpr(expr.left);
            emitExpr(expr.right);
            bodyBuf.writeByte(WasmOp.call).writeU32(impStrEq);
            if (kind === "!=" || kind === "ne" || kind === "ne_str") {
              bodyBuf.writeByte(WasmOp.i32_eqz);
            }
            break;
          }
          if (
            operandType === "gc_ref" &&
            (kind === "<" || kind === "lt" || kind === "lt_s" ||
             kind === "<=" || kind === "le" || kind === "le_s" ||
             kind === ">" || kind === "gt" || kind === "gt_s" ||
             kind === ">=" || kind === "ge" || kind === "ge_s")
          ) {
            emitExpr(expr.left);
            emitExpr(expr.right);
            bodyBuf.writeByte(WasmOp.call).writeU32(impStrCmp);
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(0);
            if (kind === "<" || kind === "lt" || kind === "lt_s") {
              bodyBuf.writeByte(WasmOp.i32_lt_s);
            } else if (kind === "<=" || kind === "le" || kind === "le_s") {
              bodyBuf.writeByte(WasmOp.i32_le_s);
            } else if (kind === ">" || kind === "gt" || kind === "gt_s") {
              bodyBuf.writeByte(WasmOp.i32_gt_s);
            } else {
              bodyBuf.writeByte(WasmOp.i32_ge_s);
            }
            break;
          }

          // f64 modulo via host helper (Wasm has no native f64.rem opcode)
          if (
            operandType === "f64" &&
            (kind === "%" || kind === "rem" || kind === "rem_s" || kind === "rem_f64")
          ) {
            emitExpr(expr.left);
            emitExpr(expr.right);
            bodyBuf.writeByte(WasmOp.call).writeU32(impF64Rem);
            break;
          }

          // Checked i32 division (Rule 4: trap on / 0 and INT_MIN / -1)
          if (
            (kind === "/" || kind === "div" || kind === "div_s" || kind === "div_i32") &&
            operandType === "i32"
          ) {
            emitExpr(expr.left);
            emitExpr(expr.right);
            const lhsLocal = acquireScratchLocal("i32");
            const rhsLocal = acquireScratchLocal("i32");
            bodyBuf.writeByte(WasmOp.local_tee).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i32_eqz);
            bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.VOID);
            labelStack.push(null);
            emitTrapWithStrId(divZeroStrId);
            labelStack.pop();
            bodyBuf.writeByte(WasmOp.end);

            bodyBuf.writeByte(WasmOp.local_set).writeU32(lhsLocal);

            // Check INT_MIN / -1 -> trap "integer overflow"
            bodyBuf.writeByte(WasmOp.local_get).writeU32(lhsLocal);
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(-2147483648);
            bodyBuf.writeByte(WasmOp.i32_eq);
            bodyBuf.writeByte(WasmOp.local_get).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(-1);
            bodyBuf.writeByte(WasmOp.i32_eq);
            bodyBuf.writeByte(WasmOp.i32_and);
            bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.VOID);
            labelStack.push(null);
            emitTrapWithStrId(overflowStrId);
            labelStack.pop();
            bodyBuf.writeByte(WasmOp.end);

            bodyBuf.writeByte(WasmOp.local_get).writeU32(lhsLocal);
            bodyBuf.writeByte(WasmOp.local_get).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i32_div_s);
            releaseScratchLocal("i32", rhsLocal);
            releaseScratchLocal("i32", lhsLocal);
            break;
          }

          // Checked i32 remainder (Rule 4: trap on % 0; INT_MIN % -1 evaluates to 0 without trapping)
          if (
            (kind === "%" || kind === "rem" || kind === "rem_s" || kind === "rem_i32") &&
            operandType === "i32"
          ) {
            emitExpr(expr.left);
            emitExpr(expr.right);
            const lhsLocal = acquireScratchLocal("i32");
            const rhsLocal = acquireScratchLocal("i32");
            bodyBuf.writeByte(WasmOp.local_tee).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i32_eqz);
            bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.VOID);
            labelStack.push(null);
            emitTrapWithStrId(divZeroStrId);
            labelStack.pop();
            bodyBuf.writeByte(WasmOp.end);

            bodyBuf.writeByte(WasmOp.local_set).writeU32(lhsLocal);

            // If rhs == -1, result is 0 (handles INT_MIN % -1 cleanly without trap)
            bodyBuf.writeByte(WasmOp.local_get).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(-1);
            bodyBuf.writeByte(WasmOp.i32_eq);
            bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.I32);
            labelStack.push(null);
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(0);
            bodyBuf.writeByte(WasmOp.else);
            bodyBuf.writeByte(WasmOp.local_get).writeU32(lhsLocal);
            bodyBuf.writeByte(WasmOp.local_get).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i32_rem_s);
            labelStack.pop();
            bodyBuf.writeByte(WasmOp.end);

            releaseScratchLocal("i32", rhsLocal);
            releaseScratchLocal("i32", lhsLocal);
            break;
          }

          // Checked i64 division (Rule 4: trap on / 0n and INT64_MIN / -1n)
          if (
            (kind === "/" || kind === "div" || kind === "div_s" || kind === "div_i64") &&
            operandType === "i64"
          ) {
            emitExpr(expr.left);
            emitExpr(expr.right);
            const lhsLocal = acquireScratchLocal("i64");
            const rhsLocal = acquireScratchLocal("i64");
            bodyBuf.writeByte(WasmOp.local_tee).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i64_eqz);
            bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.VOID);
            labelStack.push(null);
            emitTrapWithStrId(divZeroStrId);
            labelStack.pop();
            bodyBuf.writeByte(WasmOp.end);

            bodyBuf.writeByte(WasmOp.local_set).writeU32(lhsLocal);

            // Check INT64_MIN / -1n -> trap "integer overflow"
            bodyBuf.writeByte(WasmOp.local_get).writeU32(lhsLocal);
            bodyBuf.writeByte(WasmOp.i64_const).writeS64(-9223372036854775808n);
            bodyBuf.writeByte(WasmOp.i64_eq);
            bodyBuf.writeByte(WasmOp.local_get).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i64_const).writeS64(-1n);
            bodyBuf.writeByte(WasmOp.i64_eq);
            bodyBuf.writeByte(WasmOp.i32_and);
            bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.VOID);
            labelStack.push(null);
            emitTrapWithStrId(overflowStrId);
            labelStack.pop();
            bodyBuf.writeByte(WasmOp.end);

            bodyBuf.writeByte(WasmOp.local_get).writeU32(lhsLocal);
            bodyBuf.writeByte(WasmOp.local_get).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i64_div_s);
            releaseScratchLocal("i64", rhsLocal);
            releaseScratchLocal("i64", lhsLocal);
            break;
          }

          // Checked i64 remainder (Rule 4: trap on % 0n; INT64_MIN % -1n evaluates to 0n)
          if (
            (kind === "%" || kind === "rem" || kind === "rem_s" || kind === "rem_i64") &&
            operandType === "i64"
          ) {
            emitExpr(expr.left);
            emitExpr(expr.right);
            const lhsLocal = acquireScratchLocal("i64");
            const rhsLocal = acquireScratchLocal("i64");
            bodyBuf.writeByte(WasmOp.local_tee).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i64_eqz);
            bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.VOID);
            labelStack.push(null);
            emitTrapWithStrId(divZeroStrId);
            labelStack.pop();
            bodyBuf.writeByte(WasmOp.end);

            bodyBuf.writeByte(WasmOp.local_set).writeU32(lhsLocal);

            // If rhs == -1n, result is 0n
            bodyBuf.writeByte(WasmOp.local_get).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i64_const).writeS64(-1n);
            bodyBuf.writeByte(WasmOp.i64_eq);
            bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.I64);
            labelStack.push(null);
            bodyBuf.writeByte(WasmOp.i64_const).writeS64(0n);
            bodyBuf.writeByte(WasmOp.else);
            bodyBuf.writeByte(WasmOp.local_get).writeU32(lhsLocal);
            bodyBuf.writeByte(WasmOp.local_get).writeU32(rhsLocal);
            bodyBuf.writeByte(WasmOp.i64_rem_s);
            labelStack.pop();
            bodyBuf.writeByte(WasmOp.end);

            releaseScratchLocal("i64", rhsLocal);
            releaseScratchLocal("i64", lhsLocal);
            break;
          }

          // Standard binary operations
          emitExpr(expr.left);
          emitExpr(expr.right);
          // If i64 shift has an i32 right operand, extend it to i64 so Wasm validation succeeds
          if (
            operandType === "i64" &&
            expr.right?.type === "i32" &&
            (kind === "<<" || kind === "shl" || kind === "shl_i64" ||
             kind === ">>" || kind === "shr" || kind === "shr_s" || kind === "shr_i64")
          ) {
            bodyBuf.writeByte(WasmOp.i64_extend_i32_u);
          }
          bodyBuf.writeByte(resolveBinopOpcode(kind, operandType));
          break;
        }

        case "unop": {
          const kind = expr.kind || expr.opKind || "";
          const opType = expr.operand?.type || expr.type || "i32";
          if (kind === "-" || kind === "neg" || kind === "neg_i32" || kind === "neg_i64" || kind === "neg_f64") {
            if (opType === "f64" || kind === "neg_f64") {
              emitExpr(expr.operand);
              bodyBuf.writeByte(WasmOp.f64_neg);
            } else if (opType === "i64" || kind === "neg_i64") {
              bodyBuf.writeByte(WasmOp.i64_const).writeS64(0n);
              emitExpr(expr.operand);
              bodyBuf.writeByte(WasmOp.i64_sub);
            } else {
              bodyBuf.writeByte(WasmOp.i32_const).writeS32(0);
              emitExpr(expr.operand);
              bodyBuf.writeByte(WasmOp.i32_sub);
            }
          } else if (kind === "!" || kind === "not" || kind === "eqz") {
            emitExpr(expr.operand);
            bodyBuf.writeByte(WasmOp.i32_eqz);
          } else if (kind === "~" || kind === "bitnot" || kind === "bitnot_i32" || kind === "bitnot_i64") {
            emitExpr(expr.operand);
            if (opType === "i64" || kind === "bitnot_i64") {
              bodyBuf.writeByte(WasmOp.i64_const).writeS64(-1n);
              bodyBuf.writeByte(WasmOp.i64_xor);
            } else {
              bodyBuf.writeByte(WasmOp.i32_const).writeS32(-1);
              bodyBuf.writeByte(WasmOp.i32_xor);
            }
          }
          break;
        }

        case "conv": {
          emitExpr(expr.operand);
          switch (expr.kind) {
            case "i32_to_i64":
            case "bool_to_i64":
              bodyBuf.writeByte(WasmOp.i64_extend_i32_s);
              break;
            case "i64_to_i32":
              bodyBuf.writeByte(WasmOp.i32_wrap_i64);
              break;
            case "i32_to_f64":
            case "bool_to_f64":
              bodyBuf.writeByte(WasmOp.f64_convert_i32_s);
              break;
            case "i64_to_f64":
              bodyBuf.writeByte(WasmOp.f64_convert_i64_s);
              break;
            case "f64_to_i32":
            case "f64_to_int":
              bodyBuf
                .writeByte(WasmOp.fc_prefix)
                .writeU32(WasmOp.i32_trunc_sat_f64_s);
              break;
            case "f64_to_i64":
              bodyBuf
                .writeByte(WasmOp.fc_prefix)
                .writeU32(WasmOp.i64_trunc_sat_f64_s);
              break;
            case "i32_to_bool":
              bodyBuf.writeByte(WasmOp.i32_const).writeS32(0);
              bodyBuf.writeByte(WasmOp.i32_ne);
              break;
            case "i32_to_i32":
            case "i64_to_i64":
            case "f64_to_f64":
            case "bool_to_i32":
            case "bool_to_bool":
              break;
            default:
              throw new Error(`Unknown LIR conv kind '${expr.kind}'`);
          }
          break;
        }

        case "call": {
          for (const arg of expr.args || []) {
            emitExpr(arg);
          }
          const targetIdx = funcNameToWasmIndex.get(expr.funcName);
          if (targetIdx === undefined) {
            throw new Error(
              `Unknown function '${expr.funcName}' called in '${fn.name}'`
            );
          }
          bodyBuf.writeByte(WasmOp.call).writeU32(targetIdx);
          break;
        }

        case "call_builtin": {
          emitBuiltinCall(expr);
          break;
        }

        case "mem_load": {
          emitExpr(expr.ptr);
          const loadType = expr.loadType || expr.type || "i32";
          const offset = expr.offset >>> 0;
          if (loadType === "i64") {
            bodyBuf.writeByte(WasmOp.i64_load).writeU32(3).writeU32(offset);
          } else if (loadType === "f64") {
            bodyBuf.writeByte(WasmOp.f64_load).writeU32(3).writeU32(offset);
          } else if (loadType === "u8") {
            bodyBuf.writeByte(WasmOp.i32_load8_u).writeU32(0).writeU32(offset);
          } else if (loadType === "i8") {
            bodyBuf.writeByte(WasmOp.i32_load8_s).writeU32(0).writeU32(offset);
          } else if (loadType === "u16") {
            bodyBuf.writeByte(WasmOp.i32_load16_u).writeU32(1).writeU32(offset);
          } else if (loadType === "i16") {
            bodyBuf.writeByte(WasmOp.i32_load16_s).writeU32(1).writeU32(offset);
          } else {
            bodyBuf.writeByte(WasmOp.i32_load).writeU32(2).writeU32(offset);
          }
          break;
        }

        case "gc_alloc": {
          bodyBuf.writeByte(WasmOp.i32_const).writeS32(expr.objKind | 0);
          bodyBuf.writeByte(WasmOp.i32_const).writeS32((expr.typeDescId || 0) | 0);
          emitExpr(expr.payloadSize);
          bodyBuf.writeByte(WasmOp.call).writeU32(impAlloc);
          break;
        }

        case "seq": {
          for (const s of expr.stmts || []) {
            emitStmt(s);
          }
          if (expr.type !== "void" && expr.result) {
            emitExpr(expr.result);
          } else if (expr.result && expr.result.type && expr.result.type !== "void") {
            emitExpr(expr.result);
            bodyBuf.writeByte(WasmOp.drop);
          }
          break;
        }

        case "if_expr": {
          emitExpr(expr.cond);
          const blockValType = lirTypeToWasmValType(expr.type || "void");
          bodyBuf.writeByte(WasmOp.if).writeByte(blockValType);
          labelStack.push(null);
          for (const s of expr.thenStmts || []) {
            emitStmt(s);
          }
          if (expr.thenExpr) {
            emitExpr(expr.thenExpr);
          }
          bodyBuf.writeByte(WasmOp.else);
          for (const s of expr.elseStmts || []) {
            emitStmt(s);
          }
          if (expr.elseExpr) {
            emitExpr(expr.elseExpr);
          }
          labelStack.pop();
          bodyBuf.writeByte(WasmOp.end);
          break;
        }

        default:
          throw new Error(
            `Unsupported LIR expression op '${expr.op}' in function '${fn.name}'`
          );
      }
    }

    function emitPrintSingleArg(arg, withNewline) {
      emitExpr(arg);
      const isBool =
        arg.isBool === true ||
        arg.semanticType === "bool" ||
        arg.type === "bool";
      if (isBool) {
        bodyBuf.writeByte(WasmOp.call).writeU32(impBoolToStr);
        bodyBuf
          .writeByte(WasmOp.call)
          .writeU32(withNewline ? impPrintlnStr : impPrintStr);
      } else if (arg.type === "i32") {
        bodyBuf
          .writeByte(WasmOp.call)
          .writeU32(withNewline ? impPrintlnI32 : impPrintI32);
      } else if (arg.type === "i64") {
        bodyBuf.writeByte(WasmOp.call).writeU32(impI64ToStr);
        bodyBuf
          .writeByte(WasmOp.call)
          .writeU32(withNewline ? impPrintlnStr : impPrintStr);
      } else if (arg.type === "f64") {
        bodyBuf.writeByte(WasmOp.call).writeU32(impF64ToStr);
        bodyBuf
          .writeByte(WasmOp.call)
          .writeU32(withNewline ? impPrintlnStr : impPrintStr);
      } else {
        bodyBuf
          .writeByte(WasmOp.call)
          .writeU32(withNewline ? impPrintlnStr : impPrintStr);
      }
    }

    function emitBuiltinCall(expr) {
      const b = expr.builtin;
      const args = expr.args || [];

      switch (b) {
        case "print": {
          for (let i = 0; i < args.length; i++) {
            emitPrintSingleArg(args[i], false);
          }
          break;
        }

        case "println": {
          if (args.length === 0) {
            bodyBuf
              .writeByte(WasmOp.i32_const)
              .writeS32(stringIdToPtr.get(emptyStrId));
            bodyBuf.writeByte(WasmOp.call).writeU32(impPrintlnStr);
            break;
          }
          for (let i = 0; i < args.length; i++) {
            emitPrintSingleArg(args[i], i === args.length - 1);
          }
          break;
        }

        case "int_to_string":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impI32ToStr);
          break;

        case "i64_to_string":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impI64ToStr);
          break;

        case "float_to_string":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impF64ToStr);
          break;

        case "bool_to_string":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impBoolToStr);
          break;

        case "int_to_float":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.f64_convert_i32_s);
          break;

        case "float_to_int":
          emitExpr(args[0]);
          bodyBuf
            .writeByte(WasmOp.fc_prefix)
            .writeU32(WasmOp.i32_trunc_sat_f64_s);
          break;

        case "i32_to_i64":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.i64_extend_i32_s);
          break;

        case "i64_to_i32":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.i32_wrap_i64);
          break;

        case "str_len":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.i32_load).writeU32(2).writeU32(8);
          break;

        case "str_concat":
          emitExpr(args[0]);
          emitExpr(args[1]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impStrConcat);
          break;

        case "str_slice":
          emitExpr(args[0]);
          emitExpr(args[1]);
          emitExpr(args[2]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impStrSlice);
          break;

        case "str_char_at":
          emitExpr(args[0]);
          emitExpr(args[1]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impStrCharAt);
          break;

        case "str_from_char_code":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impStrFromCharCode);
          break;

        case "str_eq":
          emitExpr(args[0]);
          emitExpr(args[1]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impStrEq);
          break;

        case "str_hash":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impStrHash);
          break;

        case "str_to_int":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impStrToInt);
          break;

        case "sqrt":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.f64_sqrt);
          break;

        case "sin":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impF64Sin);
          break;

        case "cos":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impF64Cos);
          break;

        case "pow":
          emitExpr(args[0]);
          emitExpr(args[1]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impF64Pow);
          break;

        case "abs_f64":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.f64_abs);
          break;

        case "abs_i32": {
          emitExpr(args[0]);
          const tmp = acquireScratchLocal("i32");
          bodyBuf.writeByte(WasmOp.local_tee).writeU32(tmp);
          bodyBuf.writeByte(WasmOp.i32_const).writeS32(0);
          bodyBuf.writeByte(WasmOp.i32_lt_s);
          bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.I32);
          labelStack.push(null);
          bodyBuf.writeByte(WasmOp.i32_const).writeS32(0);
          bodyBuf.writeByte(WasmOp.local_get).writeU32(tmp);
          bodyBuf.writeByte(WasmOp.i32_sub);
          bodyBuf.writeByte(WasmOp.else);
          bodyBuf.writeByte(WasmOp.local_get).writeU32(tmp);
          labelStack.pop();
          bodyBuf.writeByte(WasmOp.end);
          releaseScratchLocal("i32", tmp);
          break;
        }

        case "floor":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.f64_floor);
          break;

        case "ceil":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.f64_ceil);
          break;

        case "clock_ms":
          bodyBuf.writeByte(WasmOp.call).writeU32(impClockMs);
          break;

        case "panic":
          if (args.length > 0) {
            emitExpr(args[0]);
          } else {
            bodyBuf
              .writeByte(WasmOp.i32_const)
              .writeS32(stringIdToPtr.get(assertFailStrId));
          }
          bodyBuf.writeByte(WasmOp.call).writeU32(impTrap);
          bodyBuf.writeByte(WasmOp.unreachable);
          break;

        case "grow_array":
          emitExpr(args[0]);
          emitExpr(args[1]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impGrowArray);
          break;

        case "trap":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.call).writeU32(impTrap);
          bodyBuf.writeByte(WasmOp.unreachable);
          break;

        case "assert":
          emitExpr(args[0]);
          bodyBuf.writeByte(WasmOp.i32_eqz);
          bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.VOID);
          labelStack.push(null);
          if (args.length > 1) {
            emitExpr(args[1]);
          } else {
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(0);
          }
          bodyBuf.writeByte(WasmOp.call).writeU32(impAssertFail);
          bodyBuf.writeByte(WasmOp.unreachable);
          labelStack.pop();
          bodyBuf.writeByte(WasmOp.end);
          break;

        default:
          throw new Error(`Unsupported builtin '${b}' in emitter`);
      }
    }

    function emitStmt(stmt) {
      if (!stmt) return;
      switch (stmt.op) {
        case "local_set": {
          const idx = resolveLocalIdx(stmt);
          emitExpr(stmt.value);
          bodyBuf.writeByte(WasmOp.local_set).writeU32(idx);
          break;
        }

        case "global_set": {
          const gIdx = globalNameToIndex.get(stmt.name) ?? 0;
          emitExpr(stmt.value);
          bodyBuf.writeByte(WasmOp.global_set).writeU32(gIdx);
          break;
        }

        case "mem_store": {
          emitExpr(stmt.ptr);
          emitExpr(stmt.value);
          const storeType = stmt.storeType || stmt.value?.type || "i32";
          const offset = stmt.offset >>> 0;
          if (storeType === "i64") {
            bodyBuf.writeByte(WasmOp.i64_store).writeU32(3).writeU32(offset);
          } else if (storeType === "f64") {
            bodyBuf.writeByte(WasmOp.f64_store).writeU32(3).writeU32(offset);
          } else if (storeType === "u8" || storeType === "i8") {
            bodyBuf.writeByte(WasmOp.i32_store8).writeU32(0).writeU32(offset);
          } else if (storeType === "u16" || storeType === "i16") {
            bodyBuf.writeByte(WasmOp.i32_store16).writeU32(1).writeU32(offset);
          } else {
            bodyBuf.writeByte(WasmOp.i32_store).writeU32(2).writeU32(offset);
          }
          break;
        }

        case "if": {
          emitExpr(stmt.cond);
          bodyBuf.writeByte(WasmOp.if).writeByte(WasmValType.VOID);
          labelStack.push(null);
          for (const s of stmt.thenBody || []) {
            emitStmt(s);
          }
          if (stmt.elseBody && stmt.elseBody.length > 0) {
            bodyBuf.writeByte(WasmOp.else);
            for (const s of stmt.elseBody) {
              emitStmt(s);
            }
          }
          labelStack.pop();
          bodyBuf.writeByte(WasmOp.end);
          break;
        }

        case "loop": {
          bodyBuf.writeByte(WasmOp.loop).writeByte(WasmValType.VOID);
          labelStack.push(stmt.label);
          for (const s of stmt.body || []) {
            emitStmt(s);
          }
          labelStack.pop();
          bodyBuf.writeByte(WasmOp.end);
          break;
        }

        case "block": {
          bodyBuf.writeByte(WasmOp.block).writeByte(WasmValType.VOID);
          labelStack.push(stmt.label);
          for (const s of stmt.body || []) {
            emitStmt(s);
          }
          labelStack.pop();
          bodyBuf.writeByte(WasmOp.end);
          break;
        }

        case "br": {
          const depth = resolveBranchDepth(stmt.label);
          bodyBuf.writeByte(WasmOp.br).writeU32(depth);
          break;
        }

        case "br_if": {
          emitExpr(stmt.cond);
          const depth = resolveBranchDepth(stmt.label);
          bodyBuf.writeByte(WasmOp.br_if).writeU32(depth);
          break;
        }

        case "return": {
          if (
            stmt.value !== null &&
            stmt.value !== undefined &&
            retLirType !== "void"
          ) {
            emitExpr(stmt.value);
          }
          bodyBuf.writeByte(WasmOp.return);
          break;
        }

        case "expr": {
          emitExpr(stmt.expr);
          if (stmt.expr && stmt.expr.type && stmt.expr.type !== "void") {
            bodyBuf.writeByte(WasmOp.drop);
          }
          break;
        }

        case "debug_loc": {
          if (debug && impDebugStep >= 0) {
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(stmt.line | 0);
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(stmt.col | 0);
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(fnId | 0);
            bodyBuf.writeByte(WasmOp.i32_const).writeS32(0); // $shadow_fp = 0 in M1/M2
            bodyBuf.writeByte(WasmOp.call).writeU32(impDebugStep);
          }
          break;
        }

        case "trap": {
          const strId = internStringValue(stmt.message || "unreachable");
          const msgPtr = stringIdToPtr.get(strId);
          bodyBuf.writeByte(WasmOp.i32_const).writeS32(msgPtr);
          bodyBuf.writeByte(WasmOp.call).writeU32(impTrap);
          bodyBuf.writeByte(WasmOp.unreachable);
          break;
        }

        default:
          throw new Error(
            `Unsupported LIR statement op '${stmt.op}' in function '${fn.name}'`
          );
      }
    }

    for (const stmt of fn.body || []) {
      emitStmt(stmt);
    }

    // Ensure non-void functions have a fallback default return value at end of body so Wasm validator is satisfied
    if (retLirType !== "void") {
      const lastStmt =
        fn.body && fn.body.length > 0 ? fn.body[fn.body.length - 1] : null;
      if (!lastStmt || (lastStmt.op !== "return" && lastStmt.op !== "trap")) {
        if (retLirType === "i64") {
          bodyBuf.writeByte(WasmOp.i64_const).writeS64(0n);
        } else if (retLirType === "f64") {
          bodyBuf.writeByte(WasmOp.f64_const).writeF64(0.0);
        } else {
          bodyBuf.writeByte(WasmOp.i32_const).writeS32(0);
        }
      }
    }

    codeBodies.push({
      localTypes: nonParamLocalValTypes,
      bodyBytes: bodyBuf.toUint8Array(),
    });

    debugFunctions[fnId] = {
      id: fnId,
      name: fn.name,
      wasmFuncIndex: numImportedFuncs + fnIdx,
      returnType: retLirType,
      locals: debugLocals,
    };
    functionNameMap[fn.name] = fnId;
  }

  // -------------------------------------------------------------------------
  // 6. Assemble Sections into Final WebAssembly Binary
  // -------------------------------------------------------------------------
  const dataSegments = [];
  if (staticStringBytes.length > 0) {
    dataSegments.push({
      offset: memoryLayout.STATIC_STRING_START,
      bytes: staticStringBytes,
    });
  }

  const wasmBytes = assembleWasmModule([
    buildTypeSection(funcTypes),
    buildImportSection(imports),
    buildFunctionSection(definedFuncTypeIndices),
    buildTableSection(0),
    buildMemorySection(memoryLayout.INITIAL_PAGES, memoryLayout.MAX_PAGES),
    buildGlobalSection(wasmGlobals),
    buildExportSection(exportsList),
    buildElementSection([]),
    buildCodeSection(codeBodies),
    buildDataSection(dataSegments),
  ]);

  const debugInfo = {
    functions: debugFunctions,
    functionNameMap,
    strings: debugStringMap,
    memoryLayout,
  };

  return {
    wasmBytes,
    debugInfo,
    memoryLayout,
  };
}

/**
 * Map LIR binop kind + operand type to WebAssembly binary opcode.
 */
function resolveBinopOpcode(kind, operandType) {
  if (operandType === "f64") {
    switch (kind) {
      case "+":
      case "add":
      case "add_f64":
        return WasmOp.f64_add;
      case "-":
      case "sub":
      case "sub_f64":
        return WasmOp.f64_sub;
      case "*":
      case "mul":
      case "mul_f64":
        return WasmOp.f64_mul;
      case "/":
      case "div":
      case "div_s":
      case "div_f64":
        return WasmOp.f64_div;
      case "==":
      case "eq":
      case "eq_f64":
        return WasmOp.f64_eq;
      case "!=":
      case "ne":
      case "ne_f64":
        return WasmOp.f64_ne;
      case "<":
      case "lt":
      case "lt_s":
      case "lt_f64":
        return WasmOp.f64_lt;
      case "<=":
      case "le":
      case "le_s":
      case "le_f64":
        return WasmOp.f64_le;
      case ">":
      case "gt":
      case "gt_s":
      case "gt_f64":
        return WasmOp.f64_gt;
      case ">=":
      case "ge":
      case "ge_s":
      case "ge_f64":
        return WasmOp.f64_ge;
    }
  }

  if (operandType === "i64") {
    switch (kind) {
      case "+":
      case "add":
      case "add_i64":
        return WasmOp.i64_add;
      case "-":
      case "sub":
      case "sub_i64":
        return WasmOp.i64_sub;
      case "*":
      case "mul":
      case "mul_i64":
        return WasmOp.i64_mul;
      case "/":
      case "div":
      case "div_s":
      case "div_i64":
        return WasmOp.i64_div_s;
      case "%":
      case "rem":
      case "rem_s":
      case "rem_i64":
        return WasmOp.i64_rem_s;
      case "&":
      case "and":
      case "bitand":
      case "and_i64":
        return WasmOp.i64_and;
      case "|":
      case "or":
      case "bitor":
      case "or_i64":
        return WasmOp.i64_or;
      case "^":
      case "xor":
      case "bitxor":
      case "xor_i64":
        return WasmOp.i64_xor;
      case "<<":
      case "shl":
      case "shl_i64":
        return WasmOp.i64_shl;
      case ">>":
      case "shr":
      case "shr_s":
      case "shr_i64":
        return WasmOp.i64_shr_s;
      case "==":
      case "eq":
      case "eq_i64":
        return WasmOp.i64_eq;
      case "!=":
      case "ne":
      case "ne_i64":
        return WasmOp.i64_ne;
      case "<":
      case "lt":
      case "lt_s":
      case "lt_i64":
        return WasmOp.i64_lt_s;
      case "<=":
      case "le":
      case "le_s":
      case "le_i64":
        return WasmOp.i64_le_s;
      case ">":
      case "gt":
      case "gt_s":
      case "gt_i64":
        return WasmOp.i64_gt_s;
      case ">=":
      case "ge":
      case "ge_s":
      case "ge_i64":
        return WasmOp.i64_ge_s;
    }
  }

  // Default: i32 / bool / gc_ref
  switch (kind) {
    case "+":
    case "add":
    case "add_i32":
      return WasmOp.i32_add;
    case "-":
    case "sub":
    case "sub_i32":
      return WasmOp.i32_sub;
    case "*":
    case "mul":
    case "mul_i32":
      return WasmOp.i32_mul;
    case "/":
    case "div":
    case "div_s":
    case "div_i32":
      return WasmOp.i32_div_s;
    case "%":
    case "rem":
    case "rem_s":
    case "rem_i32":
      return WasmOp.i32_rem_s;
    case "&":
    case "and":
    case "bitand":
    case "and_i32":
      return WasmOp.i32_and;
    case "|":
    case "or":
    case "bitor":
    case "or_i32":
      return WasmOp.i32_or;
    case "^":
    case "xor":
    case "bitxor":
    case "xor_i32":
      return WasmOp.i32_xor;
    case "<<":
    case "shl":
    case "shl_i32":
      return WasmOp.i32_shl;
    case ">>":
    case "shr":
    case "shr_s":
    case "shr_i32":
      return WasmOp.i32_shr_s;
    case "==":
    case "eq":
    case "eq_i32":
      return WasmOp.i32_eq;
    case "!=":
    case "ne":
    case "ne_i32":
      return WasmOp.i32_ne;
    case "<":
    case "lt":
    case "lt_s":
    case "lt_i32":
      return WasmOp.i32_lt_s;
    case "<=":
    case "le":
    case "le_s":
    case "le_i32":
      return WasmOp.i32_le_s;
    case ">":
    case "gt":
    case "gt_s":
    case "gt_i32":
      return WasmOp.i32_gt_s;
    case ">=":
    case "ge":
    case "ge_s":
    case "ge_i32":
      return WasmOp.i32_ge_s;
    default:
      throw new Error(`Unknown LIR binop kind '${kind}' for type '${operandType}'`);
  }
}
