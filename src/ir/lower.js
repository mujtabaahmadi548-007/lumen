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
});

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

class ModuleLowerer {
  constructor(options = {}) {
    this.env = options.env || null;
    this.debug = Boolean(options.debug);

    this.stringLiterals = [];
    this.stringMap = new Map(); // string value -> id

    this.typeDescriptors = [];
    this.typeDescriptorMap = new Map(); // name -> descriptor

    this.globals = [];
    this.globalMap = new Map(); // name -> global info

    this.functions = [];
    this.functionReturnTypes = new Map(); // fnName -> LirType
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
          return "void";
        default:
          return "i32";
      }
    }
    if (typeOrNode.tag) {
      return semanticTypeToLirType(typeOrNode);
    }
    if (typeOrNode.inferredType) {
      return semanticTypeToLirType(typeOrNode.inferredType);
    }
    if (typeOrNode.resolvedType) {
      return semanticTypeToLirType(typeOrNode.resolvedType);
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
        if (decl.returnType) {
          retType = this.resolveLirType(decl.returnType);
        } else if (this.env && this.env.getFunction) {
          const fnDef = this.env.getFunction(decl.name);
          if (fnDef && fnDef.returnType) {
            retType = semanticTypeToLirType(fnDef.returnType);
          }
        }
        this.functionReturnTypes.set(decl.name, retType);
      } else if (decl.kind === "ConstDecl") {
        const lirType = decl.inferredType
          ? semanticTypeToLirType(decl.inferredType)
          : decl.typeAnn
            ? this.resolveLirType(decl.typeAnn)
            : this.inferExprLirType(decl.init, null);
        this.globalMap.set(decl.name, {
          name: decl.name,
          type: lirType,
          decl,
        });
      }
    }

    // Pass 2: Lower top-level constants (if any) and functions
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
      (fnDecl.returnType ? this.resolveLirType(fnDecl.returnType) : "void");

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
      const paramType = param.inferredType
        ? semanticTypeToLirType(param.inferredType)
        : param.resolvedType
          ? semanticTypeToLirType(param.resolvedType)
          : this.resolveLirType(param.typeAnn);
      const localId = fnCtx.nextLocalId++;
      const isGcRoot = paramType === "gc_ref";
      const shadowSlotIndex = isGcRoot ? fnCtx.nextShadowSlot++ : -1;
      const desc = {
        id: localId,
        localId,
        name: param.name,
        type: paramType,
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

  allocLocal(fnCtx, name, lirType) {
    const localId = fnCtx.nextLocalId++;
    const isGcRoot = lirType === "gc_ref";
    const shadowSlotIndex = isGcRoot ? fnCtx.nextShadowSlot++ : -1;
    const desc = {
      id: localId,
      localId,
      name,
      type: lirType,
      isParam: false,
      isGcRoot,
      shadowSlotIndex,
    };
    fnCtx.locals.push(desc);
    fnCtx.allLocals.push(desc);
    return desc;
  }

  allocTempLocal(fnCtx, lirType, prefix = "$tmp") {
    const tempName = `${prefix}_${fnCtx.nextTempId++}`;
    return this.allocLocal(fnCtx, tempName, lirType);
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
      const tailLir = this.lowerExpr(blockStmt.tailExpr, fnCtx);
      out.push({
        op: "expr",
        expr: tailLir,
        span: blockStmt.tailExpr.span,
      });
    }
    this.popScope(fnCtx);
    return out;
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
        const varType = stmt.inferredType
          ? semanticTypeToLirType(stmt.inferredType)
          : stmt.typeAnn
            ? this.resolveLirType(stmt.typeAnn)
            : initLir.type;
        const localDesc = this.allocLocal(fnCtx, stmt.name, varType);
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
            const binOpMap = {
              "+=": "add",
              "-=": "sub",
              "*=": "mul",
              "/=": "div_s",
            };
            const kind = binOpMap[stmt.op] || "add";
            finalValue = {
              op: "binop",
              kind,
              left: {
                op: "local_get",
                localId: localDesc.localId,
                type: localDesc.type,
              },
              right: rhsLir,
              type: localDesc.type,
            };
          }
          out.push({
            op: "local_set",
            localId: localDesc.localId,
            value: finalValue,
            span: stmt.span,
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
      return semanticTypeToLirType(expr.inferredType);
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
      case "CallExpr": {
        if (expr.callee.kind === "IdentExpr") {
          const name = expr.callee.name;
          if (Object.prototype.hasOwnProperty.call(BUILTIN_RETURN_LIR_TYPES, name)) {
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
      default:
        return "i32";
    }
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
        const rawArgs = (expr.args || []).map((a) => this.lowerExpr(a, fnCtx));
        const safeArgs = this.stabilizeExprListForGc(rawArgs, fnCtx);

        if (expr.callee.kind === "IdentExpr") {
          const fnName = expr.callee.name;

          if (BUILTIN_NAMES.has(fnName)) {
            let finalArgs = safeArgs;
            // If `println()` is called with 0 arguments, pass an empty string literal
            if ((fnName === "println" || fnName === "print") && finalArgs.length === 0) {
              const emptyId = this.internString("");
              finalArgs = [
                {
                  op: "const_string",
                  stringId: emptyId,
                  value: "",
                  type: "gc_ref",
                },
              ];
            }
            const retType = this.inferExprLirType(expr, fnCtx);
            return {
              op: "call_builtin",
              builtin: fnName,
              args: finalArgs,
              type: retType,
            };
          }

          const retType = this.inferExprLirType(expr, fnCtx);
          return {
            op: "call",
            funcName: fnName,
            args: safeArgs,
            type: retType,
          };
        }

        const retType = this.inferExprLirType(expr, fnCtx);
        return {
          op: "call",
          funcName: "unknown",
          args: safeArgs,
          type: retType,
        };
      }

      case "BinaryExpr": {
        const leftRaw = this.lowerExpr(expr.left, fnCtx);
        const rightRaw = this.lowerExpr(expr.right, fnCtx);
        const [left, right] = this.stabilizeExprListForGc(
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
          "&&": "and",
          "||": "or",
        };
        const resultType = this.inferExprLirType(expr, fnCtx);
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

      case "BlockExpr": {
        const stmts = [];
        this.pushScope(fnCtx);
        for (const s of expr.block.stmts || []) {
          this.lowerStmtInto(s, fnCtx, stmts);
        }
        const result = expr.block.tailExpr
          ? this.lowerExpr(expr.block.tailExpr, fnCtx)
          : { op: "const_i32", value: 0, type: "i32" };
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
        const cond = this.lowerExpr(expr.cond, fnCtx);
        const thenStmts = [];
        this.pushScope(fnCtx);
        for (const s of expr.thenBlock.stmts || []) {
          this.lowerStmtInto(s, fnCtx, thenStmts);
        }
        const thenExpr = expr.thenBlock.tailExpr
          ? this.lowerExpr(expr.thenBlock.tailExpr, fnCtx)
          : { op: "const_i32", value: 0, type: "i32" };
        this.popScope(fnCtx);

        const elseStmts = [];
        this.pushScope(fnCtx);
        for (const s of (expr.elseBlock && expr.elseBlock.stmts) || []) {
          this.lowerStmtInto(s, fnCtx, elseStmts);
        }
        const elseExpr =
          expr.elseBlock && expr.elseBlock.tailExpr
            ? this.lowerExpr(expr.elseBlock.tailExpr, fnCtx)
            : { op: "const_i32", value: 0, type: "i32" };
        this.popScope(fnCtx);

        const resultType = this.inferExprLirType(expr, fnCtx);
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

      default:
        return { op: "const_i32", value: 0, type: "i32" };
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
