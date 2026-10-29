/**
 * Lumen AST-to-LIR Lowering Pass (`src/ir/lower.js`)
 * Owned exclusively by Agent C.
 *
 * Lowers a type-checked Lumen Program AST into the canonical Lumen Intermediate
 * Representation (`LirModule`), obeying all contracts in `src/contracts/index.js`:
 * - Built-in calls use `op: "call_builtin"` (no leading space).
 * - All heap offsets (`mem_load`, `mem_store`, `pointerOffsets`) are measured from
 *   the object start (`header = offset 0`, so >= `GC_HEADER_SIZE` = 8).
 * - Rule 10 (GC Stack Safety): No unrooted `gc_ref` value sits on the Wasm operand
 *   stack across a call or allocation. Any non-trivial `gc_ref` subexpression is
 *   bound to a shadow-stack-rooted `LirLocal` before subsequent calls/allocations.
 * - Rule 16 (Debugger Support): When `options.debug` is true, emits
 *   `{ op: "debug_loc", line, col }` before each statement in `LirFunction.body`.
 */

import {
  Types,
  unwrapType,
  semanticTypeToLirType,
  isGcManagedType,
  GC_HEADER_SIZE,
  OBJ_KIND,
  BUILTIN_NAMES,
  exprMayAllocOrCall,
  validateLir,
} from "../contracts/index.js";

const BUILTIN_RETURN_LIR_TYPES = Object.freeze({
  print: "void",
  println: "void",
  int_to_string: "gc_ref",
  i64_to_string: "gc_ref",
  float_to_string: "gc_ref",
  bool_to_string: "gc_ref",
  int_to_float: "f64",
  float_to_int: "i32",
  i32_to_i64: "i64",
  i64_to_i32: "i32",
  str_len: "i32",
  str_concat: "gc_ref",
  str_slice: "gc_ref",
  str_char_at: "i32",
  str_from_char_code: "gc_ref",
  str_eq: "i32",
  str_hash: "i32",
  str_to_int: "i32",
  array_len: "i32",
  array_push: "void",
  array_pop: "i32",
  array_new: "gc_ref",
  eq: "i32",
  hash: "i32",
  sqrt: "f64",
  sin: "f64",
  cos: "f64",
  abs_f64: "f64",
  abs_i32: "i32",
  floor: "f64",
  ceil: "f64",
  pow: "f64",
  gc_collect: "void",
  gc_live_bytes: "i32",
  gc_total_allocated: "i32",
  gc_collection_count: "i32",
  clock_ms: "f64",
  assert: "void",
  panic: "void",
  grow_array: "gc_ref",
  trap: "void",
});

const COMPARISON_AND_LOGICAL_OPS = new Set([
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "&&",
  "||",
]);

/**
 * Returns true if `expr` is already safely rooted according to `validateLir()`.
 */
function isAlreadyRootedGcExpr(expr) {
  if (!expr || expr.type !== "gc_ref") return true;
  if (
    expr.op === "local_get" ||
    expr.op === "global_get" ||
    expr.op === "const_string" ||
    expr.op === "const_i32"
  ) {
    return true;
  }
  if (expr.op === "seq") {
    return isAlreadyRootedGcExpr(expr.result);
  }
  return false;
}

function defaultConstForLirType(lirType) {
  if (lirType === "i64") {
    return { op: "const_i64", value: 0n, type: "i64" };
  }
  if (lirType === "f64") {
    return { op: "const_f64", value: 0.0, type: "f64" };
  }
  if (lirType === "gc_ref") {
    return { op: "const_i32", value: 0, type: "gc_ref" };
  }
  return { op: "const_i32", value: 0, type: "i32" };
}

class ModuleLowerer {
  constructor(options = {}) {
    this.env = options.env || null;
    this.debug = Boolean(options.debug);

    this.stringLiterals = [];
    this.stringMap = new Map(); // string value -> id

    this.typeDescriptors = [];
    this.typeDescriptorMap = new Map(); // name -> descriptor

    this.globals = [];
    this.globalMap = new Map(); // name -> { name, type, isBool, decl }

    this.functions = [];
    this.functionReturnTypes = new Map(); // fnName -> LirType
    this.functionReturnsBool = new Map(); // fnName -> boolean
  }

  /**
   * Intern a string literal into `this.stringLiterals` and return its numeric ID.
   */
  internString(value) {
    const str = String(value ?? "");
    if (this.stringMap.has(str)) {
      return this.stringMap.get(str);
    }
    const id = this.stringLiterals.length;
    this.stringLiterals.push({ id, value: str });
    this.stringMap.set(str, id);
    return id;
  }

  /**
   * Check whether a semantic Type or AST TypeNode represents `bool`.
   */
  isBoolType(typeOrNode) {
    if (!typeOrNode) return false;
    if (typeof typeOrNode === "string") return typeOrNode === "bool";
    if (typeOrNode.tag) {
      const t = unwrapType(typeOrNode);
      return Boolean(t && t.tag === "prim" && t.name === "bool");
    }
    if (typeOrNode.resolvedType) {
      return this.isBoolType(typeOrNode.resolvedType);
    }
    if (typeOrNode.inferredType) {
      return this.isBoolType(typeOrNode.inferredType);
    }
    if (typeOrNode.kind === "NamedType") {
      return typeOrNode.name === "bool";
    }
    return false;
  }

  /**
   * Check whether an AST expression produces a semantic `bool` value.
   */
  isBoolAstExpr(expr, fnCtx) {
    if (!expr) return false;
    if (expr.inferredType) {
      const t = unwrapType(expr.inferredType);
      if (t && t.tag !== "error") {
        return t.tag === "prim" && t.name === "bool";
      }
    }
    switch (expr.kind) {
      case "LiteralExpr":
        return expr.literalType === "bool";
      case "IdentExpr": {
        if (fnCtx) {
          const local = this.lookupVar(fnCtx, expr.name);
          if (local) return Boolean(local.isBool);
        }
        const glob = this.globalMap.get(expr.name);
        if (glob) return Boolean(glob.isBool);
        return false;
      }
      case "UnaryExpr":
        return expr.op === "!";
      case "BinaryExpr":
        return COMPARISON_AND_LOGICAL_OPS.has(expr.op);
      case "CastExpr":
        return this.isBoolType(expr.targetType);
      case "CallExpr": {
        if (expr.callee?.kind === "IdentExpr") {
          const fnName = expr.callee.name;
          if (fnName === "str_eq" || fnName === "eq") return true;
          if (this.functionReturnsBool.has(fnName)) {
            return this.functionReturnsBool.get(fnName);
          }
          if (this.env && this.env.getFunction) {
            const fnDef = this.env.getFunction(fnName);
            if (fnDef && fnDef.returnType) {
              return this.isBoolType(fnDef.returnType);
            }
          }
        }
        return false;
      }
      case "IfExpr":
        return (
          this.isBoolAstExpr(expr.thenBlock?.tailExpr, fnCtx) ||
          this.isBoolAstExpr(expr.elseBlock?.tailExpr, fnCtx)
        );
      case "BlockExpr":
        return this.isBoolAstExpr(expr.block?.tailExpr, fnCtx);
      default:
        return false;
    }
  }

  /**
   * Resolve a TypeNode or semantic Type to a `LirType` ("i32" | "i64" | "f64" | "gc_ref" | "void").
   */
  resolveLirType(typeOrNode) {
    if (!typeOrNode) return "void";
    if (typeof typeOrNode === "string") {
      switch (typeOrNode) {
        case "i32":
        case "bool":
          return "i32";
        case "i64":
          return "i64";
        case "f64":
          return "f64";
        case "string":
        case "gc_ref":
          return "gc_ref";
        case "void":
        case "()":
          return "void";
        default:
          return "i32";
      }
    }
    if (typeOrNode.tag) {
      return semanticTypeToLirType(typeOrNode);
    }
    if (typeOrNode.resolvedType) {
      return semanticTypeToLirType(typeOrNode.resolvedType);
    }
    if (typeOrNode.inferredType) {
      return semanticTypeToLirType(typeOrNode.inferredType);
    }
    if (typeOrNode.kind === "NamedType") {
      switch (typeOrNode.name) {
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
        case "()":
          return "void";
        default:
          return "gc_ref";
      }
    }
    if (typeOrNode.kind === "ArrayType" || typeOrNode.kind === "FnType") {
      return "gc_ref";
    }
    return "i32";
  }

