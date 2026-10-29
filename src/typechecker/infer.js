/**
 * Lumen Type Checker — M1 Scope (`src/typechecker/infer.js`)
 * Owned exclusively by Agent B.
 *
 * M1 Scope:
 * - Top-level `fn main()` and user functions
 * - `void` return type & primitive types (`string`, `i32`, `i64`, `f64`, `bool`, `void`)
 * - String & primitive literals (`LiteralExpr`)
 * - Built-in calls `print(s: string)` and `println(s: string)` (plus basic M1 built-ins)
 * - Annotates `.inferredType` on all visited expressions matching `src/contracts/index.js`
 */

import {
  ErrorCodes,
  createDiagnostic,
  createSpan,
  assertValidProgramAst,
} from "../contracts/index.js";
import {
  Types,
  unwrapType,
  typeToString,
  typesEqual,
  isErrorType,
  isNumericType,
  isIntegerType,
  isBoolType,
  isStringType,
  isOrderedType,
  unify,
  resetTypeVarCounter,
  findClosestMatch,
} from "./types.js";
import { TypeEnv } from "./env.js";

export class TypeChecker {
  constructor(options = {}) {
    this.filename = options.filename || "<input>";
    this.sourceMap = options.sourceMap || new Map();
    this.env = options.env || new TypeEnv();
    this.diagnostics = [];
  }

  getSourceLine(span) {
    if (!span) return "";
    const file = span.file || this.filename;
    const src = this.sourceMap.get(file) || this.sourceMap.get(this.filename) || "";
    if (!src) return "";
    const lines = src.split(/\r?\n/);
    return lines[(span.startLine || 1) - 1] || "";
  }

  reportError(code, message, span, suggestion = null) {
    const safeSpan = span || createSpan(this.filename);
    this.diagnostics.push(
      createDiagnostic({
        code,
        severity: "error",
        message,
        span: safeSpan,
        sourceLine: this.getSourceLine(safeSpan),
        suggestion,
      })
    );
  }

  /**
   * Resolve a parsed `TypeNode` into a semantic `Type`.
   */
  resolveTypeNode(typeNode, scope = null) {
    if (!typeNode) return Types.VOID;

    switch (typeNode.kind) {
      case "NamedType": {
        const name = typeNode.name;
        let resolved = null;
        switch (name) {
          case "i32":
            resolved = Types.I32;
            break;
          case "i64":
            resolved = Types.I64;
            break;
          case "f64":
            resolved = Types.F64;
            break;
          case "bool":
            resolved = Types.BOOL;
            break;
          case "string":
            resolved = Types.STRING;
            break;
          case "void":
          case "()":
            resolved = Types.VOID;
            break;
          default: {
            if (scope) {
              const tp = scope.lookupTypeParam(name);
              if (tp) {
                resolved = tp;
                break;
              }
            }
            const closest = findClosestMatch(name, this.env.getAllTypeNames());
            this.reportError(
              ErrorCodes.TYPE_UNDEFINED_TYPE,
              `unknown type \`${name}\``,
              typeNode.span,
              closest ? `Did you mean \`${closest}\`?` : null
            );
            resolved = Types.ERROR;
            break;
          }
        }
        typeNode.resolvedType = resolved;
        return resolved;
      }

      case "ArrayType": {
        const elemType = this.resolveTypeNode(typeNode.elem, scope);
        const resolved = Types.array(elemType);
        typeNode.resolvedType = resolved;
        return resolved;
      }

      case "FnType": {
        const paramTypes = (typeNode.params || []).map((p) =>
          this.resolveTypeNode(p, scope)
        );
        const retType = this.resolveTypeNode(typeNode.ret, scope);
        const resolved = Types.fn(paramTypes, retType);
        typeNode.resolvedType = resolved;
        return resolved;
      }

      default:
        typeNode.resolvedType = Types.VOID;
        return Types.VOID;
    }
  }

