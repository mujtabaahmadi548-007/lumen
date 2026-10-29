/**
 * Lumen Reference Interpreter (`src/interp/interpreter.js`)
 * Owned exclusively by Agent E.
 *
 * Completely independent tree-walking semantics oracle for the Lumen AST.
 * Executes `Program` AST nodes directly with lexical scopes, closures, pattern matching,
 * algebraic data types, reference semantics for structs/arrays/strings, UTF-8 byte strings,
 * and exact Wasm-compatible i32/i64/f64 arithmetic.
 */

import {
  assertValidProgramAst,
  unwrapType,
  LumenRuntimeError,
  checkedDivI32,
  checkedRemI32,
  checkedDivI64,
  checkedRemI64,
  truncSatF64ToI32,
  truncSatF64ToI64,
  formatFloat64,
  fnv1aHashBytes,
} from "../contracts/index.js";
import {
  toI32,
  toI64,
  toF64,
  toBool,
  castToI32,
  castToI64,
  I32,
  I64,
  createArray,
  createStruct,
  createEnum,
  createClosure,
  createRange,
  toUtf8Bytes,
  fromUtf8Bytes,
  strByteLen,
  strSliceBytes,
  strCharAtByte,
  strConcatBytes,
  strEqualsBytes,
  strCompareBytes,
  formatInt,
  formatI64,
  formatBool,
  formatValue,
  valuesEqual,
  hashValue,
} from "./values.js";

// ============================================================================
// 1. Control Flow Signals
// ============================================================================

class ReturnSignal {
  constructor(value) {
    this.value = value;
  }
}

class BreakSignal {}

class ContinueSignal {}

// ============================================================================
// 2. Lexical Environment Scope
// ============================================================================

export class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.cells = new Map(); // name -> { value, mutable, typeTag }
  }

  define(name, value, mutable = false, typeTag = null) {
    // Rule 3: Structs, arrays, and strings are reference types (never cloned on assignment)
    this.cells.set(name, { value, mutable, typeTag });
  }

  resolveCell(name) {
    let cur = this;
    while (cur !== null) {
      if (cur.cells.has(name)) {
        return cur.cells.get(name);
      }
      cur = cur.parent;
    }
    return null;
  }

  has(name) {
    return this.resolveCell(name) !== null;
  }

  get(name) {
    const cell = this.resolveCell(name);
    if (!cell) {
      throw new LumenRuntimeError(`undefined variable '${name}'`);
    }
    return cell.value;
  }

  getTypeTag(name) {
    const cell = this.resolveCell(name);
    return cell ? cell.typeTag : null;
  }

  assign(name, value) {
    const cell = this.resolveCell(name);
    if (!cell) {
      throw new LumenRuntimeError(`assignment to undefined variable '${name}'`);
    }
    // Rule 3: Reference types are shared directly, never cloned
    cell.value = value;
  }
}

// ============================================================================
// 3. Interpreter Execution Context
// ============================================================================

const FLOAT_BUILTINS = new Set([
  "int_to_float",
  "sqrt",
  "sin",
  "cos",
  "abs_f64",
  "floor",
  "ceil",
  "pow",
  "clock_ms",
]);

function formatRuntimeErrorMessage(err) {
  if (err instanceof LumenRuntimeError) {
    return err.lumenMessage;
  }
  if (err instanceof RangeError && /call stack/i.test(err.message)) {
    return "stack overflow";
  }
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.startsWith("runtime error: ")
    ? msg.slice("runtime error: ".length)
    : msg;
}