  lowerProgram(programAst) {
    if (!programAst || programAst.kind !== "Program") {
      throw new Error("lowerToLir expected a Program AST node");
    }

    const decls = programAst.decls || [];

    // Pass 1: Record function return types & top-level constants
    for (const decl of decls) {
      if (!decl) continue;
      if (decl.kind === "FnDecl") {
        let retType = "void";
        let returnsBool = false;
        if (decl.resolvedReturnType) {
          retType = semanticTypeToLirType(decl.resolvedReturnType);
          returnsBool = this.isBoolType(decl.resolvedReturnType);
        } else if (decl.returnType) {
          retType = this.resolveLirType(decl.returnType);
          returnsBool = this.isBoolType(decl.returnType);
        } else if (this.env && this.env.getFunction) {
          const fnDef = this.env.getFunction(decl.name);
          if (fnDef && fnDef.returnType) {
            retType = semanticTypeToLirType(fnDef.returnType);
            returnsBool = this.isBoolType(fnDef.returnType);
          }
        }
        this.functionReturnTypes.set(decl.name, retType);
        this.functionReturnsBool.set(decl.name, returnsBool);
      } else if (decl.kind === "ConstDecl") {
        const semType = decl.resolvedType || decl.inferredType || null;
        const lirType = semType
          ? semanticTypeToLirType(semType)
          : decl.typeAnn
            ? this.resolveLirType(decl.typeAnn)
            : this.inferExprLirType(decl.init, null);
        const isBool = semType
          ? this.isBoolType(semType)
          : decl.typeAnn
            ? this.isBoolType(decl.typeAnn)
            : this.isBoolAstExpr(decl.init, null);
        this.globalMap.set(decl.name, {
          name: decl.name,
          type: lirType,
          isBool,
          decl,
        });
      }
    }

    // Pass 2: Lower top-level functions
    for (const decl of decls) {
      if (!decl) continue;
      if (decl.kind === "FnDecl") {
        // Skip uninstantiated generic functions if any exist
        if (decl.typeParams && decl.typeParams.length > 0) continue;
        const lirFn = this.lowerFnDecl(decl);
        this.functions.push(lirFn);
      }
    }

    const lirModule = {
      moduleName: programAst.moduleName || "main",
      functions: this.functions,
      globals: this.globals,
      stringLiterals: this.stringLiterals,
      typeDescriptors: this.typeDescriptors,
      functionTable: [],
      entryFunction: this.functions.some((f) => f.name === "main")
        ? "main"
        : null,
    };

    return lirModule;
  }

  lowerFnDecl(fnDecl) {
    const returnType =
      this.functionReturnTypes.get(fnDecl.name) ||
      (fnDecl.resolvedReturnType
        ? semanticTypeToLirType(fnDecl.resolvedReturnType)
        : fnDecl.returnType
          ? this.resolveLirType(fnDecl.returnType)
          : "void");

    const fnCtx = {
      name: fnDecl.name,
      returnType,
      params: [],
      locals: [],
      allLocals: [],
      nextLocalId: 0,
      nextShadowSlot: 0,
      nextTempId: 0,
      nextLabelId: 0,
      scopes: [new Map()], // stack of Map<varName, localDescriptor>
      loopLabels: [], // stack of { breakLabel, continueLabel }
    };

    // Register parameters first (localIds 0 .. params.length - 1)
    for (const param of fnDecl.params || []) {
      const paramType = param.resolvedType
        ? semanticTypeToLirType(param.resolvedType)
        : param.inferredType
          ? semanticTypeToLirType(param.inferredType)
          : this.resolveLirType(param.typeAnn);
      const isBool = param.resolvedType
        ? this.isBoolType(param.resolvedType)
        : param.inferredType
          ? this.isBoolType(param.inferredType)
          : this.isBoolType(param.typeAnn);
      const localId = fnCtx.nextLocalId++;
      const isGcRoot = paramType === "gc_ref";
      const shadowSlotIndex = isGcRoot ? fnCtx.nextShadowSlot++ : -1;
      const desc = {
        id: localId,
        localId,
        name: param.name,
        type: paramType,
        isBool,
        isParam: true,
        isGcRoot,
        shadowSlotIndex,
      };
      fnCtx.params.push(desc);
      fnCtx.allLocals.push(desc);
      fnCtx.scopes[0].set(param.name, desc);
    }

    // Lower function body statements
    const bodyStmts = this.lowerFunctionBody(fnDecl.body, fnCtx);

    return {
      name: fnDecl.name,
      params: fnCtx.params,
      returnType,
      locals: fnCtx.locals,
      body: bodyStmts,
      isPublic: Boolean(fnDecl.isPublic || fnDecl.name === "main"),
      isExported: Boolean(fnDecl.isPublic || fnDecl.name === "main"),
      shadowFrameSize: fnCtx.nextShadowSlot,
      span: fnDecl.span || null,
    };
  }

  allocLocal(fnCtx, name, lirType, isBool = false) {
    const localId = fnCtx.nextLocalId++;
    const isGcRoot = lirType === "gc_ref";
    const shadowSlotIndex = isGcRoot ? fnCtx.nextShadowSlot++ : -1;
    const desc = {
      id: localId,
      localId,
      name,
      type: lirType,
      isBool: Boolean(isBool),
      isParam: false,
      isGcRoot,
      shadowSlotIndex,
    };
    fnCtx.locals.push(desc);
    fnCtx.allLocals.push(desc);
    return desc;
  }

  allocTempLocal(fnCtx, lirType, prefix = "$tmp", isBool = false) {
    const tempName = `${prefix}_${fnCtx.nextTempId++}`;
    return this.allocLocal(fnCtx, tempName, lirType, isBool);
  }

  pushScope(fnCtx) {
    fnCtx.scopes.push(new Map());
  }

  popScope(fnCtx) {
    fnCtx.scopes.pop();
  }

  defineVar(fnCtx, name, desc) {
    fnCtx.scopes[fnCtx.scopes.length - 1].set(name, desc);
  }

  lookupVar(fnCtx, name) {
    for (let i = fnCtx.scopes.length - 1; i >= 0; i--) {
      if (fnCtx.scopes[i].has(name)) {
        return fnCtx.scopes[i].get(name);
      }
    }
    return null;
  }

  /**
   * Ensure a `gc_ref` expression is rooted in a local if it isn't already
   * (`local_get`, `global_get`, `const_string`).
   */
  ensureRootedGcExpr(expr, fnCtx) {
    if (!expr || expr.type !== "gc_ref" || isAlreadyRootedGcExpr(expr)) {
      return expr;
    }
    const tmp = this.allocTempLocal(fnCtx, "gc_ref", "$gc_tmp");
    return {
      op: "seq",
      stmts: [
        {
          op: "local_set",
          localId: tmp.localId,
          value: expr,
        },
      ],
      result: {
        op: "local_get",
        localId: tmp.localId,
        type: "gc_ref",
      },
      type: "gc_ref",
    };
  }

  /**
   * Enforce Rule 10 across an ordered list of operand expressions (`args` or `[left, right]`):
   * Any `gc_ref` expression that is not already rooted and is followed by an expression
   * that may allocate or call is bound to a temporary local.
   */
  stabilizeExprListForGc(exprs, fnCtx) {
    const out = exprs.slice();
    for (let i = 0; i < out.length; i++) {
      const e = out[i];
      if (e && e.type === "gc_ref" && !isAlreadyRootedGcExpr(e)) {
        let laterMayAllocOrCall = false;
        for (let j = i + 1; j < out.length; j++) {
          if (exprMayAllocOrCall(out[j])) {
            laterMayAllocOrCall = true;
            break;
          }
        }
        if (laterMayAllocOrCall) {
          out[i] = this.ensureRootedGcExpr(e, fnCtx);
        }
      }
    }
    return out;
  }

  lowerFunctionBody(blockStmt, fnCtx) {
    const out = [];
    if (!blockStmt) return out;

    this.pushScope(fnCtx);
    for (const stmt of blockStmt.stmts || []) {
      this.lowerStmtInto(stmt, fnCtx, out);
    }

    if (blockStmt.tailExpr) {
      if (this.debug && blockStmt.tailExpr.span) {
        out.push({
          op: "debug_loc",
          line: blockStmt.tailExpr.span.startLine || 1,
          col: blockStmt.tailExpr.span.startCol || 1,
          span: blockStmt.tailExpr.span,
        });
      }
      if (
        fnCtx.returnType === "void" &&
        blockStmt.tailExpr.kind === "IfExpr"
      ) {
        this.lowerIfExprAsStmtInto(blockStmt.tailExpr, fnCtx, out);
      } else {
        const tailLir = this.lowerExpr(blockStmt.tailExpr, fnCtx);
        if (fnCtx.returnType === "void" || tailLir.type === "void") {
          out.push({
            op: "expr",
            expr: tailLir,
            span: blockStmt.tailExpr.span,
          });
        } else {
          out.push({
            op: "return",
            value: tailLir,
            span: blockStmt.tailExpr.span,
          });
        }
      }
    }
    this.popScope(fnCtx);

    return out;
  }

  lowerBlockStmts(blockStmt, fnCtx) {
    const out = [];
    if (!blockStmt) return out;
    this.pushScope(fnCtx);
    for (const stmt of blockStmt.stmts || []) {
      this.lowerStmtInto(stmt, fnCtx, out);
    }
    if (blockStmt.tailExpr) {
      if (this.debug && blockStmt.tailExpr.span) {
        out.push({
          op: "debug_loc",
          line: blockStmt.tailExpr.span.startLine || 1,
          col: blockStmt.tailExpr.span.startCol || 1,
          span: blockStmt.tailExpr.span,
        });
      }
      if (blockStmt.tailExpr.kind === "IfExpr") {
        this.lowerIfExprAsStmtInto(blockStmt.tailExpr, fnCtx, out);
      } else {
        const tailLir = this.lowerExpr(blockStmt.tailExpr, fnCtx);
        out.push({
          op: "expr",
          expr: tailLir,
          span: blockStmt.tailExpr.span,
        });
      }
    }
    this.popScope(fnCtx);
    return out;
  }