  /**
   * Main entry point to typecheck a `Program` AST.
   */
  checkProgram(ast) {
    assertValidProgramAst(ast);

    const declaredFns = new Set();
    const declaredConsts = new Set();

    // Pass 1: Register all top-level function signatures
    for (const decl of ast.decls) {
      if (!decl) continue;
      if (decl.kind === "FnDecl") {
        if (declaredFns.has(decl.name) || this.env.functions.get(decl.name)?.isBuiltin) {
          this.reportError(
            ErrorCodes.TYPE_DUPLICATE_SYMBOL,
            `duplicate function definition \`${decl.name}\``,
            decl.span
          );
          continue;
        }
        declaredFns.add(decl.name);

        const paramTypes = [];
        for (const param of decl.params || []) {
          const pType = this.resolveTypeNode(param.typeAnn, this.env.globalScope);
          param.resolvedType = pType;
          paramTypes.push(pType);
        }

        const returnType = decl.returnType
          ? this.resolveTypeNode(decl.returnType, this.env.globalScope)
          : Types.VOID;

        decl.resolvedReturnType = returnType;
        const entry = this.env.registerFunction({
          name: decl.name,
          typeParams: decl.typeParams || [],
          paramTypes,
          returnType,
          isPublic: Boolean(decl.isPublic),
          decl,
          span: decl.span,
        });
        decl.fnType = entry.fnType;
      }
    }

    // Pass 2: Typecheck top-level constants
    for (const decl of ast.decls) {
      if (!decl || decl.kind !== "ConstDecl") continue;
      if (declaredConsts.has(decl.name)) {
        this.reportError(
          ErrorCodes.TYPE_DUPLICATE_SYMBOL,
          `duplicate constant definition \`${decl.name}\``,
          decl.span
        );
        continue;
      }
      declaredConsts.add(decl.name);

      const expectedType = decl.typeAnn
        ? this.resolveTypeNode(decl.typeAnn, this.env.globalScope)
        : null;
      const initType = this.inferExpr(decl.init, this.env.globalScope, expectedType);

      let finalType = initType;
      if (expectedType) {
        if (!unify(expectedType, initType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `constant \`${decl.name}\` declared as \`${typeToString(expectedType)}\`, but initialized with \`${typeToString(initType)}\``,
            decl.init?.span || decl.span
          );
        }
        finalType = expectedType;
      }
      decl.resolvedType = finalType;
      decl.inferredType = finalType;
      this.env.registerConstant({
        name: decl.name,
        type: finalType,
        isPublic: Boolean(decl.isPublic),
        decl,
        span: decl.span,
      });
    }

    // Pass 3: Typecheck all function bodies
    for (const decl of ast.decls) {
      if (!decl || decl.kind !== "FnDecl") continue;
      this.checkFnDecl(decl);
    }

    return {
      ast,
      env: this.env,
      diagnostics: this.diagnostics,
    };
  }

  checkFnDecl(decl) {
    const returnType = decl.resolvedReturnType || Types.VOID;
    const fnScope = this.env.globalScope.childFunction(
      returnType,
      decl.typeParams || []
    );

    const seenParams = new Set();
    for (const param of decl.params || []) {
      if (seenParams.has(param.name)) {
        this.reportError(
          ErrorCodes.TYPE_DUPLICATE_SYMBOL,
          `duplicate parameter \`${param.name}\` in function \`${decl.name}\``,
          param.span
        );
      }
      seenParams.add(param.name);
      const pType =
        param.resolvedType || this.resolveTypeNode(param.typeAnn, fnScope);
      param.resolvedType = pType;
      fnScope.define(param.name, pType, {
        mutable: Boolean(param.mutable),
        isParam: true,
        declNode: param,
        span: param.span,
      });
    }

    // Validate `main` signature in M1 (`fn main()` returns `void` or `i32`)
    if (decl.name === "main" && (decl.params || []).length > 0) {
      this.reportError(
        ErrorCodes.TYPE_ARITY_MISMATCH,
        `\`main\` function must not take parameters`,
        decl.span
      );
    }

    const bodyType = this.checkBlockStmt(decl.body, fnScope, returnType, false);

    // If function has non-void return type and body relies on tail expression or falls through
    if (
      !typesEqual(returnType, Types.VOID) &&
      !isErrorType(returnType) &&
      !isErrorType(bodyType)
    ) {
      if (decl.body.tailExpr) {
        if (!unify(returnType, bodyType)) {
          this.reportError(
            ErrorCodes.TYPE_RETURN_MISMATCH,
            `mismatched return type in function \`${decl.name}\`: expected \`${typeToString(returnType)}\`, found \`${typeToString(bodyType)}\``,
            decl.body.tailExpr.span || decl.body.span
          );
        }
      } else if (!this.blockAlwaysReturns(decl.body)) {
        this.reportError(
          ErrorCodes.TYPE_MISSING_RETURN,
          `function \`${decl.name}\` must return a value of type \`${typeToString(returnType)}\``,
          decl.span
        );
      }
    } else if (typesEqual(returnType, Types.VOID) && decl.body.tailExpr) {
      if (!typesEqual(bodyType, Types.VOID) && !isErrorType(bodyType)) {
        this.reportError(
          ErrorCodes.TYPE_RETURN_MISMATCH,
          `function \`${decl.name}\` has return type \`void\`, but its body returns \`${typeToString(bodyType)}\``,
          decl.body.tailExpr.span,
          "Add `;` after the expression or specify a return type `-> " +
            typeToString(bodyType) +
            "`"
        );
      }
    }
  }