export function interpret(programAst, options = {}) {
  try {
    assertValidProgramAst(programAst);
  } catch (err) {
    const message = formatRuntimeErrorMessage(err);
    return {
      stdout: "",
      errorText: `runtime error: ${message}`,
      returnValue: null,
      exitCode: 1,
    };
  }

  let stdout = "";
  const startTime = Date.now();
  const maxSteps = options.maxSteps || 50_000_000;
  const maxCallDepth = options.maxCallDepth || 2048;
  let steps = 0;
  let callDepth = 0;

  // Simulated GC counters for parity with GC built-in intrinsics
  const gcStats = {
    liveBytes: 0,
    totalAllocated: 0,
    collections: 0,
  };

  function recordAlloc(bytes) {
    const aligned = (bytes + 7) & ~7;
    gcStats.totalAllocated = (gcStats.totalAllocated + aligned) | 0;
    gcStats.liveBytes = (gcStats.liveBytes + aligned) | 0;
  }

  const globalScope = new Scope(null);
  const functions = new Map(); // name -> FnDecl
  const structs = new Map(); // name -> StructDecl
  const enums = new Map(); // enumName -> Map<variantName, { arity, tagIndex }>
  const variantToEnum = new Map(); // variantName -> { enumName, arity, tagIndex }
  const zeroArgVariants = new Set(); // variantName with 0 payload args

  function registerEnumVariant(enumName, variantName, arity, tagIndex = 0) {
    if (!enums.has(enumName)) {
      enums.set(enumName, new Map());
    }
    enums.get(enumName).set(variantName, { arity, tagIndex });
    variantToEnum.set(variantName, { enumName, arity, tagIndex });
    if (arity === 0) {
      zeroArgVariants.add(variantName);
      const val = createEnum(enumName, variantName, []);
      val.tagIndex = tagIndex;
      globalScope.define(variantName, val, false, enumName);
      globalScope.define(`${enumName}::${variantName}`, val, false, enumName);
    } else {
      const ctor = createClosure([], null, globalScope, {
        isVariantCtor: true,
        enumName,
        variantName,
        arity,
        tagIndex,
      });
      globalScope.define(variantName, ctor, false, "fn");
      globalScope.define(`${enumName}::${variantName}`, ctor, false, "fn");
    }
  }

  // Register built-in prelude Enums: Option<T> and Result<T, E>
  registerEnumVariant("Option", "Some", 1, 0);
  registerEnumVariant("Option", "None", 0, 1);
  registerEnumVariant("Result", "Ok", 1, 0);
  registerEnumVariant("Result", "Err", 1, 1);

  // Pass 1: Register all StructDecl, EnumDecl, FnDecl
  for (const decl of programAst.decls) {
    if (!decl) continue;
    if (decl.kind === "StructDecl") {
      structs.set(decl.name, decl);
    } else if (decl.kind === "EnumDecl") {
      const variants = decl.variants || [];
      for (let idx = 0; idx < variants.length; idx++) {
        const v = variants[idx];
        const payload = v.payload || v.fields || v.params || [];
        registerEnumVariant(decl.name, v.name, payload.length, idx);
      }
    } else if (decl.kind === "FnDecl") {
      functions.set(decl.name, decl);
      const fnVal = createClosure(
        (decl.params || []).map((p) => (typeof p === "string" ? p : p.name)),
        decl.body,
        globalScope,
        {
          fnDecl: decl,
          name: decl.name,
        }
      );
      globalScope.define(decl.name, fnVal, false, "fn");
    }
  }

  // Type-tag helpers for distinguishing f64 vs i32 when JS numbers are integers (e.g. 3.0)
  function getTypeNodeTag(typeNode) {
    if (!typeNode) return null;
    if (typeof typeNode === "string") return typeNode;
    if (typeNode.tag === "prim") return typeNode.name;
    if (typeNode.kind === "NamedType") return typeNode.name;
    return null;
  }

  function hasSemanticType(node, primName) {
    if (!node) return false;
    const t = unwrapType(node.inferredType || node.resolvedType);
    return Boolean(t && t.tag === "prim" && t.name === primName);
  }

  function isF64Expr(expr, scope) {
    if (!expr) return false;
    if (hasSemanticType(expr, "f64")) return true;
    if (
      hasSemanticType(expr, "i32") ||
      hasSemanticType(expr, "i64") ||
      hasSemanticType(expr, "bool") ||
      hasSemanticType(expr, "string")
    ) {
      return false;
    }

    switch (expr.kind) {
      case "LiteralExpr":
        return expr.literalType === "f64" || expr.literalType === "float";
      case "IdentExpr":
        return scope.getTypeTag(expr.name) === "f64";
      case "UnaryExpr":
        return isF64Expr(expr.operand || expr.argument, scope);
      case "BinaryExpr":
        return isF64Expr(expr.left, scope) || isF64Expr(expr.right, scope);
      case "CastExpr":
        return getTypeNodeTag(expr.targetType) === "f64";
      case "CallExpr": {
        if (expr.callee?.kind === "IdentExpr") {
          const fnName = expr.callee.name;
          if (FLOAT_BUILTINS.has(fnName)) return true;
          const fnDecl = functions.get(fnName);
          if (fnDecl && getTypeNodeTag(fnDecl.returnType) === "f64") return true;
        }
        return false;
      }
      case "IfExpr":
        return (
          isF64Expr(expr.thenBlock || expr.thenBranch, scope) ||
          isF64Expr(expr.elseBlock || expr.elseBranch, scope)
        );
      case "BlockStmt":
      case "BlockExpr": {
        const blk = expr.kind === "BlockExpr" ? expr.block : expr;
        return blk?.tailExpr ? isF64Expr(blk.tailExpr, scope) : false;
      }
      default:
        return false;
    }
  }

  // Built-in function dispatcher
  function callBuiltin(name, args) {
    switch (name) {
      case "print": {
        const text = args.map((a) => formatValue(a)).join("");
        stdout += text;
        return null;
      }
      case "println": {
        const text = args.map((a) => formatValue(a)).join("");
        stdout += text + "\n";
        return null;
      }
      case "int_to_string":
        return formatInt(args[0]);
      case "i64_to_string":
        return formatI64(args[0]);
      case "float_to_string":
        return formatFloat64(args[0]);
      case "bool_to_string":
        return formatBool(args[0]);
      case "int_to_float":
        return toF64(args[0]);
      case "float_to_int":
        return truncSatF64ToI32(args[0]);
      case "i32_to_i64":
        return BigInt(toI32(args[0]));
      case "i64_to_i32":
        return toI32(args[0]);
      case "str_len":
        return strByteLen(args[0]);
      case "str_concat": {
        const res = strConcatBytes(args[0] ?? "", args[1] ?? "");
        recordAlloc(12 + strByteLen(res));
        return res;
      }
      case "str_slice": {
        const res = strSliceBytes(args[0], args[1], args[2]);
        recordAlloc(12 + strByteLen(res));
        return res;
      }
      case "str_char_at":
        return strCharAtByte(args[0], args[1]);
      case "str_from_char_code": {
        const code = (args[0] | 0) & 0xff;
        recordAlloc(16);
        return fromUtf8Bytes(new Uint8Array([code]));
      }
      case "str_eq":
        return strEqualsBytes(args[0] ?? "", args[1] ?? "");
      case "str_hash":
        return fnv1aHashBytes(toUtf8Bytes(args[0] ?? ""));
      case "str_to_int": {
        const parsed = parseInt(String(args[0]).trim(), 10);
        return Number.isNaN(parsed) ? 0 : parsed | 0;
      }
      case "array_new": {
        recordAlloc(24);
        return createArray([]);
      }
      case "array_len": {
        const arr = args[0];
        if (!arr || arr.kind !== "array") {
          throw new LumenRuntimeError("array_len expects an array");
        }
        return arr.elements.length | 0;
      }
      case "array_push": {
        const arr = args[0];
        if (!arr || arr.kind !== "array") {
          throw new LumenRuntimeError("array_push expects an array");
        }
        arr.elements.push(args[1]);
        recordAlloc(8);
        return null;
      }
      case "array_pop": {
        const arr = args[0];
        if (!arr || arr.kind !== "array") {
          throw new LumenRuntimeError("array_pop expects an array");
        }
        if (arr.elements.length === 0) {
          throw new LumenRuntimeError("pop from empty array");
        }
        return arr.elements.pop();
      }
      case "eq":
        return valuesEqual(args[0], args[1]);
      case "hash":
        return hashValue(args[0]);
      case "sqrt":
        return Math.sqrt(toF64(args[0]));
      case "sin":
        return Math.sin(toF64(args[0]));
      case "cos":
        return Math.cos(toF64(args[0]));
      case "abs_f64":
        return Math.abs(toF64(args[0]));
      case "abs_i32":
        return Math.abs(toI32(args[0])) | 0;
      case "floor":
        return Math.floor(toF64(args[0]));
      case "ceil":
        return Math.ceil(toF64(args[0]));
      case "pow":
        return Math.pow(toF64(args[0]), toF64(args[1]));
      case "gc_collect":
        gcStats.collections = (gcStats.collections + 1) | 0;
        return null;
      case "gc_live_bytes":
        return gcStats.liveBytes | 0;
      case "gc_total_allocated":
        return gcStats.totalAllocated | 0;
      case "gc_collection_count":
        return gcStats.collections | 0;
      case "clock_ms":
        return toF64(Date.now() - startTime);
      case "assert": {
        const cond = args[0];
        if (!cond) {
          const customMsg =
            args.length > 1 && args[1] !== undefined && args[1] !== null
              ? formatValue(args[1])
              : "";
          throw new LumenRuntimeError(
            customMsg ? `assertion failed: ${customMsg}` : "assertion failed"
          );
        }
        return null;
      }
      case "panic": {
        const msg =
          args.length > 0 && args[0] !== undefined && args[0] !== null
            ? formatValue(args[0])
            : "panic";
        throw new LumenRuntimeError(msg);
      }
      default:
        throw new LumenRuntimeError(`unknown built-in function '${name}'`);
    }
  }

  function invokeCallable(fnVal, args) {
    if (!fnVal) {
      throw new LumenRuntimeError("attempted to call null or undefined value");
    }
    if (fnVal.isBuiltin) {
      return callBuiltin(fnVal.builtinName, args);
    }
    if (fnVal.isVariantCtor) {
      recordAlloc(16 + args.length * 8);
      const e = createEnum(fnVal.enumName, fnVal.variantName, args);
      if (fnVal.tagIndex !== undefined) e.tagIndex = fnVal.tagIndex;
      return e;
    }
    if (fnVal.kind === "closure") {
      if (++callDepth > maxCallDepth) {
        throw new LumenRuntimeError("stack overflow");
      }
      const fnScope = new Scope(fnVal.env || globalScope);
      const params = fnVal.params || [];
      const declParams = fnVal.fnDecl?.params || fnVal.closureParams || [];
      for (let i = 0; i < params.length; i++) {
        const paramName = typeof params[i] === "string" ? params[i] : params[i].name;
        const declParam = declParams[i];
        const tag =
          getTypeNodeTag(declParam?.typeAnn) ||
          (hasSemanticType(declParam, "f64") ? "f64" : null);
        // Rule 3: Arguments (including structs, arrays, strings) are passed by shared reference
        fnScope.define(paramName, args[i], Boolean(declParam?.mutable), tag);
      }
      const retTag = getTypeNodeTag(fnVal.fnDecl?.returnType);
      const isVoidFn =
        fnVal.fnDecl && (!fnVal.fnDecl.returnType || retTag === "void");
      try {
        let res;
        if (fnVal.body.kind === "BlockStmt") {
          res = execBlock(fnVal.body, fnScope, false);
        } else {
          res = evalExpr(fnVal.body, fnScope);
        }
        return isVoidFn ? null : res;
      } catch (sig) {
        if (sig instanceof ReturnSignal) {
          return isVoidFn ? null : sig.value;
        }
        throw sig;
      } finally {
        callDepth--;
      }
    }
    throw new LumenRuntimeError("value is not callable");
  }

  function matchPattern(pattern, value, armScope) {
    if (!pattern) return true;
    switch (pattern.kind) {
      case "WildcardPattern":
        return true;

      case "VarPattern":
      case "IdentPattern": {
        const name = pattern.name;
        if (name === "_") return true;
        // Check if this identifier is actually a 0-argument enum variant (e.g. `None`, `Red`)
        if (zeroArgVariants.has(name) && value && value.kind === "enum") {
          return value.variantName === name && value.args.length === 0;
        }
        const tag = hasSemanticType(pattern, "f64") ? "f64" : null;
        armScope.define(name, value, Boolean(pattern.mutable), tag);
        return true;
      }

      case "LiteralPattern": {
        let litVal;
        if (pattern.literal !== undefined) {
          litVal = evalExpr(pattern.literal, armScope);
        } else {
          litVal = pattern.value;
        }
        return valuesEqual(litVal, value);
      }

      case "EnumPattern": {
        if (!value || value.kind !== "enum") return false;
        const patVariant = pattern.variantName || pattern.variant;
        if (value.variantName !== patVariant) return false;
        if (
          pattern.enumName &&
          value.enumName &&
          pattern.enumName !== value.enumName
        ) {
          return false;
        }
        const patArgs = pattern.args || pattern.payload || pattern.patterns || [];
        if (patArgs.length !== value.args.length) return false;
        for (let i = 0; i < patArgs.length; i++) {
          if (!matchPattern(patArgs[i], value.args[i], armScope)) {
            return false;
          }
        }
        return true;
      }

      case "StructPattern": {
        if (!value || value.kind !== "struct") return false;
        const patStructName = pattern.structName || pattern.name;
        if (patStructName && value.name !== patStructName) return false;
        const patFields = pattern.fields || [];
        for (const f of patFields) {
          const fieldName = f.name;
          if (!value.fields.has(fieldName)) return false;
          const fieldVal = value.fields.get(fieldName);
          if (f.pattern) {
            if (!matchPattern(f.pattern, fieldVal, armScope)) {
              return false;
            }
          } else {
            armScope.define(fieldName, fieldVal, false);
          }
        }
        return true;
      }

      default:
        throw new LumenRuntimeError(`unsupported pattern kind '${pattern.kind}'`);
    }
  }

  function applyBinaryOp(op, left, right, forceF64 = false) {
    // String concatenation and UTF-8 byte comparisons
    if (typeof left === "string" || typeof right === "string") {
      if (op === "+") {
        const res = strConcatBytes(left ?? "", right ?? "");
        recordAlloc(12 + strByteLen(res));
        return res;
      }
      if (op === "==") return strEqualsBytes(left ?? "", right ?? "");
      if (op === "!=") return !strEqualsBytes(left ?? "", right ?? "");
      if (op === "<") return strCompareBytes(left ?? "", right ?? "") < 0;
      if (op === "<=") return strCompareBytes(left ?? "", right ?? "") <= 0;
      if (op === ">") return strCompareBytes(left ?? "", right ?? "") > 0;
      if (op === ">=") return strCompareBytes(left ?? "", right ?? "") >= 0;
    }

    // 64-bit integer operations (with checked division/modulo traps from contracts)
    if (typeof left === "bigint" || typeof right === "bigint") {
      const a = toI64(left);
      const b = toI64(right);
      switch (op) {
        case "+":
          return I64.add(a, b);
        case "-":
          return I64.sub(a, b);
        case "*":
          return I64.mul(a, b);
        case "/":
          return checkedDivI64(a, b);
        case "%":
          return checkedRemI64(a, b);
        case "&":
          return I64.and(a, b);
        case "|":
          return I64.or(a, b);
        case "^":
          return I64.xor(a, b);
        case "<<":
          return I64.shl(a, b);
        case ">>":
          return I64.shrS(a, b);
        case "==":
          return a === b;
        case "!=":
          return a !== b;
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
        default:
          throw new LumenRuntimeError(`unsupported i64 operator '${op}'`);
      }
    }

    // 64-bit IEEE 754 float operations
    if (
      forceF64 ||
      (typeof left === "number" && !Number.isInteger(left)) ||
      (typeof right === "number" && !Number.isInteger(right))
    ) {
      const a = toF64(left);
      const b = toF64(right);
      switch (op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        case "%":
          return a % b;
        case "==":
          return a === b;
        case "!=":
          return a !== b;
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
        default:
          throw new LumenRuntimeError(`unsupported f64 operator '${op}'`);
      }
    }

    // Structural / Boolean equality
    if (
      typeof left === "boolean" ||
      typeof right === "boolean" ||
      (left && typeof left === "object") ||
      (right && typeof right === "object")
    ) {
      if (op === "==") return valuesEqual(left, right);
      if (op === "!=") return !valuesEqual(left, right);
      if (typeof left === "boolean" && typeof right === "boolean") {
        if (op === "&") return Boolean(left && right);
        if (op === "|") return Boolean(left || right);
        if (op === "^") return Boolean(left !== right);
      }
    }

    // Default: 32-bit signed integer operations matching Wasm i32
    const a = toI32(left);
    const b = toI32(right);
    switch (op) {
      case "+":
        return I32.add(a, b);
      case "-":
        return I32.sub(a, b);
      case "*":
        return I32.mul(a, b);
      case "/":
        return checkedDivI32(a, b);
      case "%":
        return checkedRemI32(a, b);
      case "&":
        return I32.and(a, b);
      case "|":
        return I32.or(a, b);
      case "^":
        return I32.xor(a, b);
      case "<<":
        return I32.shl(a, b);
      case ">>":
        return I32.shrS(a, b);
      case "==":
        return a === b;
      case "!=":
        return a !== b;
      case "<":
        return a < b;
      case "<=":
        return a <= b;
      case ">":
        return a > b;
      case ">=":
        return a >= b;
      default:
        throw new LumenRuntimeError(`unsupported binary operator '${op}'`);
    }
  }

  function execBlock(blockStmt, parentScope, createNewScope = true) {
    if (!blockStmt) return null;
    if (blockStmt.kind !== "BlockStmt") {
      return evalNode(blockStmt, parentScope);
    }
    const blockScope = createNewScope ? new Scope(parentScope) : parentScope;
    const stmts = blockStmt.stmts || blockStmt.body || blockStmt.statements || [];
    let lastVal = null;
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      lastVal = execStmt(s, blockScope);
    }
    if (blockStmt.tailExpr !== null && blockStmt.tailExpr !== undefined) {
      return evalExpr(blockStmt.tailExpr, blockScope);
    }
    return lastVal;
  }

  function execAssignment(stmt, scope) {
    const target = stmt.target || stmt.left;
    const op = stmt.op || "=";
    const rhsNode = stmt.value !== undefined ? stmt.value : stmt.right;
    const rhsIsF64 = isF64Expr(rhsNode, scope);
    const rhsVal = evalExpr(rhsNode, scope);

    const computeNewVal = (oldVal, targetIsF64 = false) => {
      if (op === "=") return rhsVal;
      const binOp = op.slice(0, -1); // "+=" -> "+"
      return applyBinaryOp(binOp, oldVal, rhsVal, targetIsF64 || rhsIsF64);
    };

    if (target.kind === "IdentExpr") {
      const targetIsF64 = scope.getTypeTag(target.name) === "f64";
      const oldVal = op === "=" ? null : scope.get(target.name);
      const newVal = computeNewVal(oldVal, targetIsF64);
      scope.assign(target.name, newVal);
      return null;
    }

    if (target.kind === "IndexExpr") {
      const arr = evalExpr(target.object, scope);
      const idx = toI32(evalExpr(target.index, scope));
      if (!arr || arr.kind !== "array") {
        throw new LumenRuntimeError("index assignment target is not an array");
      }
      if (idx < 0 || idx >= arr.elements.length) {
        throw new LumenRuntimeError("index out of bounds");
      }
      const targetIsF64 = hasSemanticType(target, "f64");
      const oldVal = op === "=" ? null : arr.elements[idx];
      arr.elements[idx] = computeNewVal(oldVal, targetIsF64);
      return null;
    }

    if (target.kind === "FieldExpr") {
      const obj = evalExpr(target.object, scope);
      const field = target.field || target.property;
      if (!obj || obj.kind !== "struct") {
        throw new LumenRuntimeError("field assignment target is not a struct");
      }
      if (!obj.fields.has(field)) {
        throw new LumenRuntimeError(`unknown field '${field}' on struct '${obj.name}'`);
      }
      const targetIsF64 = hasSemanticType(target, "f64");
      const oldVal = op === "=" ? null : obj.fields.get(field);
      obj.fields.set(field, computeNewVal(oldVal, targetIsF64));
      return null;
    }

    throw new LumenRuntimeError("invalid assignment target");
  }

  function execRangeLoop(iterVar, startVal, endVal, inclusive, body, scope) {
    if (typeof startVal === "bigint" || typeof endVal === "bigint") {
      const s = toI64(startVal);
      const e = toI64(endVal);
      const limit = inclusive ? e + 1n : e;
      for (let i = s; i < limit; i++) {
        if (++steps > maxSteps) {
          throw new LumenRuntimeError("execution step limit exceeded in for loop");
        }
        const loopScope = new Scope(scope);
        loopScope.define(iterVar, BigInt.asIntN(64, i), false, "i64");
        try {
          execBlock(body, loopScope, false);
        } catch (sig) {
          if (sig instanceof BreakSignal) break;
          if (sig instanceof ContinueSignal) continue;
          throw sig;
        }
      }
    } else {
      const s = toI32(startVal);
      const e = toI32(endVal);
      const limit = inclusive ? e + 1 : e;
      for (let i = s; i < limit; i++) {
        if (++steps > maxSteps) {
          throw new LumenRuntimeError("execution step limit exceeded in for loop");
        }
        const loopScope = new Scope(scope);
        loopScope.define(iterVar, i | 0, false, "i32");
        try {
          execBlock(body, loopScope, false);
        } catch (sig) {
          if (sig instanceof BreakSignal) break;
          if (sig instanceof ContinueSignal) continue;
          throw sig;
        }
      }
    }
  }

  function execStmt(stmt, scope) {
    if (!stmt) return null;
    if (++steps > maxSteps) {
      throw new LumenRuntimeError("execution step limit exceeded");
    }

    switch (stmt.kind) {
      case "BlockStmt":
        return execBlock(stmt, scope, true);

      case "LetStmt": {
        const initExpr = stmt.init || stmt.value || stmt.expr;
        const val = initExpr ? evalExpr(initExpr, scope) : null;
        const tag =
          getTypeNodeTag(stmt.typeAnn) ||
          (hasSemanticType(stmt, "f64") || isF64Expr(initExpr, scope) ? "f64" : null);
        if (stmt.pattern) {
          matchPattern(stmt.pattern, val, scope);
        } else {
          // Rule 3: Shared reference stored directly, never cloned
          scope.define(stmt.name, val, Boolean(stmt.mutable), tag);
        }
        return null;
      }

      case "ConstDecl": {
        const initExpr = stmt.init || stmt.value || stmt.expr;
        const val = evalExpr(initExpr, scope);
        const tag =
          getTypeNodeTag(stmt.typeAnn) ||
          (hasSemanticType(stmt, "f64") || isF64Expr(initExpr, scope) ? "f64" : null);
        scope.define(stmt.name, val, false, tag);
        return null;
      }

      case "AssignStmt":
        return execAssignment(stmt, scope);

      case "IfStmt":
      case "IfExpr": {
        const cond = evalExpr(stmt.cond || stmt.condition, scope);
        const thenBranch = stmt.thenBranch || stmt.thenBlock || stmt.consequent;
        const elseBranch = stmt.elseBranch || stmt.elseBlock || stmt.alternate;
        if (cond) {
          return evalNode(thenBranch, scope);
        } else if (elseBranch) {
          return evalNode(elseBranch, scope);
        }
        return null;
      }

      case "WhileStmt": {
        const condExpr = stmt.cond || stmt.condition;
        while (evalExpr(condExpr, scope)) {
          if (++steps > maxSteps) {
            throw new LumenRuntimeError("execution step limit exceeded in while loop");
          }
          try {
            execBlock(stmt.body, scope, true);
          } catch (sig) {
            if (sig instanceof BreakSignal) break;
            if (sig instanceof ContinueSignal) continue;
            throw sig;
          }
        }
        return null;
      }

      case "ForStmt": {
        const iterVar =
          stmt.iteratorVar || stmt.varName || stmt.variable || stmt.name;
        const iterable = stmt.iterable || stmt.iterator || stmt.collection;

        if (stmt.start !== undefined && stmt.end !== undefined && !iterable) {
          const startVal = evalExpr(stmt.start, scope);
          const endVal = evalExpr(stmt.end, scope);
          execRangeLoop(iterVar, startVal, endVal, Boolean(stmt.inclusive), stmt.body, scope);
          return null;
        }

        // Rule 8: Support RangeExpr ({ kind: "RangeExpr", start, end }) in ForStmt
        if (
          iterable &&
          (iterable.kind === "RangeExpr" ||
            (iterable.kind === "BinaryExpr" &&
              (iterable.op === ".." || iterable.op === "..=")))
        ) {
          const startNode =
            iterable.start !== undefined ? iterable.start : iterable.left;
          const endNode =
            iterable.end !== undefined ? iterable.end : iterable.right;
          const inclusive =
            Boolean(iterable.inclusive) || iterable.op === "..=";
          const startVal = evalExpr(startNode, scope);
          const endVal = evalExpr(endNode, scope);
          execRangeLoop(iterVar, startVal, endVal, inclusive, stmt.body, scope);
          return null;
        }

        const evaluatedIterable = evalExpr(iterable, scope);
        if (evaluatedIterable && evaluatedIterable.kind === "range") {
          execRangeLoop(
            iterVar,
            evaluatedIterable.start,
            evaluatedIterable.end,
            Boolean(evaluatedIterable.inclusive),
            stmt.body,
            scope
          );
          return null;
        }

        if (evaluatedIterable && evaluatedIterable.kind === "array") {
          const elems = evaluatedIterable.elements;
          for (let i = 0; i < elems.length; i++) {
            if (++steps > maxSteps) {
              throw new LumenRuntimeError("execution step limit exceeded in for loop");
            }
            const loopScope = new Scope(scope);
            loopScope.define(iterVar, elems[i], false);
            try {
              execBlock(stmt.body, loopScope, false);
            } catch (sig) {
              if (sig instanceof BreakSignal) break;
              if (sig instanceof ContinueSignal) continue;
              throw sig;
            }
          }
          return null;
        }

        throw new LumenRuntimeError(
          "for loop iterable must be a range (a..b) or an array ([T])"
        );
      }

      case "ReturnStmt": {
        const valExpr = stmt.value !== undefined ? stmt.value : stmt.expr;
        const val =
          valExpr !== null && valExpr !== undefined
            ? evalExpr(valExpr, scope)
            : null;
        throw new ReturnSignal(val);
      }

      case "BreakStmt":
        throw new BreakSignal();

      case "ContinueStmt":
        throw new ContinueSignal();

      case "ExprStmt":
        evalExpr(stmt.expr, scope);
        return null;

      case "MatchExpr":
      case "MatchStmt":
        return evalExpr(stmt, scope);

      default:
        return evalExpr(stmt, scope);
    }
  }

  function evalNode(node, scope) {
    if (!node) return null;
    if (node.kind === "BlockStmt") {
      return execBlock(node, scope, true);
    }
    if (node.kind && node.kind.endsWith("Stmt")) {
      return execStmt(node, scope);
    }
    return evalExpr(node, scope);
  }

  function evalExpr(expr, scope) {
    if (!expr) return null;
    if (++steps > maxSteps) {
      throw new LumenRuntimeError("execution step limit exceeded");
    }

    switch (expr.kind) {
      case "LiteralExpr": {
        if (hasSemanticType(expr, "i64")) {
          return toI64(expr.value);
        }
        if (hasSemanticType(expr, "f64")) {
          return toF64(expr.value);
        }
        const lt = expr.literalType || expr.type;
        switch (lt) {
          case "i32":
          case "int":
            return toI32(expr.value);
          case "i64":
            return toI64(expr.value);
          case "f64":
          case "float":
            return toF64(expr.value);
          case "bool":
            return toBool(expr.value);
          case "string":
            return String(expr.value);
          case "void":
          case "null":
            return null;
          default:
            if (typeof expr.value === "bigint") return toI64(expr.value);
            if (typeof expr.value === "number") {
              return hasSemanticType(expr, "f64")
                ? toF64(expr.value)
                : toI32(expr.value);
            }
            return expr.value;
        }
      }

      case "IdentExpr": {
        const name = expr.name;
        const cell = scope.resolveCell(name);
        if (cell) {
          return cell.value;
        }
        if (name.includes("::")) {
          const parts = name.split("::");
          const last = parts[parts.length - 1];
          const enumName = parts[0];
          if (enums.has(enumName) && enums.get(enumName).has(last)) {
            const vInfo = enums.get(enumName).get(last);
            if (vInfo.arity === 0) {
              const e = createEnum(enumName, last, []);
              e.tagIndex = vInfo.tagIndex;
              return e;
            }
            return createClosure([], null, globalScope, {
              isVariantCtor: true,
              enumName,
              variantName: last,
              arity: vInfo.arity,
              tagIndex: vInfo.tagIndex,
            });
          }
          const lastCell = scope.resolveCell(last);
          if (lastCell) return lastCell.value;
        }
        if (zeroArgVariants.has(name)) {
          const info = variantToEnum.get(name);
          const e = createEnum(info.enumName, name, []);
          e.tagIndex = info.tagIndex;
          return e;
        }
        if (functions.has(name)) {
          const decl = functions.get(name);
          return createClosure(
            (decl.params || []).map((p) =>
              typeof p === "string" ? p : p.name
            ),
            decl.body,
            globalScope,
            { fnDecl: decl, name }
          );
        }
        return createClosure([], null, globalScope, {
          isBuiltin: true,
          builtinName: name,
        });
      }

      case "BinaryExpr": {
        const op = expr.op || expr.operator;
        if (op === "&&" || op === "and") {
          const leftVal = evalExpr(expr.left, scope);
          if (!leftVal) return false;
          return Boolean(evalExpr(expr.right, scope));
        }
        if (op === "||" || op === "or") {
          const leftVal = evalExpr(expr.left, scope);
          if (leftVal) return true;
          return Boolean(evalExpr(expr.right, scope));
        }
        if (op === ".." || op === "..=") {
          const start = evalExpr(expr.left, scope);
          const end = evalExpr(expr.right, scope);
          return createRange(start, end, op === "..=");
        }
        const forceF64 =
          isF64Expr(expr, scope) ||
          isF64Expr(expr.left, scope) ||
          isF64Expr(expr.right, scope);
        const leftVal = evalExpr(expr.left, scope);
        const rightVal = evalExpr(expr.right, scope);
        return applyBinaryOp(op, leftVal, rightVal, forceF64);
      }

      case "RangeExpr": {
        const startNode = expr.start !== undefined ? expr.start : expr.left;
        const endNode = expr.end !== undefined ? expr.end : expr.right;
        const start = evalExpr(startNode, scope);
        const end = evalExpr(endNode, scope);
        return createRange(start, end, Boolean(expr.inclusive));
      }

      case "UnaryExpr": {
        const op = expr.op || expr.operator;
        const operandNode = expr.operand || expr.argument;
        const forceF64 = isF64Expr(expr, scope);
        const val = evalExpr(operandNode, scope);
        if (op === "-") {
          if (typeof val === "bigint") return I64.neg(val);
          if (forceF64 || (typeof val === "number" && !Number.isInteger(val))) {
            return -toF64(val);
          }
          return I32.neg(val);
        }
        if (op === "!" || op === "not") {
          return !Boolean(val);
        }
        if (op === "~") {
          if (typeof val === "bigint") return I64.not(val);
          return I32.not(val);
        }
        throw new LumenRuntimeError(`unsupported unary operator '${op}'`);
      }

      case "CastExpr": {
        const srcExpr = expr.expr || expr.operand;
        const val = evalExpr(srcExpr, scope);
        const targetName =
          getTypeNodeTag(expr.targetType) ||
          unwrapType(expr.inferredType)?.name;
        switch (targetName) {
          case "i32":
            return castToI32(val);
          case "i64":
            if (hasSemanticType(srcExpr, "i32")) {
              return BigInt(val | 0);
            }
            return castToI64(val);
          case "f64":
            return toF64(val);
          case "bool":
            return toBool(val);
          case "string":
            return formatValue(val);
          default:
            return val;
        }
      }

      case "CallExpr": {
        const args = (expr.args || expr.arguments || []).map((a) =>
          evalExpr(a, scope)
        );
        const callee = expr.callee;

        if (callee.kind === "IdentExpr") {
          const name = callee.name;
          // 1. Local lexical variable (e.g., closure parameter or local variable)
          const localCell = scope.resolveCell(name);
          if (localCell && localCell.value && localCell.value.kind === "closure") {
            return invokeCallable(localCell.value, args);
          }
          // 2. Qualified enum constructor or module function (`Option::Some`, `std::math::sqrt`)
          if (name.includes("::")) {
            const parts = name.split("::");
            const first = parts[0];
            const last = parts[parts.length - 1];
            if (enums.has(first) && enums.get(first).has(last)) {
              const vInfo = enums.get(first).get(last);
              recordAlloc(16 + args.length * 8);
              const e = createEnum(first, last, args);
              e.tagIndex = vInfo.tagIndex;
              return e;
            }
            if (functions.has(last)) {
              const fnVal = globalScope.get(last);
              return invokeCallable(fnVal, args);
            }
            return callBuiltin(last, args);
          }
          // 3. Unqualified enum variant constructor (`Some(x)`, `Ok(x)`)
          if (variantToEnum.has(name)) {
            const info = variantToEnum.get(name);
            recordAlloc(16 + args.length * 8);
            const e = createEnum(info.enumName, name, args);
            e.tagIndex = info.tagIndex;
            return e;
          }
          // 4. Top-level user function
          if (functions.has(name)) {
            const fnVal = globalScope.get(name);
            return invokeCallable(fnVal, args);
          }
          // 5. Built-in function
          return callBuiltin(name, args);
        }

        // FieldExpr or PathExpr callee (e.g. Option::Some(x) if parsed as FieldExpr)
        if (
          callee.kind === "FieldExpr" &&
          callee.object?.kind === "IdentExpr" &&
          enums.has(callee.object.name)
        ) {
          const enumName = callee.object.name;
          const variantName = callee.field || callee.property;
          const vInfo = enums.get(enumName)?.get(variantName);
          recordAlloc(16 + args.length * 8);
          const e = createEnum(enumName, variantName, args);
          if (vInfo) e.tagIndex = vInfo.tagIndex;
          return e;
        }

        const fnVal = evalExpr(callee, scope);
        return invokeCallable(fnVal, args);
      }

      case "IndexExpr": {
        const obj = evalExpr(expr.object, scope);
        const idx = toI32(evalExpr(expr.index, scope));
        if (obj && obj.kind === "array") {
          if (idx < 0 || idx >= obj.elements.length) {
            throw new LumenRuntimeError("index out of bounds");
          }
          return obj.elements[idx];
        }
        if (typeof obj === "string") {
          return strCharAtByte(obj, idx);
        }
        throw new LumenRuntimeError("cannot index non-array value");
      }

      case "FieldExpr": {
        const fieldName = expr.field || expr.property;
        if (
          expr.object?.kind === "IdentExpr" &&
          enums.has(expr.object.name) &&
          !scope.has(expr.object.name)
        ) {
          const enumName = expr.object.name;
          const vInfo = enums.get(enumName).get(fieldName) || {
            arity: 0,
            tagIndex: 0,
          };
          if (vInfo.arity === 0) {
            const e = createEnum(enumName, fieldName, []);
            e.tagIndex = vInfo.tagIndex;
            return e;
          }
          return createClosure([], null, globalScope, {
            isVariantCtor: true,
            enumName,
            variantName: fieldName,
            arity: vInfo.arity,
            tagIndex: vInfo.tagIndex,
          });
        }

        const obj = evalExpr(expr.object, scope);
        if (obj && obj.kind === "struct") {
          if (!obj.fields.has(fieldName)) {
            throw new LumenRuntimeError(
              `unknown field '${fieldName}' on struct '${obj.name}'`
            );
          }
          return obj.fields.get(fieldName);
        }
        if (
          obj &&
          obj.kind === "array" &&
          (fieldName === "len" || fieldName === "length")
        ) {
          return obj.elements.length | 0;
        }
        if (
          typeof obj === "string" &&
          (fieldName === "len" || fieldName === "length")
        ) {
          return strByteLen(obj);
        }
        throw new LumenRuntimeError(
          `cannot access field '${fieldName}' on non-struct value`
        );
      }

      case "StructLitExpr": {
        const structName = expr.structName || expr.name;
        const evaluatedFields = new Map();
        const fieldNodes = expr.fields || [];
        for (const f of fieldNodes) {
          const valNode = f.value !== undefined ? f.value : f.expr;
          evaluatedFields.set(f.name, evalExpr(valNode, scope));
        }

        // Order fields according to StructDecl layout (+8 + 8 * i) when available
        const fieldsMap = new Map();
        const structDecl = structs.get(structName);
        if (structDecl && Array.isArray(structDecl.fields)) {
          for (const declField of structDecl.fields) {
            if (evaluatedFields.has(declField.name)) {
              fieldsMap.set(declField.name, evaluatedFields.get(declField.name));
            }
          }
        }
        for (const [k, v] of evaluatedFields.entries()) {
          if (!fieldsMap.has(k)) {
            fieldsMap.set(k, v);
          }
        }

        recordAlloc(8 + fieldsMap.size * 8);
        return createStruct(structName, fieldsMap);
      }

      case "EnumInitExpr": {
        const variantName = expr.variantName || expr.variant;
        let enumName = expr.enumName;
        let tagIndex = 0;
        if (!enumName && variantToEnum.has(variantName)) {
          const info = variantToEnum.get(variantName);
          enumName = info.enumName;
          tagIndex = info.tagIndex;
        } else if (enumName && enums.has(enumName) && enums.get(enumName).has(variantName)) {
          tagIndex = enums.get(enumName).get(variantName).tagIndex;
        }
        const args = (expr.args || expr.payload || []).map((a) =>
          evalExpr(a, scope)
        );
        recordAlloc(16 + args.length * 8);
        const e = createEnum(enumName || "", variantName, args);
        e.tagIndex = tagIndex;
        return e;
      }

      case "ArrayLitExpr": {
        if (expr.count !== undefined || expr.repeat !== undefined) {
          const elemVal = evalExpr(expr.element || expr.elements?.[0], scope);
          const count = toI32(evalExpr(expr.count || expr.repeat, scope));
          const elements = new Array(Math.max(0, count)).fill(elemVal);
          recordAlloc(24 + elements.length * 8);
          return createArray(elements);
        }
        const elements = (expr.elements || []).map((e) => evalExpr(e, scope));
        recordAlloc(24 + elements.length * 8);
        return createArray(elements);
      }

      case "IfExpr":
      case "IfStmt": {
        const cond = evalExpr(expr.cond || expr.condition, scope);
        const thenBranch = expr.thenBlock || expr.thenBranch || expr.consequent;
        const elseBranch = expr.elseBlock || expr.elseBranch || expr.alternate;
        if (cond) {
          return evalNode(thenBranch, scope);
        } else if (elseBranch) {
          return evalNode(elseBranch, scope);
        }
        return null;
      }

      case "MatchExpr":
      case "MatchStmt": {
        const scrutineeNode = expr.scrutinee || expr.expr || expr.value;
        const scrutineeVal = evalExpr(scrutineeNode, scope);
        const arms = expr.arms || expr.cases || [];
        for (const arm of arms) {
          const armScope = new Scope(scope);
          if (matchPattern(arm.pattern, scrutineeVal, armScope)) {
            if (arm.guard) {
              const guardVal = evalExpr(arm.guard, armScope);
              if (!guardVal) continue;
            }
            return evalNode(arm.body, armScope);
          }
        }
        throw new LumenRuntimeError(
          `non-exhaustive match: no pattern matched value '${formatValue(scrutineeVal)}'`
        );
      }

      case "ClosureExpr": {
        const rawParams = expr.params || [];
        const paramNames = rawParams.map((p) =>
          typeof p === "string" ? p : p.name
        );
        recordAlloc(16 + (expr.captures ? expr.captures.length * 8 : 8));
        return createClosure(paramNames, expr.body, scope, {
          closureParams: rawParams,
        });
      }

      case "BlockExpr":
        return execBlock(expr.block || expr.body, scope, true);

      case "BlockStmt":
        return execBlock(expr, scope, true);

      case "AssignStmt":
      case "AssignExpr":
        return execAssignment(expr, scope);

      default:
        throw new LumenRuntimeError(
          `unsupported AST expression kind '${expr.kind}'`
        );
    }
  }

  // Execute program:
  // Pass 2: Evaluate top-level ConstDecl in source order, then invoke `main()`
  try {
    for (const decl of programAst.decls) {
      if (decl && decl.kind === "ConstDecl") {
        execStmt(decl, globalScope);
      }
    }

    const entryName = options.entry || "main";
    if (!functions.has(entryName)) {
      return {
        stdout,
        errorText: "",
        returnValue: null,
        exitCode: 0,
      };
    }

    const mainFn = globalScope.get(entryName);
    const returnValue = invokeCallable(mainFn, options.args || []);
    return {
      stdout,
      errorText: "",
      returnValue: returnValue ?? null,
      exitCode: 0,
    };
  } catch (err) {
    const message = formatRuntimeErrorMessage(err);
    return {
      stdout,
      errorText: `runtime error: ${message}`,
      returnValue: null,
      exitCode: 1,
    };
  }
}