  lowerIfExprAsStmtInto(ifExpr, fnCtx, out) {
    const condLir = this.lowerExpr(ifExpr.cond, fnCtx);
    const thenBody = this.lowerBlockStmts(ifExpr.thenBlock, fnCtx);
    const elseBody = ifExpr.elseBlock
      ? this.lowerBlockStmts(ifExpr.elseBlock, fnCtx)
      : [];
    out.push({
      op: "if",
      cond: condLir,
      thenBody,
      elseBody,
      span: ifExpr.span,
    });
  }

  lowerStmtInto(stmt, fnCtx, out) {
    if (!stmt) return;

    if (this.debug && stmt.span) {
      out.push({
        op: "debug_loc",
        line: stmt.span.startLine || 1,
        col: stmt.span.startCol || 1,
        span: stmt.span,
      });
    }

    switch (stmt.kind) {
      case "ExprStmt": {
        if (stmt.expr && stmt.expr.kind === "IfExpr") {
          this.lowerIfExprAsStmtInto(stmt.expr, fnCtx, out);
          break;
        }
        const exprLir = this.lowerExpr(stmt.expr, fnCtx);
        out.push({
          op: "expr",
          expr: exprLir,
          span: stmt.span,
        });
        break;
      }

      case "LetStmt": {
        const initLir = this.lowerExpr(stmt.init, fnCtx);
        // Note: `infer.js` sets `stmt.resolvedType` to the variable's type and `stmt.inferredType` to `Types.VOID`.
        const semType =
          stmt.resolvedType ||
          (stmt.inferredType &&
          !(stmt.inferredType.tag === "prim" && stmt.inferredType.name === "void")
            ? stmt.inferredType
            : null) ||
          stmt.init?.inferredType ||
          null;
        const varType = semType
          ? semanticTypeToLirType(semType)
          : stmt.typeAnn
            ? this.resolveLirType(stmt.typeAnn)
            : initLir.type;
        const isBool = semType
          ? this.isBoolType(semType)
          : stmt.typeAnn
            ? this.isBoolType(stmt.typeAnn)
            : this.isBoolAstExpr(stmt.init, fnCtx);

        const localDesc = this.allocLocal(fnCtx, stmt.name, varType, isBool);
        this.defineVar(fnCtx, stmt.name, localDesc);
        out.push({
          op: "local_set",
          localId: localDesc.localId,
          value: initLir,
          span: stmt.span,
        });
        break;
      }

      case "AssignStmt": {
        if (stmt.target.kind === "IdentExpr") {
          const localDesc = this.lookupVar(fnCtx, stmt.target.name);
          if (!localDesc) {
            throw new Error(
              `Unknown variable '${stmt.target.name}' in assignment`
            );
          }
          const rhsLir = this.lowerExpr(stmt.value, fnCtx);
          let finalValue = rhsLir;
          if (stmt.op && stmt.op !== "=") {
            const lhsGet = {
              op: "local_get",
              localId: localDesc.localId,
              type: localDesc.type,
            };
            if (stmt.op === "+=" && localDesc.type === "gc_ref") {
              finalValue = {
                op: "call_builtin",
                builtin: "str_concat",
                args: [lhsGet, rhsLir],
                type: "gc_ref",
              };
            } else {
              const binOpMap = {
                "+=": "add",
                "-=": "sub",
                "*=": "mul",
                "/=": localDesc.type === "f64" ? "div" : "div_s",
                "%=": "rem_s",
              };
              const kind = binOpMap[stmt.op] || "add";
              finalValue = {
                op: "binop",
                kind,
                left: lhsGet,
                right: rhsLir,
                type: localDesc.type,
              };
            }
          }
          out.push({
            op: "local_set",
            localId: localDesc.localId,
            value: finalValue,
            span: stmt.span,
          });
        } else if (stmt.target.kind === "FieldExpr") {
          const objLir = this.lowerExpr(stmt.target.object, fnCtx);
          const rhsLir = this.lowerExpr(stmt.value, fnCtx);
          const objLocal = this.allocTempLocal(fnCtx, "gc_ref", "$obj");
          const valLirType = this.inferExprLirType(stmt.value, fnCtx);
          const valLocal = this.allocTempLocal(fnCtx, valLirType, "$val");
          out.push({ op: "local_set", localId: objLocal.localId, value: objLir });
          out.push({ op: "local_set", localId: valLocal.localId, value: rhsLir });

          let fieldIndex = stmt.target.fieldIndex;
          if (fieldIndex === undefined) {
            const objType = unwrapType(stmt.target.object.inferredType);
            if (objType && objType.tag === "struct" && this.env) {
              const def = this.env.getStruct(objType.name);
              if (def) fieldIndex = def.fields.findIndex((f) => f.name === stmt.target.field);
            }
          }
          const offset = 8 + 8 * (fieldIndex !== undefined && fieldIndex >= 0 ? fieldIndex : 0);
          out.push({
            op: "mem_store",
            ptr: { op: "local_get", localId: objLocal.localId, type: "gc_ref" },
            offset,
            value: { op: "local_get", localId: valLocal.localId, type: valLirType },
            storeType: valLirType,
          });
        } else if (stmt.target.kind === "IndexExpr") {
          const arrLir = this.lowerExpr(stmt.target.object, fnCtx);
          const idxLir = this.lowerExpr(stmt.target.index, fnCtx);
          const rhsLir = this.lowerExpr(stmt.value, fnCtx);
          const arrLocal = this.allocTempLocal(fnCtx, "gc_ref", "$arr");
          const idxLocal = this.allocTempLocal(fnCtx, "i32", "$idx");
          const valLirType = this.inferExprLirType(stmt.value, fnCtx);
          const valLocal = this.allocTempLocal(fnCtx, valLirType, "$val");

          out.push({ op: "local_set", localId: arrLocal.localId, value: arrLir });
          out.push({ op: "local_set", localId: idxLocal.localId, value: idxLir });
          out.push({ op: "local_set", localId: valLocal.localId, value: rhsLir });

          // Bounds check
          const lenLocal = this.allocTempLocal(fnCtx, "i32", "$len");
          out.push({
            op: "local_set",
            localId: lenLocal.localId,
            value: {
              op: "mem_load",
              ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
              offset: 8,
              loadType: "i32",
              type: "i32",
            },
          });

          const isOob = {
            op: "binop",
            kind: "or",
            left: {
              op: "binop",
              kind: "lt_s",
              left: { op: "local_get", localId: idxLocal.localId, type: "i32" },
              right: { op: "const_i32", value: 0, type: "i32" },
              type: "i32",
            },
            right: {
              op: "binop",
              kind: "ge_s",
              left: { op: "local_get", localId: idxLocal.localId, type: "i32" },
              right: { op: "local_get", localId: lenLocal.localId, type: "i32" },
              type: "i32",
            },
            type: "i32",
          };

          out.push({
            op: "if",
            cond: isOob,
            thenBody: [
              {
                op: "expr",
                expr: {
                  op: "call_builtin",
                  builtin: "trap",
                  args: [{ op: "const_i32", value: 3, type: "i32" }],
                  type: "void",
                },
              },
            ],
            elseBody: [],
          });

          // Load buffer at +16
          const bufLocal = this.allocTempLocal(fnCtx, "gc_ref", "$buf");
          out.push({
            op: "local_set",
            localId: bufLocal.localId,
            value: {
              op: "mem_load",
              ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
              offset: 16,
              loadType: "gc_ref",
              type: "gc_ref",
            },
          });

          const effectivePtr = {
            op: "binop",
            kind: "add",
            left: { op: "local_get", localId: bufLocal.localId, type: "gc_ref" },
            right: {
              op: "binop",
              kind: "mul",
              left: { op: "local_get", localId: idxLocal.localId, type: "i32" },
              right: { op: "const_i32", value: 8, type: "i32" },
              type: "i32",
            },
            type: "i32",
          };

          out.push({
            op: "mem_store",
            ptr: effectivePtr,
            offset: 8,
            value: { op: "local_get", localId: valLocal.localId, type: valLirType },
            storeType: valLirType,
          });
        }
        break;
      }

      case "ReturnStmt": {
        const valLir = stmt.value ? this.lowerExpr(stmt.value, fnCtx) : null;
        out.push({
          op: "return",
          value: valLir,
          span: stmt.span,
        });
        break;
      }

      case "IfStmt": {
        const condLir = this.lowerExpr(stmt.cond, fnCtx);
        const thenBody = this.lowerBlockStmts(stmt.thenBranch, fnCtx);
        let elseBody = [];
        if (stmt.elseBranch) {
          if (stmt.elseBranch.kind === "IfStmt") {
            this.lowerStmtInto(stmt.elseBranch, fnCtx, elseBody);
          } else {
            elseBody = this.lowerBlockStmts(stmt.elseBranch, fnCtx);
          }
        }
        out.push({
          op: "if",
          cond: condLir,
          thenBody,
          elseBody,
          span: stmt.span,
        });
        break;
      }

      case "WhileStmt": {
        const labelId = fnCtx.nextLabelId++;
        const breakLabel = `$while_break_${labelId}`;
        const continueLabel = `$while_cont_${labelId}`;
        fnCtx.loopLabels.push({ breakLabel, continueLabel });

        const condLir = this.lowerExpr(stmt.cond, fnCtx);
        const negatedCond = {
          op: "unop",
          kind: "eqz",
          operand: condLir,
          type: "i32",
        };
        const bodyStmts = this.lowerBlockStmts(stmt.body, fnCtx);
        fnCtx.loopLabels.pop();

        out.push({
          op: "block",
          label: breakLabel,
          body: [
            {
              op: "loop",
              label: continueLabel,
              body: [
                {
                  op: "br_if",
                  label: breakLabel,
                  cond: negatedCond,
                  span: stmt.cond.span,
                },
                ...bodyStmts,
                {
                  op: "br",
                  label: continueLabel,
                  span: stmt.span,
                },
              ],
              span: stmt.span,
            },
          ],
          span: stmt.span,
        });
        break;
      }

      case "ForStmt": {
        const iterVarName = stmt.iteratorVar || stmt.varName || stmt.name || "i";
        const iterable = stmt.iterable;
        const isRange =
          iterable &&
          (iterable.kind === "RangeExpr" ||
            (iterable.kind === "BinaryExpr" && iterable.op === ".."));

        if (isRange) {
          const startAst = iterable.start || iterable.left;
          const endAst = iterable.end || iterable.right;
          const startLir = this.lowerExpr(startAst, fnCtx);
          const endLir = this.lowerExpr(endAst, fnCtx);
          const iterType = startLir.type === "i64" ? "i64" : "i32";

          this.pushScope(fnCtx);
          const iterLocal = this.allocLocal(fnCtx, iterVarName, iterType, false);
          this.defineVar(fnCtx, iterVarName, iterLocal);
          const endLocal = this.allocTempLocal(fnCtx, iterType, "$for_end");

          // Initialize `iterLocal = start` and `endLocal = end` before loop
          out.push({
            op: "local_set",
            localId: iterLocal.localId,
            value: startLir,
            span: startAst?.span || stmt.span,
          });
          out.push({
            op: "local_set",
            localId: endLocal.localId,
            value: endLir,
            span: endAst?.span || stmt.span,
          });

          const labelId = fnCtx.nextLabelId++;
          const breakLabel = `$for_break_${labelId}`;
          const loopLabel = `$for_loop_${labelId}`;
          const continueLabel = `$for_cont_${labelId}`;

          fnCtx.loopLabels.push({ breakLabel, continueLabel });
          const bodyStmts = this.lowerBlockStmts(stmt.body, fnCtx);
          fnCtx.loopLabels.pop();
          this.popScope(fnCtx);

          const stepConst =
            iterType === "i64"
              ? { op: "const_i64", value: 1n, type: "i64" }
              : { op: "const_i32", value: 1, type: "i32" };

          out.push({
            op: "block",
            label: breakLabel,
            body: [
              {
                op: "loop",
                label: loopLabel,
                body: [
                  {
                    op: "br_if",
                    label: breakLabel,
                    cond: {
                      op: "binop",
                      kind: "ge_s",
                      left: {
                        op: "local_get",
                        localId: iterLocal.localId,
                        type: iterType,
                      },
                      right: {
                        op: "local_get",
                        localId: endLocal.localId,
                        type: iterType,
                      },
                      type: "i32",
                    },
                    span: iterable.span || stmt.span,
                  },
                  // Inner block `$for_cont_N` so `continue;` exits this block and still runs `i = i + 1; br $for_loop_N`!
                  {
                    op: "block",
                    label: continueLabel,
                    body: bodyStmts,
                    span: stmt.body?.span || stmt.span,
                  },
                  {
                    op: "local_set",
                    localId: iterLocal.localId,
                    value: {
                      op: "binop",
                      kind: "add",
                      left: {
                        op: "local_get",
                        localId: iterLocal.localId,
                        type: iterType,
                      },
                      right: stepConst,
                      type: iterType,
                    },
                    span: stmt.span,
                  },
                  {
                    op: "br",
                    label: loopLabel,
                    span: stmt.span,
                  },
                ],
                span: stmt.span,
              },
            ],
            span: stmt.span,
          });
        }
        break;
      }

      case "BreakStmt": {
        const top = fnCtx.loopLabels[fnCtx.loopLabels.length - 1];
        if (top) {
          out.push({
            op: "br",
            label: top.breakLabel,
            span: stmt.span,
          });
        }
        break;
      }

      case "ContinueStmt": {
        const top = fnCtx.loopLabels[fnCtx.loopLabels.length - 1];
        if (top) {
          out.push({
            op: "br",
            label: top.continueLabel,
            span: stmt.span,
          });
        }
        break;
      }

      case "BlockStmt": {
        const inner = this.lowerBlockStmts(stmt, fnCtx);
        out.push(...inner);
        break;
      }

      default:
        break;
    }
  }