  blockAlwaysReturns(block) {
    if (!block || block.kind !== "BlockStmt") return false;
    for (const stmt of block.stmts || []) {
      if (stmt.kind === "ReturnStmt") return true;
      if (
        stmt.kind === "IfStmt" &&
        stmt.elseBranch &&
        this.stmtAlwaysReturns(stmt.thenBranch) &&
        this.stmtAlwaysReturns(stmt.elseBranch)
      ) {
        return true;
      }
    }
    return false;
  }

  stmtAlwaysReturns(stmt) {
    if (!stmt) return false;
    if (stmt.kind === "BlockStmt") return this.blockAlwaysReturns(stmt);
    if (stmt.kind === "ReturnStmt") return true;
    if (stmt.kind === "IfStmt" && stmt.elseBranch) {
      return (
        this.stmtAlwaysReturns(stmt.thenBranch) &&
        this.stmtAlwaysReturns(stmt.elseBranch)
      );
    }
    return false;
  }

  checkBlockStmt(block, parentScope, expectedType = null, createChildScope = true) {
    if (!block) return Types.VOID;
    const scope = createChildScope ? parentScope.child() : parentScope;

    for (const stmt of block.stmts || []) {
      this.checkStmt(stmt, scope);
    }

    let resultType = Types.VOID;
    if (block.tailExpr) {
      resultType = this.inferExpr(block.tailExpr, scope, expectedType);
    }

    block.inferredType = resultType;
    return resultType;
  }