  inferExprLirType(expr, fnCtx) {
    if (!expr) return "void";
    if (expr.inferredType) {
      const t = unwrapType(expr.inferredType);
      if (t && t.tag !== "error") {
        return semanticTypeToLirType(t);
      }
    }
    switch (expr.kind) {
      case "LiteralExpr":
        return this.resolveLirType(expr.literalType);
      case "IdentExpr": {
        if (fnCtx) {
          const local = this.lookupVar(fnCtx, expr.name);
          if (local) return local.type;
        }
        const glob = this.globalMap.get(expr.name);
        if (glob) return glob.type;
        return "i32";
      }
      case "UnaryExpr": {
        if (expr.op === "!") return "i32";
        return this.inferExprLirType(expr.operand, fnCtx);
      }
      case "BinaryExpr": {
        if (COMPARISON_AND_LOGICAL_OPS.has(expr.op)) {
          return "i32";
        }
        return this.inferExprLirType(expr.left, fnCtx);
      }
      case "CastExpr":
        return this.resolveLirType(expr.targetType);
      case "IfExpr": {
        if (expr.thenBlock && expr.thenBlock.tailExpr) {
          return this.inferExprLirType(expr.thenBlock.tailExpr, fnCtx);
        }
        if (expr.elseBlock && expr.elseBlock.tailExpr) {
          return this.inferExprLirType(expr.elseBlock.tailExpr, fnCtx);
        }
        return "void";
      }
      case "BlockExpr": {
        if (expr.block && expr.block.tailExpr) {
          return this.inferExprLirType(expr.block.tailExpr, fnCtx);
        }
        return "void";
      }
      case "CallExpr": {
        if (expr.callee.kind === "IdentExpr") {
          const name = expr.callee.name;
          if (
            Object.prototype.hasOwnProperty.call(BUILTIN_RETURN_LIR_TYPES, name)
          ) {
            return BUILTIN_RETURN_LIR_TYPES[name];
          }
          if (this.functionReturnTypes.has(name)) {
            return this.functionReturnTypes.get(name);
          }
          if (this.env && this.env.getFunction) {
            const fnDef = this.env.getFunction(name);
            if (fnDef && fnDef.returnType) {
              return semanticTypeToLirType(fnDef.returnType);
            }
          }
        }
        return "void";
      }
      case "StructLitExpr":
      case "EnumInitExpr":
      case "ArrayLitExpr":
        return "gc_ref";
      case "FieldExpr":
      case "IndexExpr":
      case "MatchExpr":
      case "MatchStmt":
        return expr.inferredType ? semanticTypeToLirType(expr.inferredType) : "i32";
      default:
        return "i32";
    }
  }

  /**
   * Format an argument to `print` or `println`: if the AST argument has semantic type `bool`,
   * wrap it in `bool_to_string` so Wasm prints `"true"` / `"false"` rather than `1` / `0`.
   */
  preparePrintArg(astArg, loweredArg, fnCtx) {
    if (this.isBoolAstExpr(astArg, fnCtx) && loweredArg.type === "i32") {
      return {
        op: "call_builtin",
        builtin: "bool_to_string",
        args: [loweredArg],
        type: "gc_ref",
      };
    }
    return loweredArg;
  }