  checkStmt(stmt, scope) {
    if (!stmt) return;

    switch (stmt.kind) {
      case "ExprStmt": {
        this.inferExpr(stmt.expr, scope, null);
        stmt.inferredType = Types.VOID;
        break;
      }

      case "LetStmt": {
        const declaredType = stmt.typeAnn
          ? this.resolveTypeNode(stmt.typeAnn, scope)
          : null;
        const initType = this.inferExpr(stmt.init, scope, declaredType);

        let varType = initType;
        if (declaredType) {
          if (!unify(declaredType, initType)) {
            this.reportError(
              ErrorCodes.TYPE_MISMATCH,
              `mismatched types in \`let ${stmt.name}\`: expected \`${typeToString(declaredType)}\`, found \`${typeToString(initType)}\``,
              stmt.init?.span || stmt.span
            );
          }
          varType = declaredType;
        } else if (typesEqual(initType, Types.VOID)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `cannot bind variable \`${stmt.name}\` to \`void\` expression`,
            stmt.init?.span || stmt.span
          );
          varType = Types.ERROR;
        }

        stmt.resolvedType = varType;
        stmt.inferredType = Types.VOID;
        scope.define(stmt.name, varType, {
          mutable: Boolean(stmt.mutable),
          declNode: stmt,
          span: stmt.span,
        });
        break;
      }

      case "AssignStmt": {
        const targetType = this.inferExpr(stmt.target, scope, null);
        if (stmt.target.kind === "IdentExpr") {
          const binding = scope.lookup(stmt.target.name, false);
          if (binding && !binding.mutable) {
            this.reportError(
              ErrorCodes.TYPE_IMMUTABLE_ASSIGN,
              `cannot assign to immutable variable \`${stmt.target.name}\``,
              stmt.target.span,
              `Declare \`${stmt.target.name}\` as mutable: \`let mut ${stmt.target.name} = ...\``
            );
          }
        }
        const valType = this.inferExpr(stmt.value, scope, targetType);
        if (!unify(targetType, valType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `mismatched types in assignment: expected \`${typeToString(targetType)}\`, found \`${typeToString(valType)}\``,
            stmt.value?.span || stmt.span
          );
        }
        stmt.inferredType = Types.VOID;
        break;
      }

      case "ReturnStmt": {
        const expectedRet = scope.returnType || Types.VOID;
        if (stmt.value) {
          const actualRet = this.inferExpr(stmt.value, scope, expectedRet);
          if (!unify(expectedRet, actualRet)) {
            this.reportError(
              ErrorCodes.TYPE_RETURN_MISMATCH,
              `mismatched return type: expected \`${typeToString(expectedRet)}\`, found \`${typeToString(actualRet)}\``,
              stmt.value.span || stmt.span
            );
          }
        } else if (!typesEqual(expectedRet, Types.VOID)) {
          this.reportError(
            ErrorCodes.TYPE_RETURN_MISMATCH,
            `expected return value of type \`${typeToString(expectedRet)}\`, found \`void\``,
            stmt.span
          );
        }
        stmt.inferredType = Types.VOID;
        break;
      }

      case "IfStmt": {
        const condType = this.inferExpr(stmt.cond, scope, Types.BOOL);
        if (!isBoolType(condType) && !isErrorType(condType)) {
          this.reportError(
            ErrorCodes.TYPE_CONDITION_NOT_BOOL,
            `\`if\` condition must be \`bool\`, found \`${typeToString(condType)}\``,
            stmt.cond?.span || stmt.span
          );
        }
        this.checkBlockStmt(stmt.thenBranch, scope, null, true);
        if (stmt.elseBranch) {
          if (stmt.elseBranch.kind === "IfStmt") {
            this.checkStmt(stmt.elseBranch, scope);
          } else {
            this.checkBlockStmt(stmt.elseBranch, scope, null, true);
          }
        }
        stmt.inferredType = Types.VOID;
        break;
      }

      case "WhileStmt": {
        const condType = this.inferExpr(stmt.cond, scope, Types.BOOL);
        if (!isBoolType(condType) && !isErrorType(condType)) {
          this.reportError(
            ErrorCodes.TYPE_CONDITION_NOT_BOOL,
            `\`while\` condition must be \`bool\`, found \`${typeToString(condType)}\``,
            stmt.cond?.span || stmt.span
          );
        }
        const loopScope = scope.childLoop();
        this.checkBlockStmt(stmt.body, loopScope, null, false);
        stmt.inferredType = Types.VOID;
        break;
      }

      case "BreakStmt":
      case "ContinueStmt": {
        if (scope.loopDepth <= 0) {
          const kw = stmt.kind === "BreakStmt" ? "break" : "continue";
          this.reportError(
            ErrorCodes.TYPE_BREAK_OUTSIDE_LOOP,
            `\`${kw}\` cannot be used outside of a loop`,
            stmt.span
          );
        }
        stmt.inferredType = Types.VOID;
        break;
      }

      case "BlockStmt": {
        this.checkBlockStmt(stmt, scope, null, true);
        break;
      }

      default:
        stmt.inferredType = Types.VOID;
        break;
    }
  }

  /**
   * Infer the semantic `Type` of `expr` and annotate `expr.inferredType`.
   */
  inferExpr(expr, scope, expectedType = null) {
    if (!expr) return Types.VOID;

    let resultType = Types.VOID;

    switch (expr.kind) {
      case "LiteralExpr": {
        switch (expr.literalType) {
          case "string":
            resultType = Types.STRING;
            break;
          case "i32":
            resultType = Types.I32;
            break;
          case "i64":
            resultType = Types.I64;
            break;
          case "f64":
            resultType = Types.F64;
            break;
          case "bool":
            resultType = Types.BOOL;
            break;
          case "void":
          default:
            resultType = Types.VOID;
            break;
        }
        break;
      }

      case "IdentExpr": {
        const binding = scope.lookup(expr.name);
        if (binding) {
          resultType = unwrapType(binding.type);
          break;
        }
        const fnDef = this.env.getFunction(expr.name);
        if (fnDef) {
          resultType = fnDef.fnType;
          break;
        }
        const closest = findClosestMatch(
          expr.name,
          this.env.getAllValueNames(scope)
        );
        this.reportError(
          ErrorCodes.TYPE_UNDEFINED_VAR,
          `undefined variable \`${expr.name}\``,
          expr.span,
          closest ? `Did you mean \`${closest}\`?` : null
        );
        resultType = Types.ERROR;
        break;
      }

      case "CallExpr": {
        resultType = this.inferCallExpr(expr, scope, expectedType);
        break;
      }

      case "UnaryExpr": {
        const opType = this.inferExpr(expr.operand, scope, expectedType);
        if (isErrorType(opType)) {
          resultType = Types.ERROR;
          break;
        }
        if (expr.op === "-") {
          if (!isNumericType(opType)) {
            this.reportError(
              ErrorCodes.TYPE_UNARY_OP_MISMATCH,
              `unary \`-\` cannot be applied to type \`${typeToString(opType)}\``,
              expr.span
            );
            resultType = Types.ERROR;
          } else {
            resultType = opType;
          }
        } else if (expr.op === "!") {
          if (!isBoolType(opType)) {
            this.reportError(
              ErrorCodes.TYPE_UNARY_OP_MISMATCH,
              `logical \`!\` requires \`bool\` operand, found \`${typeToString(opType)}\``,
              expr.span
            );
            resultType = Types.ERROR;
          } else {
            resultType = Types.BOOL;
          }
        } else if (expr.op === "~") {
          if (!isIntegerType(opType)) {
            this.reportError(
              ErrorCodes.TYPE_UNARY_OP_MISMATCH,
              `bitwise \`~\` requires integer operand, found \`${typeToString(opType)}\``,
              expr.span
            );
            resultType = Types.ERROR;
          } else {
            resultType = opType;
          }
        }
        break;
      }

      case "BinaryExpr": {
        resultType = this.inferBinaryExpr(expr, scope);
        break;
      }

      case "BlockExpr": {
        resultType = this.checkBlockStmt(expr.block, scope, expectedType, true);
        break;
      }

      case "IfExpr": {
        const condType = this.inferExpr(expr.cond, scope, Types.BOOL);
        if (!isBoolType(condType) && !isErrorType(condType)) {
          this.reportError(
            ErrorCodes.TYPE_CONDITION_NOT_BOOL,
            `\`if\` condition must be \`bool\`, found \`${typeToString(condType)}\``,
            expr.cond?.span || expr.span
          );
        }
        const thenType = this.checkBlockStmt(
          expr.thenBlock,
          scope,
          expectedType,
          true
        );
        const elseType = expr.elseBlock
          ? this.checkBlockStmt(expr.elseBlock, scope, expectedType || thenType, true)
          : Types.VOID;

        if (!unify(thenType, elseType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `\`if\` and \`else\` branches have incompatible types: \`${typeToString(thenType)}\` vs \`${typeToString(elseType)}\``,
            expr.span
          );
          resultType = Types.ERROR;
        } else {
          resultType = unwrapType(thenType);
        }
        break;
      }

      case "CastExpr": {
        const srcType = this.inferExpr(expr.expr, scope, null);
        const targetType = this.resolveTypeNode(expr.targetType, scope);
        if (isErrorType(srcType) || isErrorType(targetType)) {
          resultType = Types.ERROR;
          break;
        }
        const validCast =
          typesEqual(srcType, targetType) ||
          (isNumericType(srcType) && isNumericType(targetType)) ||
          (isBoolType(srcType) && isIntegerType(targetType));
        if (!validCast) {
          this.reportError(
            ErrorCodes.TYPE_INVALID_CAST,
            `cannot cast \`${typeToString(srcType)}\` to \`${typeToString(targetType)}\``,
            expr.span
          );
          resultType = Types.ERROR;
        } else {
          resultType = targetType;
        }
        break;
      }

      case "ErrorExpr": {
        resultType = Types.ERROR;
        break;
      }

      default: {
        resultType = Types.VOID;
        break;
      }
    }

    expr.inferredType = unwrapType(resultType);
    return expr.inferredType;
  }

  inferCallExpr(expr, scope, expectedType = null) {
    const args = expr.args || [];

    // Direct named function or built-in call
    if (expr.callee && expr.callee.kind === "IdentExpr") {
      const fnName = expr.callee.name;
      const localBinding = scope.lookup(fnName);

      if (!localBinding) {
        const fnDef = this.env.getFunction(fnName);
        if (!fnDef) {
          for (const arg of args) {
            this.inferExpr(arg, scope, null);
          }
          const closest = findClosestMatch(
            fnName,
            Array.from(this.env.functions.keys())
          );
          this.reportError(
            ErrorCodes.TYPE_UNDEFINED_FN,
            `undefined function \`${fnName}\``,
            expr.callee.span || expr.span,
            closest ? `Did you mean \`${closest}\`?` : null
          );
          expr.callee.inferredType = Types.ERROR;
          return Types.ERROR;
        }

        expr.callee.inferredType = fnDef.fnType;
        expr.isBuiltin = Boolean(fnDef.isBuiltin);
        if (fnDef.isBuiltin) {
          expr.builtinName = fnDef.name;
        }

        // Check argument count
        if (args.length < fnDef.minArgs || args.length > fnDef.maxArgs) {
          for (const arg of args) {
            this.inferExpr(arg, scope, null);
          }
          const expectedCountStr =
            fnDef.minArgs === fnDef.maxArgs
              ? `${fnDef.minArgs}`
              : `${fnDef.minArgs}..${fnDef.maxArgs}`;
          this.reportError(
            ErrorCodes.TYPE_ARITY_MISMATCH,
            `function \`${fnName}\` expects ${expectedCountStr} argument(s), but ${args.length} were provided`,
            expr.span
          );
          return fnDef.isDiverging ? (expectedType || Types.VOID) : fnDef.returnType;
        }

        // Polymorphic `print` and `println`
        if (fnDef.isPolymorphicPrint) {
          const resolvedArgTypes = [];
          for (const arg of args) {
            const argType = this.inferExpr(arg, scope, null);
            resolvedArgTypes.push(argType);
            if (typesEqual(argType, Types.VOID)) {
              this.reportError(
                ErrorCodes.TYPE_MISMATCH,
                `cannot pass \`void\` expression to \`${fnName}\``,
                arg.span || expr.span
              );
            }
          }
          expr.resolvedTypeArgs = resolvedArgTypes;
          return Types.VOID;
        }

        // Variadic `assert(cond: bool, msg?: string)`
        if (fnDef.isVariadicAssert) {
          const condType = this.inferExpr(args[0], scope, Types.BOOL);
          if (!isBoolType(condType) && !isErrorType(condType)) {
            this.reportError(
              ErrorCodes.TYPE_MISMATCH,
              `first argument to \`assert\` must be \`bool\`, found \`${typeToString(condType)}\``,
              args[0].span
            );
          }
          if (args.length >= 2) {
            const msgType = this.inferExpr(args[1], scope, Types.STRING);
            if (!isStringType(msgType) && !isErrorType(msgType)) {
              this.reportError(
                ErrorCodes.TYPE_MISMATCH,
                `second argument to \`assert\` must be \`string\`, found \`${typeToString(msgType)}\``,
                args[1].span
              );
            }
          }
          return Types.VOID;
        }

        // Diverging `panic(msg: string) -> T`
        if (fnDef.isDiverging) {
          const msgType = this.inferExpr(args[0], scope, Types.STRING);
          if (!isStringType(msgType) && !isErrorType(msgType)) {
            this.reportError(
              ErrorCodes.TYPE_MISMATCH,
              `argument to \`panic\` must be \`string\`, found \`${typeToString(msgType)}\``,
              args[0].span
            );
          }
          return expectedType || Types.VOID;
        }

        // Standard function call
        for (let i = 0; i < args.length; i++) {
          const paramType = fnDef.paramTypes[i];
          const argType = this.inferExpr(args[i], scope, paramType);
          if (!unify(paramType, argType)) {
            this.reportError(
              ErrorCodes.TYPE_MISMATCH,
              `argument ${i + 1} to \`${fnName}\` has incompatible type: expected \`${typeToString(paramType)}\`, found \`${typeToString(argType)}\``,
              args[i].span || expr.span
            );
          }
        }

        return unwrapType(fnDef.returnType);
      }
    }

    // First-class function / variable callee
    const calleeType = this.inferExpr(expr.callee, scope, null);
    if (isErrorType(calleeType)) {
      for (const arg of args) {
        this.inferExpr(arg, scope, null);
      }
      return Types.ERROR;
    }

    if (calleeType.tag !== "fn") {
      for (const arg of args) {
        this.inferExpr(arg, scope, null);
      }
      this.reportError(
        ErrorCodes.TYPE_NOT_CALLABLE,
        `expression of type \`${typeToString(calleeType)}\` is not callable`,
        expr.callee?.span || expr.span
      );
      return Types.ERROR;
    }

    if (args.length !== calleeType.params.length) {
      for (const arg of args) {
        this.inferExpr(arg, scope, null);
      }
      this.reportError(
        ErrorCodes.TYPE_ARITY_MISMATCH,
        `callable expects ${calleeType.params.length} argument(s), but ${args.length} were provided`,
        expr.span
      );
      return unwrapType(calleeType.ret);
    }

    for (let i = 0; i < args.length; i++) {
      const paramType = calleeType.params[i];
      const argType = this.inferExpr(args[i], scope, paramType);
      if (!unify(paramType, argType)) {
        this.reportError(
          ErrorCodes.TYPE_MISMATCH,
          `argument ${i + 1} has incompatible type: expected \`${typeToString(paramType)}\`, found \`${typeToString(argType)}\``,
          args[i].span || expr.span
        );
      }
    }

    return unwrapType(calleeType.ret);
  }

  inferBinaryExpr(expr, scope) {
    const leftType = this.inferExpr(expr.left, scope, null);
    const rightType = this.inferExpr(expr.right, scope, leftType);

    if (isErrorType(leftType) || isErrorType(rightType)) {
      return Types.ERROR;
    }

    const op = expr.op;

    // Logical operators `&&`, `||`
    if (op === "&&" || op === "||") {
      if (!isBoolType(leftType) || !isBoolType(rightType)) {
        this.reportError(
          ErrorCodes.TYPE_BINARY_OP_MISMATCH,
          `logical operator \`${op}\` requires \`bool\` operands, found \`${typeToString(leftType)}\` and \`${typeToString(rightType)}\``,
          expr.span
        );
        return Types.ERROR;
      }
      return Types.BOOL;
    }

    // Equality operators `==`, `!=`
    if (op === "==" || op === "!=") {
      if (!unify(leftType, rightType)) {
        this.reportError(
          ErrorCodes.TYPE_BINARY_OP_MISMATCH,
          `cannot compare \`${typeToString(leftType)}\` and \`${typeToString(rightType)}\` with \`${op}\``,
          expr.span
        );
        return Types.ERROR;
      }
      return Types.BOOL;
    }

    // Relational operators `<`, `<=`, `>`, `>=`
    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
      if (!unify(leftType, rightType) || !isOrderedType(leftType)) {
        this.reportError(
          ErrorCodes.TYPE_BINARY_OP_MISMATCH,
          `relational operator \`${op}\` cannot be applied to \`${typeToString(leftType)}\` and \`${typeToString(rightType)}\``,
          expr.span
        );
        return Types.ERROR;
      }
      return Types.BOOL;
    }

    // String concatenation or numeric `+`
    if (op === "+") {
      if (isStringType(leftType) && isStringType(rightType)) {
        return Types.STRING;
      }
      if (isNumericType(leftType) && unify(leftType, rightType)) {
        return unwrapType(leftType);
      }
      this.reportError(
        ErrorCodes.TYPE_BINARY_OP_MISMATCH,
        `operator \`+\` cannot be applied to \`${typeToString(leftType)}\` and \`${typeToString(rightType)}\``,
        expr.span
      );
      return Types.ERROR;
    }

    // Arithmetic `-`, `*`, `/`, `%`
    if (op === "-" || op === "*" || op === "/" || op === "%") {
      if (isNumericType(leftType) && unify(leftType, rightType)) {
        return unwrapType(leftType);
      }
      this.reportError(
        ErrorCodes.TYPE_BINARY_OP_MISMATCH,
        `arithmetic operator \`${op}\` cannot be applied to \`${typeToString(leftType)}\` and \`${typeToString(rightType)}\``,
        expr.span
      );
      return Types.ERROR;
    }

    // Bitwise `&`, `|`, `^`, `<<`, `>>`
    if (op === "&" || op === "|" || op === "^" || op === "<<" || op === ">>") {
      if (isIntegerType(leftType) && unify(leftType, rightType)) {
        return unwrapType(leftType);
      }
      this.reportError(
        ErrorCodes.TYPE_BINARY_OP_MISMATCH,
        `bitwise operator \`${op}\` requires matching integer operands, found \`${typeToString(leftType)}\` and \`${typeToString(rightType)}\``,
        expr.span
      );
      return Types.ERROR;
    }

    return Types.ERROR;
  }
}

/**
 * Typecheck a parsed Lumen `Program` AST.
 * Returns `{ ast, env, diagnostics }`.
 */
export function typecheck(ast, options = {}) {
  resetTypeVarCounter();
  const checker = new TypeChecker(options);
  if (!ast) {
    return {
      ast: null,
      env: checker.env,
      diagnostics: checker.diagnostics,
    };
  }
  return checker.checkProgram(ast);
}