  lowerExpr(expr, fnCtx) {
    if (!expr) {
      return { op: "const_i32", value: 0, type: "i32" };
    }

    switch (expr.kind) {
      case "LiteralExpr": {
        switch (expr.literalType) {
          case "string": {
            const stringId = this.internString(expr.value);
            return {
              op: "const_string",
              stringId,
              value: String(expr.value ?? ""),
              type: "gc_ref",
            };
          }
          case "i32":
            return {
              op: "const_i32",
              value: Number(expr.value) | 0,
              type: "i32",
            };
          case "i64":
            return {
              op: "const_i64",
              value:
                typeof expr.value === "bigint"
                  ? expr.value
                  : BigInt(expr.value || 0),
              type: "i64",
            };
          case "f64":
            return {
              op: "const_f64",
              value: Number(expr.value),
              type: "f64",
            };
          case "bool":
            return {
              op: "const_i32",
              value: expr.value ? 1 : 0,
              type: "i32",
            };
          case "void":
          default:
            return {
              op: "const_i32",
              value: 0,
              type: "i32",
            };
        }
      }

      case "IdentExpr": {
        const localDesc = fnCtx ? this.lookupVar(fnCtx, expr.name) : null;
        if (localDesc) {
          return {
            op: "local_get",
            localId: localDesc.localId,
            type: localDesc.type,
          };
        }
        const glob = this.globalMap.get(expr.name);
        if (glob && glob.decl && glob.decl.init) {
          return this.lowerExpr(glob.decl.init, fnCtx);
        }
        return {
          op: "global_get",
          name: expr.name,
          type: this.inferExprLirType(expr, fnCtx),
        };
      }

      case "CallExpr": {
        const astArgs = expr.args || [];
        const rawArgs = astArgs.map((a) => this.lowerExpr(a, fnCtx));

        if (expr.callee.kind === "IdentExpr") {
          const fnName = expr.callee.name;

          if (BUILTIN_NAMES.has(fnName)) {
            if (fnName === "print" || fnName === "println") {
              if (rawArgs.length === 0) {
                const emptyId = this.internString("");
                return {
                  op: "call_builtin",
                  builtin: fnName,
                  args: [
                    {
                      op: "const_string",
                      stringId: emptyId,
                      value: "",
                      type: "gc_ref",
                    },
                  ],
                  type: "void",
                };
              }
              const formattedArgs = rawArgs.map((argLir, idx) =>
                this.preparePrintArg(astArgs[idx], argLir, fnCtx)
              );
              if (formattedArgs.length === 1) {
                return {
                  op: "call_builtin",
                  builtin: fnName,
                  args: formattedArgs,
                  type: "void",
                };
              }
              // Multi-argument `print(a, b, ...)` / `println(a, b, ...)`
              const prefixStmts = [];
              for (let i = 0; i < formattedArgs.length - 1; i++) {
                prefixStmts.push({
                  op: "expr",
                  expr: {
                    op: "call_builtin",
                    builtin: "print",
                    args: [formattedArgs[i]],
                    type: "void",
                  },
                });
              }
              return {
                op: "seq",
                stmts: prefixStmts,
                result: {
                  op: "call_builtin",
                  builtin: fnName,
                  args: [formattedArgs[formattedArgs.length - 1]],
                  type: "void",
                },
                type: "void",
              };
            }

            if (fnName === "array_len") {
              const arrLir = rawArgs[0];
              const rootedArr = this.ensureRootedGcExpr(arrLir, fnCtx);
              return {
                op: "mem_load",
                ptr: rootedArr,
                offset: 8,
                loadType: "i32",
                type: "i32",
              };
            }

            if (fnName === "array_push") {
              const stmts = [];
              const arrLocal = this.allocTempLocal(fnCtx, "gc_ref", "$arr");
              const valLirType = rawArgs[1].type || "i32";
              const valLocal = this.allocTempLocal(fnCtx, valLirType, "$val");
              stmts.push({ op: "local_set", localId: arrLocal.localId, value: rawArgs[0] });
              stmts.push({ op: "local_set", localId: valLocal.localId, value: rawArgs[1] });

              const lenLocal = this.allocTempLocal(fnCtx, "i32", "$len");
              const capLocal = this.allocTempLocal(fnCtx, "i32", "$cap");
              stmts.push({
                op: "local_set",
                localId: lenLocal.localId,
                value: {
                  op: "mem_load",
                  ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
                  offset: 8,
                  loadType: "i32",
                  type: "i32",
                },
              });
              stmts.push({
                op: "local_set",
                localId: capLocal.localId,
                value: {
                  op: "mem_load",
                  ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
                  offset: 12,
                  loadType: "i32",
                  type: "i32",
                },
              });

              // if len >= cap: grow_array
              const needsGrow = {
                op: "binop",
                kind: "ge_s",
                left: { op: "local_get", localId: lenLocal.localId, type: "i32" },
                right: { op: "local_get", localId: capLocal.localId, type: "i32" },
                type: "i32",
              };
              stmts.push({
                op: "if",
                cond: needsGrow,
                thenBody: [
                  {
                    op: "expr",
                    expr: {
                      op: "call_builtin",
                      builtin: "grow_array",
                      args: [
                        { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
                        {
                          op: "binop",
                          kind: "add",
                          left: { op: "local_get", localId: lenLocal.localId, type: "i32" },
                          right: { op: "const_i32", value: 1, type: "i32" },
                          type: "i32",
                        },
                      ],
                      type: "gc_ref",
                    },
                  },
                ],
                elseBody: [],
              });

              // buf = arr + 16
              const bufLocal = this.allocTempLocal(fnCtx, "gc_ref", "$buf");
              stmts.push({
                op: "local_set",
                localId: bufLocal.localId,
                value: {
                  op: "mem_load",
                  ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
                  offset: 16,
                  loadType: "gc_ref",
                  type: "gc_ref",
                },
              });

              // mem_store val into buf + 8 + 8 * len
              const effectivePtr = {
                op: "binop",
                kind: "add",
                left: { op: "local_get", localId: bufLocal.localId, type: "gc_ref" },
                right: {
                  op: "binop",
                  kind: "mul",
                  left: { op: "local_get", localId: lenLocal.localId, type: "i32" },
                  right: { op: "const_i32", value: 8, type: "i32" },
                  type: "i32",
                },
                type: "i32",
              };
              stmts.push({
                op: "mem_store",
                ptr: effectivePtr,
                offset: 8,
                value: { op: "local_get", localId: valLocal.localId, type: valLirType },
                storeType: valLirType,
              });

              // len = len + 1
              stmts.push({
                op: "mem_store",
                ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
                offset: 8,
                value: {
                  op: "binop",
                  kind: "add",
                  left: { op: "local_get", localId: lenLocal.localId, type: "i32" },
                  right: { op: "const_i32", value: 1, type: "i32" },
                  type: "i32",
                },
                storeType: "i32",
              });

              return {
                op: "seq",
                stmts,
                result: { op: "const_i32", value: 0, type: "void" },
                type: "void",
              };
            }

            if (fnName === "array_pop") {
              const stmts = [];
              const arrLocal = this.allocTempLocal(fnCtx, "gc_ref", "$arr");
              stmts.push({ op: "local_set", localId: arrLocal.localId, value: rawArgs[0] });

              const lenLocal = this.allocTempLocal(fnCtx, "i32", "$len");
              stmts.push({
                op: "local_set",
                localId: lenLocal.localId,
                value: {
                  op: "mem_load",
                  ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
                  offset: 8,
                  loadType: "i32",
                  type: "i32",
                },
              });

              // if len <= 0: trap(7) ("pop from empty array")
              const isEmpty = {
                op: "binop",
                kind: "le_s",
                left: { op: "local_get", localId: lenLocal.localId, type: "i32" },
                right: { op: "const_i32", value: 0, type: "i32" },
                type: "i32",
              };
              stmts.push({
                op: "if",
                cond: isEmpty,
                thenBody: [
                  {
                    op: "expr",
                    expr: {
                      op: "call_builtin",
                      builtin: "trap",
                      args: [{ op: "const_i32", value: 7, type: "i32" }],
                      type: "void",
                    },
                  },
                ],
                elseBody: [],
              });

              // newLen = len - 1
              const newLenLocal = this.allocTempLocal(fnCtx, "i32", "$new_len");
              stmts.push({
                op: "local_set",
                localId: newLenLocal.localId,
                value: {
                  op: "binop",
                  kind: "sub",
                  left: { op: "local_get", localId: lenLocal.localId, type: "i32" },
                  right: { op: "const_i32", value: 1, type: "i32" },
                  type: "i32",
                },
              });

              // Store newLen at arr + 8
              stmts.push({
                op: "mem_store",
                ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
                offset: 8,
                value: { op: "local_get", localId: newLenLocal.localId, type: "i32" },
                storeType: "i32",
              });

              // buf = arr + 16
              const bufLocal = this.allocTempLocal(fnCtx, "gc_ref", "$buf");
              stmts.push({
                op: "local_set",
                localId: bufLocal.localId,
                value: {
                  op: "mem_load",
                  ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
                  offset: 16,
                  loadType: "gc_ref",
                  type: "gc_ref",
                },
              });

              const elemLirType = this.inferExprLirType(expr, fnCtx);
              const effectivePtr = {
                op: "binop",
                kind: "add",
                left: { op: "local_get", localId: bufLocal.localId, type: "gc_ref" },
                right: {
                  op: "binop",
                  kind: "mul",
                  left: { op: "local_get", localId: newLenLocal.localId, type: "i32" },
                  right: { op: "const_i32", value: 8, type: "i32" },
                  type: "i32",
                },
                type: "i32",
              };

              const resLocal = this.allocTempLocal(fnCtx, elemLirType, "$popped");
              stmts.push({
                op: "local_set",
                localId: resLocal.localId,
                value: {
                  op: "mem_load",
                  ptr: effectivePtr,
                  offset: 8,
                  loadType: elemLirType,
                  type: elemLirType,
                },
              });

              return {
                op: "seq",
                stmts,
                result: { op: "local_get", localId: resLocal.localId, type: elemLirType },
                type: elemLirType,
              };
            }

            if (fnName === "array_new") {
              return this.lowerExpr(
                { kind: "ArrayLitExpr", elements: [], inferredType: expr.inferredType },
                fnCtx
              );
            }

            const safeArgs = this.stabilizeExprListForGc(rawArgs, fnCtx);
            const retType = this.inferExprLirType(expr, fnCtx);
            return {
              op: "call_builtin",
              builtin: fnName,
              args: safeArgs,
              type: retType,
            };
          }

          const safeArgs = this.stabilizeExprListForGc(rawArgs, fnCtx);
          const retType = this.inferExprLirType(expr, fnCtx);
          return {
            op: "call",
            funcName: fnName,
            args: safeArgs,
            type: retType,
          };
        }

        const safeArgs = this.stabilizeExprListForGc(rawArgs, fnCtx);
        const retType = this.inferExprLirType(expr, fnCtx);
        return {
          op: "call",
          funcName: "unknown",
          args: safeArgs,
          type: retType,
        };
      }

      case "BinaryExpr": {
        // Short-circuit logical `&&` and `||` via `if_expr`
        if (expr.op === "&&") {
          const cond = this.lowerExpr(expr.left, fnCtx);
          const right = this.lowerExpr(expr.right, fnCtx);
          return {
            op: "if_expr",
            cond,
            thenStmts: [],
            thenExpr: right,
            elseStmts: [],
            elseExpr: { op: "const_i32", value: 0, type: "i32" },
            type: "i32",
          };
        }
        if (expr.op === "||") {
          const cond = this.lowerExpr(expr.left, fnCtx);
          const right = this.lowerExpr(expr.right, fnCtx);
          return {
            op: "if_expr",
            cond,
            thenStmts: [],
            thenExpr: { op: "const_i32", value: 1, type: "i32" },
            elseStmts: [],
            elseExpr: right,
            type: "i32",
          };
        }

        const leftRaw = this.lowerExpr(expr.left, fnCtx);
        const rightRaw = this.lowerExpr(expr.right, fnCtx);
        let [left, right] = this.stabilizeExprListForGc(
          [leftRaw, rightRaw],
          fnCtx
        );

        // String concatenation and equality
        const leftSem = unwrapType(expr.left.inferredType);
        if (
          (leftSem && leftSem.tag === "prim" && leftSem.name === "string") ||
          left.type === "gc_ref"
        ) {
          if (expr.op === "+") {
            return {
              op: "call_builtin",
              builtin: "str_concat",
              args: [left, right],
              type: "gc_ref",
            };
          }
          if (expr.op === "==") {
            return {
              op: "call_builtin",
              builtin: "str_eq",
              args: [left, right],
              type: "i32",
            };
          }
          if (expr.op === "!=") {
            return {
              op: "unop",
              kind: "eqz",
              operand: {
                op: "call_builtin",
                builtin: "str_eq",
                args: [left, right],
                type: "i32",
              },
              type: "i32",
            };
          }
        }

        // Ensure i64 shift counts match i64 operand type if needed
        if (
          (expr.op === "<<" || expr.op === ">>") &&
          left.type === "i64" &&
          right.type === "i32"
        ) {
          right = {
            op: "conv",
            kind: "i32_to_i64",
            operand: right,
            type: "i64",
          };
        }

        const opMap = {
          "+": "add",
          "-": "sub",
          "*": "mul",
          "/": left.type === "f64" ? "div" : "div_s",
          "%": "rem_s",
          "==": "eq",
          "!=": "ne",
          "<": left.type === "f64" ? "lt" : "lt_s",
          "<=": left.type === "f64" ? "le" : "le_s",
          ">": left.type === "f64" ? "gt" : "gt_s",
          ">=": left.type === "f64" ? "ge" : "ge_s",
          "&": "and",
          "|": "or",
          "^": "xor",
          "<<": "shl",
          ">>": "shr_s",
        };
        const resultType = COMPARISON_AND_LOGICAL_OPS.has(expr.op)
          ? "i32"
          : left.type;
        return {
          op: "binop",
          kind: opMap[expr.op] || expr.op,
          left,
          right,
          type: resultType,
        };
      }

      case "UnaryExpr": {
        const operand = this.lowerExpr(expr.operand, fnCtx);
        if (expr.op === "!") {
          return {
            op: "unop",
            kind: "eqz",
            operand,
            type: "i32",
          };
        }
        if (expr.op === "-") {
          if (operand.type === "f64") {
            return {
              op: "unop",
              kind: "neg",
              operand,
              type: "f64",
            };
          }
          const zero =
            operand.type === "i64"
              ? { op: "const_i64", value: 0n, type: "i64" }
              : { op: "const_i32", value: 0, type: "i32" };
          return {
            op: "binop",
            kind: "sub",
            left: zero,
            right: operand,
            type: operand.type,
          };
        }
        if (expr.op === "~") {
          const allOnes =
            operand.type === "i64"
              ? { op: "const_i64", value: -1n, type: "i64" }
              : { op: "const_i32", value: -1, type: "i32" };
          return {
            op: "binop",
            kind: "xor",
            left: operand,
            right: allOnes,
            type: operand.type,
          };
        }
        return operand;
      }

      case "CastExpr": {
        const operand = this.lowerExpr(expr.expr, fnCtx);
        const srcType = operand.type;
        const dstType = this.resolveLirType(expr.targetType);

        if (srcType === dstType) {
          // If casting integer to bool (`x as bool`), normalize non-zero to 1
          if (
            this.isBoolType(expr.targetType) &&
            !this.isBoolAstExpr(expr.expr, fnCtx)
          ) {
            return {
              op: "binop",
              kind: "ne",
              left: operand,
              right: { op: "const_i32", value: 0, type: "i32" },
              type: "i32",
            };
          }
          return operand;
        }

        const convKey = `${srcType}_to_${dstType}`;
        const validConvKinds = new Set([
          "i32_to_i64",
          "i64_to_i32",
          "i32_to_f64",
          "i64_to_f64",
          "f64_to_i32",
          "f64_to_i64",
        ]);
        if (validConvKinds.has(convKey)) {
          return {
            op: "conv",
            kind: convKey,
            operand,
            type: dstType,
          };
        }
        return operand;
      }

      case "BlockExpr": {
        const stmts = [];
        this.pushScope(fnCtx);
        for (const s of expr.block.stmts || []) {
          this.lowerStmtInto(s, fnCtx, stmts);
        }
        const resultType = this.inferExprLirType(expr, fnCtx);
        const result = expr.block.tailExpr
          ? this.lowerExpr(expr.block.tailExpr, fnCtx)
          : defaultConstForLirType(resultType);
        this.popScope(fnCtx);
        if (stmts.length === 0) return result;
        return {
          op: "seq",
          stmts,
          result,
          type: result.type,
        };
      }

      case "IfExpr": {
        const resultType = this.inferExprLirType(expr, fnCtx);
        if (resultType === "void") {
          const stmts = [];
          this.lowerIfExprAsStmtInto(expr, fnCtx, stmts);
          return {
            op: "seq",
            stmts,
            result: { op: "const_i32", value: 0, type: "i32" },
            type: "i32",
          };
        }

        const cond = this.lowerExpr(expr.cond, fnCtx);
        const thenStmts = [];
        this.pushScope(fnCtx);
        for (const s of expr.thenBlock.stmts || []) {
          this.lowerStmtInto(s, fnCtx, thenStmts);
        }
        const thenExpr = expr.thenBlock.tailExpr
          ? this.lowerExpr(expr.thenBlock.tailExpr, fnCtx)
          : defaultConstForLirType(resultType);
        this.popScope(fnCtx);

        const elseStmts = [];
        this.pushScope(fnCtx);
        for (const s of (expr.elseBlock && expr.elseBlock.stmts) || []) {
          this.lowerStmtInto(s, fnCtx, elseStmts);
        }
        const elseExpr =
          expr.elseBlock && expr.elseBlock.tailExpr
            ? this.lowerExpr(expr.elseBlock.tailExpr, fnCtx)
            : defaultConstForLirType(resultType);
        this.popScope(fnCtx);

        return {
          op: "if_expr",
          cond,
          thenStmts,
          thenExpr,
          elseStmts,
          elseExpr,
          type: resultType,
        };
      }

      case "StructLitExpr": {
        const stmts = [];
        const structName = expr.structName;
        const structDef = this.env ? this.env.getStruct(structName) : null;
        const fieldNodes = expr.fields || [];

        const orderedFieldValues = [];
        if (structDef && structDef.fields) {
          for (let i = 0; i < structDef.fields.length; i++) {
            const df = structDef.fields[i];
            const found = fieldNodes.find((f) => f.name === df.name);
            const valExpr = found
              ? found.value !== undefined
                ? found.value
                : found.expr
              : null;
            orderedFieldValues.push({
              name: df.name,
              astVal: valExpr,
              lirType: semanticTypeToLirType(df.type),
            });
          }
        } else {
          for (const f of fieldNodes) {
            orderedFieldValues.push({
              name: f.name,
              astVal: f.value !== undefined ? f.value : f.expr,
              lirType: this.inferExprLirType(f.value || f.expr, fnCtx),
            });
          }
        }

        // Rule 11 (Allocate-then-fill): evaluate field values into locals first!
        const fieldLocals = [];
        for (let i = 0; i < orderedFieldValues.length; i++) {
          const item = orderedFieldValues[i];
          const valLir = this.lowerExpr(item.astVal, fnCtx);
          const tmp = this.allocTempLocal(fnCtx, item.lirType, `$f_${item.name}`);
          stmts.push({ op: "local_set", localId: tmp.localId, value: valLir });
          fieldLocals.push({ ...item, local: tmp });
        }

        const payloadSize = orderedFieldValues.length * 8;
        const structPtrLocal = this.allocTempLocal(fnCtx, "gc_ref", "$struct");
        stmts.push({
          op: "local_set",
          localId: structPtrLocal.localId,
          value: {
            op: "gc_alloc",
            objKind: OBJ_KIND.STRUCT,
            typeDescId: 0,
            payloadSize: { op: "const_i32", value: payloadSize, type: "i32" },
            type: "gc_ref",
          },
        });

        for (let i = 0; i < fieldLocals.length; i++) {
          const fl = fieldLocals[i];
          stmts.push({
            op: "mem_store",
            ptr: { op: "local_get", localId: structPtrLocal.localId, type: "gc_ref" },
            offset: 8 + 8 * i,
            value: { op: "local_get", localId: fl.local.localId, type: fl.lirType },
            storeType: fl.lirType,
          });
        }

        return {
          op: "seq",
          stmts,
          result: {
            op: "local_get",
            localId: structPtrLocal.localId,
            type: "gc_ref",
          },
          type: "gc_ref",
        };
      }

      case "FieldExpr": {
        const objLir = this.lowerExpr(expr.object, fnCtx);
        const rootedObj = this.ensureRootedGcExpr(objLir, fnCtx);
        let fieldIndex = expr.fieldIndex;
        let fieldLirType = this.inferExprLirType(expr, fnCtx);
        if (fieldIndex === undefined) {
          const objType = unwrapType(expr.object.inferredType);
          if (objType && objType.tag === "struct" && this.env) {
            const def = this.env.getStruct(objType.name);
            if (def) {
              fieldIndex = def.fields.findIndex((f) => f.name === expr.field);
              if (fieldIndex !== -1) {
                fieldLirType = semanticTypeToLirType(def.fields[fieldIndex].type);
              }
            }
          }
        }
        const offset = 8 + 8 * (fieldIndex !== undefined && fieldIndex >= 0 ? fieldIndex : 0);
        return {
          op: "mem_load",
          ptr: rootedObj,
          offset,
          loadType: fieldLirType,
          type: fieldLirType,
        };
      }

      case "EnumInitExpr": {
        const stmts = [];
        const variantName = expr.variantName;
        let enumName = expr.enumName;
        let tagIndex = expr.tagIndex !== undefined ? expr.tagIndex : 0;
        let variantDef = null;

        if (this.env) {
          if (!enumName) {
            const vInfo = this.env.lookupVariant(variantName);
            if (vInfo) enumName = vInfo.enumName;
          }
          if (enumName) {
            const enumDef = this.env.getEnum(enumName);
            if (enumDef) {
              const v = enumDef.variants.find((item) => item.name === variantName);
              if (v) {
                tagIndex = v.tagIndex;
                variantDef = v;
              }
            }
          }
        }

        const args = expr.args || [];
        const argLocals = [];
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          const argLir = this.lowerExpr(arg, fnCtx);
          const lirType =
            variantDef && variantDef.fields && variantDef.fields[i]
              ? semanticTypeToLirType(variantDef.fields[i])
              : this.inferExprLirType(arg, fnCtx);
          const tmp = this.allocTempLocal(fnCtx, lirType, `$arg_${i}`);
          stmts.push({ op: "local_set", localId: tmp.localId, value: argLir });
          argLocals.push({ local: tmp, lirType });
        }

        const payloadSize = 8 + args.length * 8;
        const enumPtrLocal = this.allocTempLocal(fnCtx, "gc_ref", "$enum");
        stmts.push({
          op: "local_set",
          localId: enumPtrLocal.localId,
          value: {
            op: "gc_alloc",
            objKind: OBJ_KIND.ENUM,
            typeDescId: 0,
            payloadSize: { op: "const_i32", value: payloadSize, type: "i32" },
            type: "gc_ref",
          },
        });

        stmts.push({
          op: "mem_store",
          ptr: { op: "local_get", localId: enumPtrLocal.localId, type: "gc_ref" },
          offset: 8,
          value: { op: "const_i32", value: tagIndex, type: "i32" },
          storeType: "i32",
        });

        for (let i = 0; i < argLocals.length; i++) {
          const al = argLocals[i];
          stmts.push({
            op: "mem_store",
            ptr: { op: "local_get", localId: enumPtrLocal.localId, type: "gc_ref" },
            offset: 16 + 8 * i,
            value: { op: "local_get", localId: al.local.localId, type: al.lirType },
            storeType: al.lirType,
          });
        }

        return {
          op: "seq",
          stmts,
          result: { op: "local_get", localId: enumPtrLocal.localId, type: "gc_ref" },
          type: "gc_ref",
        };
      }

      case "ArrayLitExpr": {
        const stmts = [];
        const elements = expr.elements || [];
        let elemLirType = "i32";
        if (expr.inferredType) {
          const ty = unwrapType(expr.inferredType);
          if (ty && ty.tag === "array") {
            elemLirType = semanticTypeToLirType(ty.elem);
          }
        }

        const elemLocals = [];
        for (let i = 0; i < elements.length; i++) {
          const e = elements[i];
          const valLir = this.lowerExpr(e, fnCtx);
          const tmp = this.allocTempLocal(fnCtx, elemLirType, `$elem_${i}`);
          stmts.push({ op: "local_set", localId: tmp.localId, value: valLir });
          elemLocals.push(tmp);
        }

        const cap = Math.max(elements.length, 4);
        const bufPtrLocal = this.allocTempLocal(fnCtx, "gc_ref", "$buf");
        stmts.push({
          op: "local_set",
          localId: bufPtrLocal.localId,
          value: {
            op: "gc_alloc",
            objKind: OBJ_KIND.RAW_BUFFER,
            typeDescId: 0,
            payloadSize: { op: "const_i32", value: cap * 8, type: "i32" },
            type: "gc_ref",
          },
        });

        for (let i = 0; i < elemLocals.length; i++) {
          stmts.push({
            op: "mem_store",
            ptr: { op: "local_get", localId: bufPtrLocal.localId, type: "gc_ref" },
            offset: 8 + 8 * i,
            value: { op: "local_get", localId: elemLocals[i].localId, type: elemLirType },
            storeType: elemLirType,
          });
        }

        const arrPtrLocal = this.allocTempLocal(fnCtx, "gc_ref", "$arr");
        stmts.push({
          op: "local_set",
          localId: arrPtrLocal.localId,
          value: {
            op: "gc_alloc",
            objKind: OBJ_KIND.ARRAY,
            typeDescId: 0,
            payloadSize: { op: "const_i32", value: 16, type: "i32" },
            type: "gc_ref",
          },
        });

        stmts.push({
          op: "mem_store",
          ptr: { op: "local_get", localId: arrPtrLocal.localId, type: "gc_ref" },
          offset: 8,
          value: { op: "const_i32", value: elements.length, type: "i32" },
          storeType: "i32",
        });

        stmts.push({
          op: "mem_store",
          ptr: { op: "local_get", localId: arrPtrLocal.localId, type: "gc_ref" },
          offset: 12,
          value: { op: "const_i32", value: cap, type: "i32" },
          storeType: "i32",
        });

        stmts.push({
          op: "mem_store",
          ptr: { op: "local_get", localId: arrPtrLocal.localId, type: "gc_ref" },
          offset: 16,
          value: { op: "local_get", localId: bufPtrLocal.localId, type: "gc_ref" },
          storeType: "gc_ref",
        });

        return {
          op: "seq",
          stmts,
          result: { op: "local_get", localId: arrPtrLocal.localId, type: "gc_ref" },
          type: "gc_ref",
        };
      }

      case "IndexExpr": {
        const stmts = [];
        const arrLir = this.lowerExpr(expr.object, fnCtx);
        const idxLir = this.lowerExpr(expr.index, fnCtx);

        const arrLocal = this.allocTempLocal(fnCtx, "gc_ref", "$arr");
        const idxLocal = this.allocTempLocal(fnCtx, "i32", "$idx");
        stmts.push({ op: "local_set", localId: arrLocal.localId, value: arrLir });
        stmts.push({ op: "local_set", localId: idxLocal.localId, value: idxLir });

        const lenLocal = this.allocTempLocal(fnCtx, "i32", "$len");
        stmts.push({
          op: "local_set",
          localId: lenLocal.localId,
          value: {
            op: "mem_load",
            ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
            offset: 8,
            loadType: "i32",
            type: "i32",
          },
        });

        const isOob = {
          op: "binop",
          kind: "or",
          left: {
            op: "binop",
            kind: "lt_s",
            left: { op: "local_get", localId: idxLocal.localId, type: "i32" },
            right: { op: "const_i32", value: 0, type: "i32" },
            type: "i32",
          },
          right: {
            op: "binop",
            kind: "ge_s",
            left: { op: "local_get", localId: idxLocal.localId, type: "i32" },
            right: { op: "local_get", localId: lenLocal.localId, type: "i32" },
            type: "i32",
          },
          type: "i32",
        };

        stmts.push({
          op: "if",
          cond: isOob,
          thenBody: [
            {
              op: "expr",
              expr: {
                op: "call_builtin",
                builtin: "trap",
                args: [{ op: "const_i32", value: 3, type: "i32" }],
                type: "void",
              },
            },
          ],
          elseBody: [],
        });

        const bufLocal = this.allocTempLocal(fnCtx, "gc_ref", "$buf");
        stmts.push({
          op: "local_set",
          localId: bufLocal.localId,
          value: {
            op: "mem_load",
            ptr: { op: "local_get", localId: arrLocal.localId, type: "gc_ref" },
            offset: 16,
            loadType: "gc_ref",
            type: "gc_ref",
          },
        });

        let elemLirType = "i32";
        if (expr.inferredType) {
          elemLirType = semanticTypeToLirType(expr.inferredType);
        }

        const effectivePtr = {
          op: "binop",
          kind: "add",
          left: { op: "local_get", localId: bufLocal.localId, type: "gc_ref" },
          right: {
            op: "binop",
            kind: "mul",
            left: { op: "local_get", localId: idxLocal.localId, type: "i32" },
            right: { op: "const_i32", value: 8, type: "i32" },
            type: "i32",
          },
          type: "i32",
        };

        const resLocal = this.allocTempLocal(fnCtx, elemLirType, "$elem");
        stmts.push({
          op: "local_set",
          localId: resLocal.localId,
          value: {
            op: "mem_load",
            ptr: effectivePtr,
            offset: 8,
            loadType: elemLirType,
            type: elemLirType,
          },
        });

        return {
          op: "seq",
          stmts,
          result: { op: "local_get", localId: resLocal.localId, type: elemLirType },
          type: elemLirType,
        };
      }

      case "MatchExpr":
      case "MatchStmt": {
        const stmts = [];
        const scrutineeNode = expr.scrutinee || expr.expr;
        const scrutineeLir = this.lowerExpr(scrutineeNode, fnCtx);
        const scrutineeType = this.inferExprLirType(scrutineeNode, fnCtx);
        const scrutineeLocal = this.allocTempLocal(fnCtx, scrutineeType, "$scrutinee");
        stmts.push({
          op: "local_set",
          localId: scrutineeLocal.localId,
          value: scrutineeLir,
        });

        const resultType = this.inferExprLirType(expr, fnCtx);
        const isVoid = resultType === "void";
        const resultLocal = isVoid ? null : this.allocTempLocal(fnCtx, resultType, "$match_res");
        const arms = expr.arms || [];

        let currentElseBody = [];
        for (let i = 0; i < arms.length; i++) {
          const arm = arms[i];
          const bindStmts = [];
          this.pushScope(fnCtx);

          const patCond = this.lowerPatternMatch(
            arm.pattern,
            { op: "local_get", localId: scrutineeLocal.localId, type: scrutineeType },
            fnCtx,
            bindStmts
          );

          let fullCond = patCond;
          if (arm.guard) {
            const guardLir = this.lowerExpr(arm.guard, fnCtx);
            fullCond = {
              op: "if_expr",
              cond: patCond,
              thenStmts: bindStmts,
              thenExpr: guardLir,
              elseStmts: [],
              elseExpr: { op: "const_i32", value: 0, type: "i32" },
              type: "i32",
            };
          }

          const armStmts = [...bindStmts];

          if (arm.body) {
            if (arm.body.kind === "BlockExpr" || arm.body.kind === "BlockStmt") {
              const bodyStmts = this.lowerBlockStmts(arm.body.block || arm.body, fnCtx);
              armStmts.push(...bodyStmts);
              const tail = (arm.body.block || arm.body).tailExpr;
              if (tail) {
                const tailLir = this.lowerExpr(tail, fnCtx);
                if (!isVoid && resultLocal) {
                  armStmts.push({
                    op: "local_set",
                    localId: resultLocal.localId,
                    value: tailLir,
                  });
                } else {
                  armStmts.push({ op: "expr", expr: tailLir });
                }
              }
            } else {
              const bodyLir = this.lowerExpr(arm.body, fnCtx);
              if (!isVoid && resultLocal) {
                armStmts.push({
                  op: "local_set",
                  localId: resultLocal.localId,
                  value: bodyLir,
                });
              } else {
                armStmts.push({ op: "expr", expr: bodyLir });
              }
            }
          }

          this.popScope(fnCtx);

          const ifStmt = {
            op: "if",
            cond: fullCond,
            thenBody: armStmts,
            elseBody: [],
          };

          if (i === 0) {
            stmts.push(ifStmt);
          } else {
            currentElseBody.push(ifStmt);
          }
          currentElseBody = ifStmt.elseBody;
        }

        return {
          op: "seq",
          stmts,
          result: isVoid
            ? { op: "const_i32", value: 0, type: "void" }
            : {
                op: "local_get",
                localId: resultLocal.localId,
                type: resultType,
              },
          type: resultType,
        };
      }

      default:
        return { op: "const_i32", value: 0, type: "i32" };
    }
  }

  lowerPatternMatch(pattern, targetLir, fnCtx, bindStmts) {
    if (!pattern) return { op: "const_i32", value: 1, type: "i32" };

    switch (pattern.kind) {
      case "WildcardPattern":
        return { op: "const_i32", value: 1, type: "i32" };

      case "VarPattern": {
        const lirType = pattern.inferredType
          ? semanticTypeToLirType(pattern.inferredType)
          : targetLir.type || "i32";
        const localDesc = this.allocLocal(
          fnCtx,
          pattern.name,
          lirType,
          Boolean(pattern.mutable)
        );
        this.defineVar(fnCtx, pattern.name, localDesc);
        bindStmts.push({
          op: "local_set",
          localId: localDesc.localId,
          value: targetLir,
        });
        return { op: "const_i32", value: 1, type: "i32" };
      }

      case "LiteralPattern": {
        const litNode = pattern.literal || pattern;
        const litType =
          litNode.literalType ||
          (litNode.inferredType ? litNode.inferredType.name : "i32");
        const litVal = litNode.value;

        if (litType === "string") {
          const strLir = this.lowerExpr(litNode, fnCtx);
          return {
            op: "call_builtin",
            builtin: "str_eq",
            args: [targetLir, strLir],
            type: "i32",
          };
        }

        if (litType === "i64") {
          return {
            op: "binop",
            kind: "eq",
            left: targetLir,
            right: {
              op: "const_i64",
              value: BigInt(litVal || 0),
              type: "i64",
            },
            type: "i32",
          };
        }

        if (litType === "bool") {
          return {
            op: "binop",
            kind: "eq",
            left: targetLir,
            right: { op: "const_i32", value: litVal ? 1 : 0, type: "i32" },
            type: "i32",
          };
        }

        return {
          op: "binop",
          kind: "eq",
          left: targetLir,
          right: { op: "const_i32", value: Number(litVal) | 0, type: "i32" },
          type: "i32",
        };
      }

      case "EnumPattern": {
        let tagIndex = 0;
        let variantDef = null;
        if (this.env) {
          const vInfo = this.env.lookupVariant(
            pattern.enumName,
            pattern.variantName
          );
          if (vInfo) {
            tagIndex = vInfo.tagIndex;
            const enumDef = this.env.getEnum(vInfo.enumName);
            if (enumDef) {
              variantDef = enumDef.variants.find(
                (v) => v.name === pattern.variantName
              );
            }
          }
        }

        const tagLoad = {
          op: "mem_load",
          ptr: targetLir,
          offset: 8,
          loadType: "i32",
          type: "i32",
        };
        const tagCond = {
          op: "binop",
          kind: "eq",
          left: tagLoad,
          right: { op: "const_i32", value: tagIndex, type: "i32" },
          type: "i32",
        };

        let combinedCond = tagCond;
        for (let i = 0; i < (pattern.args || []).length; i++) {
          const argPat = pattern.args[i];
          const argType =
            variantDef && variantDef.fields && variantDef.fields[i]
              ? semanticTypeToLirType(variantDef.fields[i])
              : "i32";
          const fieldLoad = {
            op: "mem_load",
            ptr: targetLir,
            offset: 16 + 8 * i,
            loadType: argType,
            type: argType,
          };
          const subCond = this.lowerPatternMatch(
            argPat,
            fieldLoad,
            fnCtx,
            bindStmts
          );
          combinedCond = {
            op: "binop",
            kind: "and",
            left: combinedCond,
            right: subCond,
            type: "i32",
          };
        }
        return combinedCond;
      }

      case "StructPattern": {
        let structDef = null;
        if (this.env) {
          structDef = this.env.getStruct(pattern.structName);
        }
        let combinedCond = { op: "const_i32", value: 1, type: "i32" };
        for (const f of pattern.fields || []) {
          let fieldIndex = 0;
          let fieldType = "i32";
          if (structDef) {
            const idx = structDef.fields.findIndex((df) => df.name === f.name);
            if (idx !== -1) {
              fieldIndex = idx;
              fieldType = semanticTypeToLirType(structDef.fields[idx].type);
            }
          }
          const fieldLoad = {
            op: "mem_load",
            ptr: targetLir,
            offset: 8 + 8 * fieldIndex,
            loadType: fieldType,
            type: fieldType,
          };
          const subCond = this.lowerPatternMatch(
            f.pattern,
            fieldLoad,
            fnCtx,
            bindStmts
          );
          combinedCond = {
            op: "binop",
            kind: "and",
            left: combinedCond,
            right: subCond,
            type: "i32",
          };
        }
        return combinedCond;
      }

      default:
        return { op: "const_i32", value: 1, type: "i32" };
    }
  }
}

/**
 * Lower a typed Lumen Program AST into an LIR Module and validate it against
 * `validateLir(lirModule)` from `src/contracts/index.js`.
 */
export function lowerToLir(typedAst, options = {}) {
  const lowerer = new ModuleLowerer(options);
  const lirModule = lowerer.lowerProgram(typedAst);
  validateLir(lirModule);
  return lirModule;
}
