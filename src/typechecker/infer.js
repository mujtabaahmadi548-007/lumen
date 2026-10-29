/**
 * Lumen Type Checker — M1-M2 Scope (`src/typechecker/infer.js`)
 * Owned exclusively by Agent B.
 *
 * M2 Scope:
 * - Primitive types: `i32`, `i64`, `f64`, `bool`, `string`, `void`
 * - Arithmetic (`+`, `-`, `*`, `/`, `%`, unary `-`), logical (`&&`, `||`, `!`),
 *   bitwise (`&`, `|`, `^`, `~`, `<<`, `>>`), comparison (`==`, `!=`, `<`, `<=`, `>`, `>=`)
 * - Casts (`expr as Type`) with conversion suggestions on invalid casts (`E0214`)
 * - `let` and `let mut`, assignments (`=`, `+=`, `-=`, `*=`, `/=`)
 * - `if`/`else` (statement and expression), `while`, `for i in a..b` (`RangeExpr`),
 *   `break`, `continue`, `return`, recursion
 * - Multi-error recovery integration (`ErrorStmt` / `ErrorExpr` produce `Types.ERROR` without cascading)
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
  isPrimitiveType,
  isNumericType,
  isIntegerType,
  isBoolType,
  isStringType,
  isVoidType,
  isOrderedType,
  unify,
  resetTypeVarCounter,
  findClosestMatch,
  substituteTypeParams,
} from "./types.js";
import { TypeEnv } from "./env.js";
import { checkMatchExhaustiveness } from "./exhaustiveness.js";

const DEFAULT_SUGGESTIONS = Object.freeze({
  [ErrorCodes.TYPE_MISMATCH]:
    "Ensure the expression type matches the expected type annotation",
  [ErrorCodes.TYPE_UNDEFINED_VAR]:
    "Declare the variable with `let` before referencing it",
  [ErrorCodes.TYPE_UNDEFINED_TYPE]:
    "Use a built-in primitive type (`i32`, `i64`, `f64`, `bool`, `string`, or `void`) or declare the struct/enum",
  [ErrorCodes.TYPE_UNDEFINED_FN]:
    "Define the function with `fn` before calling it, or check the function name spelling",
  [ErrorCodes.TYPE_ARITY_MISMATCH]:
    "Check the function signature and pass the expected number of arguments",
  [ErrorCodes.TYPE_IMMUTABLE_ASSIGN]:
    "Declare the variable with `let mut` so it can be reassigned",
  [ErrorCodes.TYPE_UNKNOWN_FIELD]:
    "Check the struct definition for available field names",
  [ErrorCodes.TYPE_MISSING_FIELD]:
    "Provide all required fields in the struct instantiation",
  [ErrorCodes.TYPE_DUPLICATE_FIELD]:
    "Remove the duplicate field name",
  [ErrorCodes.TYPE_UNKNOWN_VARIANT]:
    "Check the enum definition for available variant names",
  [ErrorCodes.TYPE_NOT_INDEXABLE]:
    "Only array types `[T]` can be indexed with `[...]`",
  [ErrorCodes.TYPE_INDEX_NOT_INT]:
    "Use an integer index (`i32` or `i64`) to index an array",
  [ErrorCodes.TYPE_NOT_CALLABLE]:
    "Only functions can be called with `(...)`",
  [ErrorCodes.TYPE_INVALID_CAST]:
    "Use `as` for numeric/boolean conversions, or built-in functions like `int_to_string` / `str_to_int`",
  [ErrorCodes.TYPE_RETURN_MISMATCH]:
    "Ensure the returned expression matches the function's declared return type",
  [ErrorCodes.TYPE_MISSING_RETURN]:
    "Add a `return <expr>;` statement or trailing expression on all control-flow paths",
  [ErrorCodes.TYPE_BREAK_OUTSIDE_LOOP]:
    "Place `break` and `continue` statements inside a `while` or `for` loop",
  [ErrorCodes.TYPE_DUPLICATE_SYMBOL]:
    "Rename or remove the duplicate declaration",
  [ErrorCodes.TYPE_CONDITION_NOT_BOOL]:
    "Use a boolean expression (such as `x != 0` or `a < b`) as the condition",
  [ErrorCodes.TYPE_BINARY_OP_MISMATCH]:
    "Ensure both operands have compatible types for this binary operator",
  [ErrorCodes.TYPE_UNARY_OP_MISMATCH]:
    "Ensure the operand has a valid type for this unary operator",
  [ErrorCodes.MATCH_NON_EXHAUSTIVE]:
    "Cover all enum variants or add a wildcard `_ => ...` fallback arm",
  [ErrorCodes.MATCH_REDUNDANT_ARM]:
    "Remove this unreachable arm or move more specific patterns earlier",
  [ErrorCodes.MATCH_PATTERN_ARITY]:
    "Check the variant definition and match the expected number of arguments",
});

const M2_PRIMITIVE_TYPE_NAMES = [
  "i32",
  "i64",
  "f64",
  "bool",
  "string",
  "void",
];

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
    const src =
      this.sourceMap.get(file) || this.sourceMap.get(this.filename) || "";
    if (!src) return "";
    const lines = src.split(/\r?\n/);
    return lines[(span.startLine || 1) - 1] || "";
  }

  reportError(code, message, span, suggestion = null) {
    const safeSpan = span || createSpan(this.filename);
    const nonEmptySuggestion =
      suggestion && String(suggestion).trim().length > 0
        ? suggestion
        : DEFAULT_SUGGESTIONS[code] || "Check the types and declarations here";
    this.diagnostics.push(
      createDiagnostic({
        code,
        severity: "error",
        message,
        span: safeSpan,
        sourceLine: this.getSourceLine(safeSpan),
        suggestion: nonEmptySuggestion,
      })
    );
  }

  /**
   * Resolve a parsed `TypeNode` into a semantic `Type` (M2 scope).
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
          case "_error":
            resolved = Types.ERROR;
            break;
          default: {
            if (scope) {
              const tp = scope.lookupTypeParam(name);
              if (tp) {
                resolved = tp;
                break;
              }
            }
            if (this.env.hasStruct(name)) {
              const typeArgs = (typeNode.typeArgs || []).map((arg) =>
                this.resolveTypeNode(arg, scope)
              );
              resolved = this.env.instantiateStruct(name, typeArgs.length ? typeArgs : null);
              break;
            }
            if (this.env.hasEnum(name)) {
              const typeArgs = (typeNode.typeArgs || []).map((arg) =>
                this.resolveTypeNode(arg, scope)
              );
              resolved = this.env.instantiateEnum(name, typeArgs.length ? typeArgs : null);
              break;
            }
            const candidateNames = [
              ...M2_PRIMITIVE_TYPE_NAMES,
              ...Array.from(this.env.structs.keys()),
              ...Array.from(this.env.enums.keys()),
            ];
            const closest = findClosestMatch(name, candidateNames);
            this.reportError(
              ErrorCodes.TYPE_UNDEFINED_TYPE,
              `unknown type \`${name}\``,
              typeNode.span,
              closest
                ? `Did you mean \`${closest}\`?`
                : "Use a built-in primitive type or declared struct/enum"
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
    const declaredTypes = new Set();

    // Pass 0a: Register all StructDecl & EnumDecl names
    for (const decl of ast.decls) {
      if (!decl) continue;
      if (decl.kind === "StructDecl" || decl.kind === "EnumDecl") {
        if (decl.name === "_error") continue;
        if (declaredTypes.has(decl.name) || this.env.hasStruct(decl.name) || this.env.hasEnum(decl.name)) {
          this.reportError(
            ErrorCodes.TYPE_DUPLICATE_SYMBOL,
            `duplicate type definition \`${decl.name}\``,
            decl.span,
            `Rename or remove the duplicate type \`${decl.name}\``
          );
          decl._isDuplicate = true;
          continue;
        }
        declaredTypes.add(decl.name);
        if (decl.kind === "StructDecl") {
          this.env.registerStruct({
            name: decl.name,
            typeParams: decl.typeParams || [],
            fields: [],
            isPublic: Boolean(decl.isPublic),
            decl,
            span: decl.span,
          });
        } else {
          this.env.registerEnum({
            name: decl.name,
            typeParams: decl.typeParams || [],
            variants: [],
            isPublic: Boolean(decl.isPublic),
            decl,
            span: decl.span,
          });
        }
      }
    }

    // Pass 0b: Populate fields of StructDecls and variants of EnumDecls
    for (const decl of ast.decls) {
      if (!decl || decl._isDuplicate) continue;
      if (decl.kind === "StructDecl") {
        const fieldNames = new Set();
        const resolvedFields = [];
        for (const f of decl.fields || []) {
          if (fieldNames.has(f.name)) {
            this.reportError(
              ErrorCodes.TYPE_DUPLICATE_FIELD,
              `duplicate field \`${f.name}\` in struct \`${decl.name}\``,
              f.span,
              `Remove or rename duplicate field \`${f.name}\``
            );
          }
          fieldNames.add(f.name);
          const fType = this.resolveTypeNode(f.typeAnn, this.env.globalScope);
          resolvedFields.push({
            name: f.name,
            type: fType,
            span: f.span,
          });
        }
        this.env.registerStruct({
          name: decl.name,
          typeParams: decl.typeParams || [],
          fields: resolvedFields,
          isPublic: Boolean(decl.isPublic),
          decl,
          span: decl.span,
        });
      } else if (decl.kind === "EnumDecl") {
        const variantNames = new Set();
        const resolvedVariants = [];
        for (let idx = 0; idx < (decl.variants || []).length; idx++) {
          const v = decl.variants[idx];
          if (variantNames.has(v.name)) {
            this.reportError(
              ErrorCodes.TYPE_DUPLICATE_SYMBOL,
              `duplicate variant \`${v.name}\` in enum \`${decl.name}\``,
              v.span,
              `Rename or remove duplicate variant \`${v.name}\``
            );
          }
          variantNames.add(v.name);
          const pTypes = (v.payload || []).map((pt) =>
            this.resolveTypeNode(pt, this.env.globalScope)
          );
          resolvedVariants.push({
            name: v.name,
            fields: pTypes,
            tagIndex: idx,
            span: v.span,
          });
        }
        this.env.registerEnum({
          name: decl.name,
          typeParams: decl.typeParams || [],
          variants: resolvedVariants,
          isPublic: Boolean(decl.isPublic),
          decl,
          span: decl.span,
        });
      }
    }

    // Pass 1: Register all top-level function signatures (supports recursion & mutual recursion)
    for (const decl of ast.decls) {
      if (!decl || decl.kind !== "FnDecl") continue;
      if (decl.name === "_error") continue;

      if (
        declaredFns.has(decl.name) ||
        this.env.functions.get(decl.name)?.isBuiltin
      ) {
        this.reportError(
          ErrorCodes.TYPE_DUPLICATE_SYMBOL,
          `duplicate function definition \`${decl.name}\``,
          decl.span,
          `Rename or remove the duplicate function \`${decl.name}\``
        );
        decl._isDuplicate = true;
        continue;
      }
      declaredFns.add(decl.name);

      const paramTypes = [];
      for (const param of decl.params || []) {
        const pType = this.resolveTypeNode(
          param.typeAnn,
          this.env.globalScope
        );
        param.resolvedType = pType;
        param.inferredType = pType;
        paramTypes.push(pType);
      }

      const returnType = decl.returnType
        ? this.resolveTypeNode(decl.returnType, this.env.globalScope)
        : Types.VOID;

      decl.resolvedReturnType = returnType;
      decl.inferredType = returnType;
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

    // Pass 2: Typecheck top-level constants
    for (const decl of ast.decls) {
      if (!decl || decl.kind !== "ConstDecl") continue;
      if (decl.name === "_error") {
        if (decl.init) {
          this.inferExpr(decl.init, this.env.globalScope, null);
        }
        continue;
      }

      if (declaredConsts.has(decl.name) || declaredFns.has(decl.name)) {
        this.reportError(
          ErrorCodes.TYPE_DUPLICATE_SYMBOL,
          `duplicate symbol definition \`${decl.name}\``,
          decl.span,
          `Rename or remove the duplicate constant \`${decl.name}\``
        );
        continue;
      }
      declaredConsts.add(decl.name);

      const expectedType = decl.typeAnn
        ? this.resolveTypeNode(decl.typeAnn, this.env.globalScope)
        : null;
      const initType = this.inferExpr(
        decl.init,
        this.env.globalScope,
        expectedType
      );

      let finalType = initType;
      if (expectedType) {
        if (!unify(expectedType, initType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `constant \`${decl.name}\` has type \`${typeToString(expectedType)}\`, but is initialized with \`${typeToString(initType)}\``,
            decl.init?.span || decl.span,
            `Change the type of \`${decl.name}\` to \`${typeToString(initType)}\` or provide a \`${typeToString(expectedType)}\` initializer`
          );
        }
        finalType = expectedType;
      } else if (isVoidType(initType)) {
        this.reportError(
          ErrorCodes.TYPE_MISMATCH,
          `cannot initialize constant \`${decl.name}\` with \`void\` expression`,
          decl.init?.span || decl.span,
          `Initialize \`${decl.name}\` with a non-void value`
        );
        finalType = Types.ERROR;
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
    const returnType =
      decl.resolvedReturnType ||
      (decl.returnType
        ? this.resolveTypeNode(decl.returnType, this.env.globalScope)
        : Types.VOID);
    const fnScope = this.env.globalScope.childFunction(
      returnType,
      decl.typeParams || []
    );

    const seenParams = new Set();
    for (const param of decl.params || []) {
      if (param.name !== "_error" && seenParams.has(param.name)) {
        this.reportError(
          ErrorCodes.TYPE_DUPLICATE_SYMBOL,
          `duplicate parameter \`${param.name}\` in function \`${decl.name}\``,
          param.span,
          `Give each parameter in \`${decl.name}\` a unique name`
        );
      }
      if (param.name !== "_error") {
        seenParams.add(param.name);
      }
      const pType =
        param.resolvedType || this.resolveTypeNode(param.typeAnn, fnScope);
      param.resolvedType = pType;
      param.inferredType = pType;
      fnScope.define(param.name, pType, {
        mutable: Boolean(param.mutable),
        isParam: true,
        declNode: param,
        span: param.span,
      });
    }

    // Validate `main` signature (`fn main()` takes 0 parameters)
    if (decl.name === "main" && (decl.params || []).length > 0) {
      this.reportError(
        ErrorCodes.TYPE_ARITY_MISMATCH,
        `\`main\` function must not take parameters, found ${decl.params.length}`,
        decl.span,
        "Declare `fn main()` with an empty parameter list"
      );
    }

    const bodyType = this.checkBlockStmt(decl.body, fnScope, returnType, false);

    // Check function return type consistency
    if (!isVoidType(returnType) && !isErrorType(returnType)) {
      if (decl.body && decl.body.tailExpr) {
        if (!isErrorType(bodyType) && !unify(returnType, bodyType)) {
          this.reportError(
            ErrorCodes.TYPE_RETURN_MISMATCH,
            `mismatched return type in function \`${decl.name}\`: expected \`${typeToString(returnType)}\`, found \`${typeToString(bodyType)}\``,
            decl.body.tailExpr.span || decl.body.span,
            `Return a value of type \`${typeToString(returnType)}\` or update \`${decl.name}\` return type to \`-> ${typeToString(bodyType)}\``
          );
        }
      } else if (!this.blockAlwaysReturns(decl.body)) {
        this.reportError(
          ErrorCodes.TYPE_MISSING_RETURN,
          `function \`${decl.name}\` must return a value of type \`${typeToString(returnType)}\` on all control-flow paths`,
          decl.span,
          `Add a \`return <expr>;\` statement or trailing expression of type \`${typeToString(returnType)}\` at the end of \`${decl.name}\``
        );
      }
    } else if (isVoidType(returnType) && decl.body && decl.body.tailExpr) {
      if (!isVoidType(bodyType) && !isErrorType(bodyType)) {
        this.reportError(
          ErrorCodes.TYPE_RETURN_MISMATCH,
          `function \`${decl.name}\` has return type \`void\`, but its body returns \`${typeToString(bodyType)}\``,
          decl.body.tailExpr.span || decl.body.span,
          `Add \`;\` after the expression or change the function signature to \`fn ${decl.name}(...) -> ${typeToString(bodyType)}\``
        );
      }
    }
  }

  blockAlwaysReturns(block) {
    if (!block || block.kind !== "BlockStmt") return false;
    for (const stmt of block.stmts || []) {
      if (this.stmtAlwaysReturns(stmt)) return true;
      // If statement is an ErrorStmt from syntax error recovery, avoid false-positive missing-return error
      if (stmt.kind === "ErrorStmt") return true;
    }
    if (block.tailExpr) {
      if (block.tailExpr.kind === "ErrorExpr") return true;
      if (this.exprAlwaysReturns(block.tailExpr)) return true;
    }
    return false;
  }

  stmtAlwaysReturns(stmt) {
    if (!stmt) return false;
    switch (stmt.kind) {
      case "ReturnStmt":
      case "ErrorStmt":
        return true;
      case "BlockStmt":
        return this.blockAlwaysReturns(stmt);
      case "IfStmt":
        return Boolean(
          stmt.elseBranch &&
            this.stmtAlwaysReturns(stmt.thenBranch) &&
            this.stmtAlwaysReturns(stmt.elseBranch)
        );
      case "ExprStmt":
        return this.exprAlwaysReturns(stmt.expr);
      case "MatchStmt":
      case "MatchExpr":
        return this.exprAlwaysReturns(stmt);
      default:
        return false;
    }
  }

  exprAlwaysReturns(expr) {
    if (!expr) return false;
    if (expr.kind === "ErrorExpr") return true;
    if (
      expr.kind === "CallExpr" &&
      expr.callee &&
      expr.callee.kind === "IdentExpr" &&
      expr.callee.name === "panic"
    ) {
      return true;
    }
    if (expr.kind === "IfExpr" && expr.elseBlock) {
      return (
        this.blockAlwaysReturns(expr.thenBlock) &&
        this.blockAlwaysReturns(expr.elseBlock)
      );
    }
    if (expr.kind === "BlockExpr") {
      return this.blockAlwaysReturns(expr.block);
    }
    if (expr.kind === "MatchExpr" || expr.kind === "MatchStmt") {
      return Boolean(
        expr.arms &&
          expr.arms.length > 0 &&
          expr.arms.every((arm) => this.exprAlwaysReturns(arm.body))
      );
    }
    return false;
  }

  checkBlockStmt(
    block,
    parentScope,
    expectedType = null,
    createChildScope = true
  ) {
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
      case "ErrorStmt": {
        // Parser error recovery node: do not emit cascading type error, continue checking subsequent statements
        stmt.inferredType = Types.VOID;
        break;
      }

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
              stmt.init?.span || stmt.span,
              `Change the type annotation to \`${typeToString(initType)}\` or convert the initializer to \`${typeToString(declaredType)}\``
            );
          }
          varType = declaredType;
        } else if (isVoidType(initType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `cannot bind variable \`${stmt.name}\` to \`void\` expression`,
            stmt.init?.span || stmt.span,
            "Remove the `let` binding and call the `void` expression as a statement"
          );
          varType = Types.ERROR;
        }

        stmt.resolvedType = varType;
        stmt.inferredType = varType;
        scope.define(stmt.name, varType, {
          mutable: Boolean(stmt.mutable),
          declNode: stmt,
          span: stmt.span,
        });
        break;
      }

      case "AssignStmt": {
        const targetType = this.inferExpr(stmt.target, scope, null);
        if (stmt.target && stmt.target.kind === "IdentExpr") {
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
        const op = stmt.op || "=";

        if (!isErrorType(targetType) && !isErrorType(valType)) {
          if (op === "=") {
            if (!unify(targetType, valType)) {
              this.reportError(
                ErrorCodes.TYPE_MISMATCH,
                `mismatched types in assignment: expected \`${typeToString(targetType)}\`, found \`${typeToString(valType)}\``,
                stmt.value?.span || stmt.span,
                `Assign a value of type \`${typeToString(targetType)}\``
              );
            }
          } else if (op === "+=") {
            const validTarget =
              isNumericType(targetType) || isStringType(targetType);
            if (!validTarget) {
              this.reportError(
                ErrorCodes.TYPE_BINARY_OP_MISMATCH,
                `compound assignment \`+=\` cannot be applied to type \`${typeToString(targetType)}\``,
                stmt.span,
                "Use `+=` only with numeric types (`i32`, `i64`, `f64`) or `string`"
              );
            } else if (!unify(targetType, valType)) {
              this.reportError(
                ErrorCodes.TYPE_MISMATCH,
                `mismatched types in \`+=\`: target is \`${typeToString(targetType)}\`, but right-hand side is \`${typeToString(valType)}\``,
                stmt.value?.span || stmt.span,
                `Provide a right-hand side of type \`${typeToString(targetType)}\``
              );
            }
          } else if (op === "-=" || op === "*=" || op === "/=") {
            if (!isNumericType(targetType)) {
              this.reportError(
                ErrorCodes.TYPE_BINARY_OP_MISMATCH,
                `compound assignment \`${op}\` requires a numeric target, found \`${typeToString(targetType)}\``,
                stmt.span,
                `Use \`${op}\` only with numeric variables (\`i32\`, \`i64\`, or \`f64\`)`
              );
            } else if (!unify(targetType, valType)) {
              this.reportError(
                ErrorCodes.TYPE_MISMATCH,
                `mismatched types in \`${op}\`: target is \`${typeToString(targetType)}\`, but right-hand side is \`${typeToString(valType)}\``,
                stmt.value?.span || stmt.span,
                `Provide a right-hand side of type \`${typeToString(targetType)}\``
              );
            }
          }
        }

        stmt.inferredType = Types.VOID;
        break;
      }

      case "ReturnStmt": {
        const expectedRet = scope.returnType || Types.VOID;
        if (stmt.value) {
          const actualRet = this.inferExpr(stmt.value, scope, expectedRet);
          if (!isErrorType(expectedRet) && !isErrorType(actualRet)) {
            if (isVoidType(expectedRet) && !isVoidType(actualRet)) {
              this.reportError(
                ErrorCodes.TYPE_RETURN_MISMATCH,
                `cannot return a value of type \`${typeToString(actualRet)}\` from a \`void\` function`,
                stmt.value.span || stmt.span,
                `Use bare \`return;\` or add \`-> ${typeToString(actualRet)}\` to the function signature`
              );
            } else if (!unify(expectedRet, actualRet)) {
              this.reportError(
                ErrorCodes.TYPE_RETURN_MISMATCH,
                `mismatched return type: expected \`${typeToString(expectedRet)}\`, found \`${typeToString(actualRet)}\``,
                stmt.value.span || stmt.span,
                `Return an expression of type \`${typeToString(expectedRet)}\``
              );
            }
          }
        } else if (!isVoidType(expectedRet) && !isErrorType(expectedRet)) {
          this.reportError(
            ErrorCodes.TYPE_RETURN_MISMATCH,
            `expected return value of type \`${typeToString(expectedRet)}\`, found bare \`return\``,
            stmt.span,
            `Return a value of type \`${typeToString(expectedRet)}\`: \`return <expr>;\``
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
            stmt.cond?.span || stmt.span,
            "Use a boolean condition such as `x != 0` or `x > 0`"
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
            stmt.cond?.span || stmt.span,
            "Use a boolean condition such as `i < n`"
          );
        }
        const loopScope = scope.childLoop();
        this.checkBlockStmt(stmt.body, loopScope, null, false);
        stmt.inferredType = Types.VOID;
        break;
      }

      case "ForStmt": {
        const iterExpr = stmt.iterable;
        const iterType = this.inferExpr(iterExpr, scope, null);
        let elemType = Types.I32;

        if (iterExpr && iterExpr.kind === "RangeExpr") {
          elemType = Types.I32;
        } else if (!isErrorType(iterType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `\`for\` loop in M2 expects a range \`start..end\`, found \`${typeToString(iterType)}\``,
            iterExpr?.span || stmt.span,
            `Use an integer range expression such as \`for ${stmt.iteratorVar} in 0..10 { ... }\``
          );
          elemType = Types.ERROR;
        } else {
          elemType = Types.ERROR;
        }

        stmt.iteratorType = elemType;
        stmt.inferredType = Types.VOID;

        const loopScope = scope.childLoop();
        loopScope.define(stmt.iteratorVar, elemType, {
          mutable: Boolean(stmt.mutable),
          declNode: stmt,
          span: stmt.span,
        });
        this.checkBlockStmt(stmt.body, loopScope, null, false);
        break;
      }

      case "BreakStmt":
      case "ContinueStmt": {
        if (scope.loopDepth <= 0) {
          const kw = stmt.kind === "BreakStmt" ? "break" : "continue";
          this.reportError(
            ErrorCodes.TYPE_BREAK_OUTSIDE_LOOP,
            `\`${kw}\` cannot be used outside of a loop`,
            stmt.span,
            `Move \`${kw}\` inside a \`while\` or \`for\` loop, or use \`return\` to exit a function`
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
      case "ErrorExpr": {
        // Parser error recovery node: suppress cascading errors
        resultType = Types.ERROR;
        break;
      }

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

      case "RangeExpr": {
        const startType = this.inferExpr(expr.start, scope, Types.I32);
        const endType = this.inferExpr(expr.end, scope, Types.I32);
        if (!isPrimitiveType(startType, "i32") && !isErrorType(startType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `range start bound must be \`i32\`, found \`${typeToString(startType)}\``,
            expr.start?.span || expr.span,
            "Provide an `i32` start value for the range `start..end`"
          );
        }
        if (!isPrimitiveType(endType, "i32") && !isErrorType(endType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `range end bound must be \`i32\`, found \`${typeToString(endType)}\``,
            expr.end?.span || expr.span,
            "Provide an `i32` end value for the range `start..end`"
          );
        }
        expr.elemType = Types.I32;
        resultType = Types.I32;
        break;
      }

      case "IdentExpr": {
        if (expr.name === "_error") {
          resultType = Types.ERROR;
          break;
        }
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
          scope.collectVisibleNames()
        );
        this.reportError(
          ErrorCodes.TYPE_UNDEFINED_VAR,
          `undefined variable \`${expr.name}\``,
          expr.span,
          closest
            ? `Did you mean \`${closest}\`?`
            : `Declare \`${expr.name}\` with \`let ${expr.name} = ...;\` before using it`
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
              expr.span,
              "Unary `-` can only be applied to numeric types (`i32`, `i64`, or `f64`)"
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
              expr.span,
              isIntegerType(opType)
                ? "Use `~` for bitwise NOT on integers, or `expr == 0` for boolean comparison"
                : "Logical `!` requires a `bool` operand"
            );
            resultType = Types.ERROR;
          } else {
            resultType = Types.BOOL;
          }
        } else if (expr.op === "~") {
          if (!isIntegerType(opType)) {
            this.reportError(
              ErrorCodes.TYPE_UNARY_OP_MISMATCH,
              `bitwise \`~\` requires integer operand (\`i32\` or \`i64\`), found \`${typeToString(opType)}\``,
              expr.span,
              isBoolType(opType)
                ? "Use `!` for logical NOT on `bool`"
                : "Bitwise `~` can only be applied to `i32` or `i64` integers"
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
        resultType = this.checkBlockStmt(expr.block || expr, scope, expectedType, true);
        break;
      }

      case "BlockStmt": {
        resultType = this.checkBlockStmt(expr, scope, expectedType, true);
        break;
      }

      case "IfExpr": {
        const condType = this.inferExpr(expr.cond, scope, Types.BOOL);
        if (!isBoolType(condType) && !isErrorType(condType)) {
          this.reportError(
            ErrorCodes.TYPE_CONDITION_NOT_BOOL,
            `\`if\` condition must be \`bool\`, found \`${typeToString(condType)}\``,
            expr.cond?.span || expr.span,
            "Use a boolean condition such as `x != 0` or `x > 0`"
          );
        }
        const thenType = this.checkBlockStmt(
          expr.thenBlock,
          scope,
          expectedType,
          true
        );
        const elseType = expr.elseBlock
          ? this.checkBlockStmt(
              expr.elseBlock,
              scope,
              expectedType || thenType,
              true
            )
          : Types.VOID;

        if (!isErrorType(thenType) && !isErrorType(elseType) && !unify(thenType, elseType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `\`if\` and \`else\` branches have incompatible types: \`${typeToString(thenType)}\` vs \`${typeToString(elseType)}\``,
            expr.span,
            `Ensure both \`if\` and \`else\` branches return \`${typeToString(thenType)}\``
          );
          resultType = Types.ERROR;
        } else {
          resultType = isErrorType(thenType)
            ? unwrapType(elseType)
            : unwrapType(thenType);
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
          (!isVoidType(srcType) && typesEqual(srcType, targetType)) ||
          (isNumericType(srcType) && isNumericType(targetType)) ||
          (isBoolType(srcType) && isNumericType(targetType));

        if (!validCast) {
          let suggestion =
            "Use `as` only to cast numeric or boolean values to `i32`, `i64`, or `f64`";
          if (isStringType(srcType) && isIntegerType(targetType)) {
            suggestion = "Use `str_to_int(expr)` to convert a `string` to `i32`";
          } else if (isPrimitiveType(srcType, "i32") && isStringType(targetType)) {
            suggestion = "Use `int_to_string(expr)` to convert `i32` to `string`";
          } else if (isPrimitiveType(srcType, "i64") && isStringType(targetType)) {
            suggestion = "Use `i64_to_string(expr)` to convert `i64` to `string`";
          } else if (isPrimitiveType(srcType, "f64") && isStringType(targetType)) {
            suggestion = "Use `float_to_string(expr)` to convert `f64` to `string`";
          } else if (isBoolType(srcType) && isStringType(targetType)) {
            suggestion = "Use `bool_to_string(expr)` to convert `bool` to `string`";
          } else if (isNumericType(srcType) && isBoolType(targetType)) {
            suggestion = "Use a comparison like `expr != 0` instead of casting to `bool`";
          }
          this.reportError(
            ErrorCodes.TYPE_INVALID_CAST,
            `cannot cast \`${typeToString(srcType)}\` to \`${typeToString(targetType)}\``,
            expr.span,
            suggestion
          );
          resultType = Types.ERROR;
        } else {
          resultType = targetType;
        }
        break;
      }

      case "StructLitExpr": {
        const structName = expr.structName;
        const structDef = this.env.getStruct(structName);
        if (!structDef) {
          this.reportError(
            ErrorCodes.TYPE_UNDEFINED_TYPE,
            `unknown struct \`${structName}\``,
            expr.span,
            "Declare the struct with `struct` before instantiating it"
          );
          resultType = Types.ERROR;
          break;
        }

        const typeArgs = expr.typeArgs?.length
          ? expr.typeArgs.map((t) => this.resolveTypeNode(t, scope))
          : null;
        const instantiated = this.env.instantiateStruct(structName, typeArgs);
        const defFields = new Map(
          structDef.fields.map((f, i) => [
            f.name,
            { index: i, type: instantiated.fields ? instantiated.fields[i].type : f.type },
          ])
        );

        const seenFields = new Set();
        for (const f of expr.fields || []) {
          if (seenFields.has(f.name)) {
            this.reportError(
              ErrorCodes.TYPE_DUPLICATE_FIELD,
              `duplicate field \`${f.name}\` in struct literal \`${structName}\``,
              f.span || expr.span,
              `Remove the duplicate initialization of field \`${f.name}\``
            );
          }
          seenFields.add(f.name);

          if (!defFields.has(f.name)) {
            this.reportError(
              ErrorCodes.TYPE_UNKNOWN_FIELD,
              `unknown field \`${f.name}\` for struct \`${structName}\``,
              f.span || expr.span,
              `Available fields on \`${structName}\` are: ${Array.from(defFields.keys()).map((k) => `\`${k}\``).join(", ")}`
            );
            this.inferExpr(f.value, scope, null);
          } else {
            const expectedFieldType = defFields.get(f.name).type;
            const actualFieldType = this.inferExpr(f.value, scope, expectedFieldType);
            if (!unify(expectedFieldType, actualFieldType) && !isErrorType(actualFieldType)) {
              this.reportError(
                ErrorCodes.TYPE_MISMATCH,
                `field \`${f.name}\` of struct \`${structName}\` has type \`${typeToString(expectedFieldType)}\`, found \`${typeToString(actualFieldType)}\``,
                f.value?.span || f.span || expr.span,
                `Provide a value of type \`${typeToString(expectedFieldType)}\` for field \`${f.name}\``
              );
            }
          }
        }

        // Check missing fields
        for (const [fname, finfo] of defFields.entries()) {
          if (!seenFields.has(fname)) {
            this.reportError(
              ErrorCodes.TYPE_MISSING_FIELD,
              `missing field \`${fname}\` in struct literal \`${structName}\``,
              expr.span,
              `Add \`${fname}: ...\` to initialize the struct`
            );
          }
        }

        expr.structDef = structDef;
        resultType = instantiated;
        break;
      }

      case "FieldExpr": {
        const objType = unwrapType(this.inferExpr(expr.object, scope, null));
        if (isErrorType(objType)) {
          resultType = Types.ERROR;
          break;
        }
        if (objType.tag !== "struct") {
          this.reportError(
            ErrorCodes.TYPE_UNKNOWN_FIELD,
            `cannot access field \`${expr.field}\` on non-struct type \`${typeToString(objType)}\``,
            expr.span,
            "Field access `obj.field` requires a struct expression"
          );
          resultType = Types.ERROR;
          break;
        }

        const structDef = this.env.getStruct(objType.name);
        if (!structDef) {
          resultType = Types.ERROR;
          break;
        }

        const fieldIdx = structDef.fields.findIndex((f) => f.name === expr.field);
        if (fieldIdx === -1) {
          this.reportError(
            ErrorCodes.TYPE_UNKNOWN_FIELD,
            `unknown field \`${expr.field}\` on struct \`${objType.name}\``,
            expr.span,
            `Available fields on \`${objType.name}\` are: ${structDef.fields.map((f) => `\`${f.name}\``).join(", ")}`
          );
          resultType = Types.ERROR;
          break;
        }

        expr.fieldIndex = fieldIdx;
        const fType = objType.fields ? objType.fields[fieldIdx].type : structDef.fields[fieldIdx].type;
        resultType = unwrapType(fType);
        break;
      }

      case "ArrayLitExpr": {
        const elements = expr.elements || [];
        let elemType = null;
        if (expectedType && unwrapType(expectedType).tag === "array") {
          elemType = unwrapType(expectedType).elem;
        }

        if (elements.length === 0) {
          resultType = Types.array(elemType || Types.typevar());
          break;
        }

        let inferredElemType = elemType;
        for (let i = 0; i < elements.length; i++) {
          const e = elements[i];
          const eType = this.inferExpr(e, scope, inferredElemType);
          if (!inferredElemType) {
            inferredElemType = eType;
          } else if (!unify(inferredElemType, eType) && !isErrorType(eType)) {
            this.reportError(
              ErrorCodes.TYPE_MISMATCH,
              `element ${i} of array has type \`${typeToString(eType)}\`, expected \`${typeToString(inferredElemType)}\``,
              e.span || expr.span,
              `Ensure all array elements have type \`${typeToString(inferredElemType)}\``
            );
          }
        }

        resultType = Types.array(inferredElemType || Types.I32);
        break;
      }

      case "IndexExpr": {
        const objType = unwrapType(this.inferExpr(expr.object, scope, null));
        const idxType = unwrapType(this.inferExpr(expr.index, scope, Types.I32));

        if (!isErrorType(objType)) {
          if (objType.tag !== "array") {
            this.reportError(
              ErrorCodes.TYPE_NOT_INDEXABLE,
              `cannot index value of type \`${typeToString(objType)}\``,
              expr.object?.span || expr.span,
              "Only array types `[T]` can be indexed with `[...]`"
            );
          }
        }

        if (!isErrorType(idxType)) {
          if (!isIntegerType(idxType)) {
            this.reportError(
              ErrorCodes.TYPE_INDEX_NOT_INT,
              `array index must be an integer (\`i32\` or \`i64\`), found \`${typeToString(idxType)}\``,
              expr.index?.span || expr.span,
              "Use an `i32` or `i64` integer value for the array index"
            );
          }
        }

        if (objType.tag === "array") {
          resultType = unwrapType(objType.elem);
        } else {
          resultType = Types.ERROR;
        }
        break;
      }

      case "EnumInitExpr": {
        const variantName = expr.variantName;
        let enumDef = null;
        if (expr.enumName) {
          enumDef = this.env.getEnum(expr.enumName);
        } else {
          const vInfo = this.env.lookupVariant(variantName);
          if (vInfo) enumDef = this.env.getEnum(vInfo.enumName);
        }

        if (!enumDef) {
          this.reportError(
            ErrorCodes.TYPE_UNKNOWN_VARIANT,
            `unknown enum variant \`${variantName}\``,
            expr.span,
            "Check the variant name or declare the enum"
          );
          resultType = Types.ERROR;
          break;
        }

        const variant = enumDef.variants.find((v) => v.name === variantName);
        if (!variant) {
          this.reportError(
            ErrorCodes.TYPE_UNKNOWN_VARIANT,
            `variant \`${variantName}\` does not exist on enum \`${enumDef.name}\``,
            expr.span,
            `Available variants of \`${enumDef.name}\` are: ${enumDef.variants.map((v) => `\`${v.name}\``).join(", ")}`
          );
          resultType = Types.ERROR;
          break;
        }

        const expectedArity = variant.fields.length;
        const actualArity = (expr.args || []).length;
        if (actualArity !== expectedArity) {
          this.reportError(
            ErrorCodes.TYPE_ARITY_MISMATCH,
            `variant \`${variantName}\` expects ${expectedArity} arguments, found ${actualArity}`,
            expr.span,
            `Pass ${expectedArity} arguments to \`${variantName}(...)\``
          );
        }

        let typeArgs = null;
        if (
          expectedType &&
          unwrapType(expectedType).tag === "enum" &&
          unwrapType(expectedType).name === enumDef.name
        ) {
          typeArgs = unwrapType(expectedType).typeArgs;
        }
        const instEnum = this.env.instantiateEnum(enumDef.name, typeArgs);
        const instVariant =
          instEnum && instEnum.variants
            ? instEnum.variants.find((v) => v.name === variantName)
            : variant;

        for (let i = 0; i < actualArity; i++) {
          const expectedFieldType =
            instVariant && instVariant.fields && instVariant.fields[i]
              ? instVariant.fields[i]
              : null;
          const actualArgType = this.inferExpr(expr.args[i], scope, expectedFieldType);
          if (
            expectedFieldType &&
            !unify(expectedFieldType, actualArgType) &&
            !isErrorType(actualArgType)
          ) {
            this.reportError(
              ErrorCodes.TYPE_MISMATCH,
              `argument ${i + 1} of variant \`${variantName}\` has type \`${typeToString(actualArgType)}\`, expected \`${typeToString(expectedFieldType)}\``,
              expr.args[i]?.span || expr.span,
              `Provide an argument of type \`${typeToString(expectedFieldType)}\``
            );
          }
        }

        expr.tagIndex = variant.tagIndex;
        expr.enumDef = enumDef;
        resultType = instEnum;
        break;
      }

      case "MatchExpr": {
        const scrutineeNode = expr.scrutinee || expr.expr;
        const scrutineeType = unwrapType(this.inferExpr(scrutineeNode, scope, null));
        const arms = expr.arms || [];

        // Exhaustiveness & Redundancy checks
        if (!isErrorType(scrutineeType)) {
          const exhDiagnostics = checkMatchExhaustiveness(
            scrutineeType,
            arms,
            this.env,
            expr.span,
            this.sourceMap
          );
          for (const d of exhDiagnostics) {
            d.sourceLine = this.getSourceLine(d.span);
            this.diagnostics.push(d);
          }
        }

        let armResultType = expectedType;
        for (let i = 0; i < arms.length; i++) {
          const arm = arms[i];
          const armScope = scope.child();
          this.checkPattern(arm.pattern, scrutineeType, armScope);

          if (arm.guard) {
            const guardType = this.inferExpr(arm.guard, armScope, Types.BOOL);
            if (!isBoolType(guardType) && !isErrorType(guardType)) {
              this.reportError(
                ErrorCodes.TYPE_CONDITION_NOT_BOOL,
                `match guard condition must be \`bool\`, found \`${typeToString(guardType)}\``,
                arm.guard.span,
                "Use a boolean expression for the match guard"
              );
            }
          }

          const bodyType = this.inferExpr(arm.body, armScope, armResultType);
          if (!armResultType) {
            armResultType = bodyType;
          } else if (!unify(armResultType, bodyType) && !isErrorType(bodyType)) {
            this.reportError(
              ErrorCodes.TYPE_MISMATCH,
              `match arm ${i + 1} has type \`${typeToString(bodyType)}\`, expected \`${typeToString(armResultType)}\``,
              arm.body?.span || arm.span,
              `Ensure all match arms return values of type \`${typeToString(armResultType)}\``
            );
          }
        }

        resultType = armResultType || Types.VOID;
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

  checkPattern(pattern, expectedType, scope) {
    if (!pattern) return;
    const baseType = unwrapType(expectedType);
    pattern.inferredType = baseType;

    switch (pattern.kind) {
      case "WildcardPattern":
        break;

      case "VarPattern": {
        scope.define(pattern.name, baseType, {
          mutable: Boolean(pattern.mutable),
          span: pattern.span,
        });
        break;
      }

      case "LiteralPattern": {
        const litNode = pattern.literal || pattern;
        let litType = Types.I32;
        switch (litNode.literalType) {
          case "i32":
            litType = Types.I32;
            break;
          case "i64":
            litType = Types.I64;
            break;
          case "f64":
            litType = Types.F64;
            break;
          case "bool":
            litType = Types.BOOL;
            break;
          case "string":
            litType = Types.STRING;
            break;
        }
        pattern.inferredType = litType;
        if (pattern.literal) pattern.literal.inferredType = litType;
        if (!unify(baseType, litType) && !isErrorType(baseType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `pattern of type \`${typeToString(litType)}\` cannot match expression of type \`${typeToString(baseType)}\``,
            pattern.span,
            `Use a literal pattern of type \`${typeToString(baseType)}\``
          );
        }
        break;
      }

      case "EnumPattern": {
        let enumDef = null;
        const variantName = pattern.variantName;
        if (pattern.enumName) {
          enumDef = this.env.getEnum(pattern.enumName);
        } else if (baseType.tag === "enum") {
          enumDef = this.env.getEnum(baseType.name);
        } else {
          const vInfo = this.env.lookupVariant(variantName);
          if (vInfo) enumDef = this.env.getEnum(vInfo.enumName);
        }

        if (!enumDef) {
          this.reportError(
            ErrorCodes.TYPE_UNKNOWN_VARIANT,
            `unknown enum or variant \`${variantName}\``,
            pattern.span,
            "Check the variant name or enum definition"
          );
          return;
        }

        const variant = enumDef.variants.find((v) => v.name === variantName);
        if (!variant) {
          this.reportError(
            ErrorCodes.TYPE_UNKNOWN_VARIANT,
            `variant \`${variantName}\` does not exist on enum \`${enumDef.name}\``,
            pattern.span,
            `Check available variants of \`${enumDef.name}\``
          );
          return;
        }

        const expectedArity = variant.fields.length;
        const actualArity = (pattern.args || []).length;
        if (actualArity !== expectedArity) {
          this.reportError(
            ErrorCodes.MATCH_PATTERN_ARITY,
            `variant \`${variantName}\` expects ${expectedArity} pattern arguments, found ${actualArity}`,
            pattern.span,
            `Match \`${variantName}\` with ${expectedArity} arguments: \`${variantName}(...)\``
          );
        }

        const instantiatedEnum = this.env.instantiateEnum(
          enumDef.name,
          baseType.typeArgs || null
        );
        if (!unify(baseType, instantiatedEnum) && !isErrorType(baseType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `pattern \`${variantName}\` belongs to enum \`${enumDef.name}\`, but match expression has type \`${typeToString(baseType)}\``,
            pattern.span,
            `Ensure the pattern matches the scrutinee type \`${typeToString(baseType)}\``
          );
        }

        const instVariant =
          instantiatedEnum?.variants?.find((v) => v.name === variantName) || variant;
        for (let i = 0; i < Math.min(actualArity, expectedArity); i++) {
          const fieldType = instVariant.fields[i];
          this.checkPattern(pattern.args[i], fieldType, scope);
        }
        break;
      }

      case "StructPattern": {
        const structName = pattern.structName;
        const structDef = this.env.getStruct(structName);
        if (!structDef) {
          this.reportError(
            ErrorCodes.TYPE_UNDEFINED_TYPE,
            `unknown struct \`${structName}\` in pattern`,
            pattern.span,
            "Check the struct name spelling or define the struct"
          );
          return;
        }

        const instantiatedStruct = this.env.instantiateStruct(
          structName,
          baseType.typeArgs || null
        );
        if (!unify(baseType, instantiatedStruct) && !isErrorType(baseType)) {
          this.reportError(
            ErrorCodes.TYPE_MISMATCH,
            `struct pattern \`${structName}\` cannot match expression of type \`${typeToString(baseType)}\``,
            pattern.span,
            `Ensure the pattern matches the scrutinee type \`${typeToString(baseType)}\``
          );
        }

        const structFields = new Map(structDef.fields.map((f) => [f.name, f.type]));
        for (const f of pattern.fields || []) {
          if (!structFields.has(f.name)) {
            this.reportError(
              ErrorCodes.TYPE_UNKNOWN_FIELD,
              `unknown field \`${f.name}\` in struct pattern \`${structName}\``,
              f.span,
              `Available fields on \`${structName}\` are: ${Array.from(structFields.keys()).map((k) => `\`${k}\``).join(", ")}`
            );
          } else {
            const fieldType = structFields.get(f.name);
            this.checkPattern(f.pattern, fieldType, scope);
          }
        }
        break;
      }
    }
  }

  inferCallExpr(expr, scope, expectedType = null) {
    const args = expr.args || [];

    // Direct named function or built-in call
    if (expr.callee && expr.callee.kind === "IdentExpr") {
      const fnName = expr.callee.name;
      if (fnName === "_error") {
        for (const arg of args) {
          this.inferExpr(arg, scope, null);
        }
        expr.callee.inferredType = Types.ERROR;
        return Types.ERROR;
      }

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
            closest
              ? `Did you mean \`${closest}\`?`
              : `Define \`fn ${fnName}(...) { ... }\` before calling it`
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
            expr.span,
            `Pass ${expectedCountStr} argument(s) when calling \`${fnName}\``
          );
          return fnDef.isDiverging
            ? expectedType || Types.VOID
            : fnDef.returnType;
        }

        // Polymorphic `print` and `println`
        if (fnDef.isPolymorphicPrint) {
          const resolvedArgTypes = [];
          for (const arg of args) {
            const argType = this.inferExpr(arg, scope, null);
            resolvedArgTypes.push(argType);
            if (isVoidType(argType)) {
              this.reportError(
                ErrorCodes.TYPE_MISMATCH,
                `cannot pass \`void\` expression to \`${fnName}\``,
                arg.span || expr.span,
                `Pass a printable value (\`string\`, \`i32\`, \`i64\`, \`f64\`, or \`bool\`) to \`${fnName}\``
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
              args[0].span,
              "Pass a boolean condition as the first argument to `assert`"
            );
          }
          if (args.length >= 2) {
            const msgType = this.inferExpr(args[1], scope, Types.STRING);
            if (!isStringType(msgType) && !isErrorType(msgType)) {
              this.reportError(
                ErrorCodes.TYPE_MISMATCH,
                `second argument to \`assert\` must be \`string\`, found \`${typeToString(msgType)}\``,
                args[1].span,
                "Pass a `string` error message as the second argument to `assert`"
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
              args[0].span,
              "Pass a `string` message to `panic(\"...\")`"
            );
          }
          return expectedType || Types.VOID;
        }

        // Standard function call
        let paramTypes = fnDef.paramTypes;
        let returnType = fnDef.returnType;
        if (fnDef.typeParams && fnDef.typeParams.length > 0) {
          const subst = new Map();
          for (const tp of fnDef.typeParams) {
            subst.set(tp, Types.typevar(tp));
          }
          paramTypes = fnDef.paramTypes.map((pt) =>
            substituteTypeParams(pt, subst)
          );
          returnType = substituteTypeParams(fnDef.returnType, subst);
        }

        for (let i = 0; i < args.length; i++) {
          const paramType = paramTypes[i];
          const argType = this.inferExpr(args[i], scope, paramType);
          if (
            !isErrorType(paramType) &&
            !isErrorType(argType) &&
            !unify(paramType, argType)
          ) {
            this.reportError(
              ErrorCodes.TYPE_MISMATCH,
              `argument ${i + 1} to \`${fnName}\` has incompatible type: expected \`${typeToString(paramType)}\`, found \`${typeToString(argType)}\``,
              args[i].span || expr.span,
              `Pass a value of type \`${typeToString(paramType)}\` for argument ${i + 1} of \`${fnName}\``
            );
          }
        }

        return unwrapType(returnType);
      }
    }

    // Variable / expression callee
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
        expr.callee?.span || expr.span,
        `Remove the call parentheses \`(...)\` or call a function instead of a \`${typeToString(calleeType)}\` value`
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
        expr.span,
        `Pass ${calleeType.params.length} argument(s) to this function`
      );
      return unwrapType(calleeType.ret);
    }

    for (let i = 0; i < args.length; i++) {
      const paramType = calleeType.params[i];
      const argType = this.inferExpr(args[i], scope, paramType);
      if (!isErrorType(paramType) && !isErrorType(argType) && !unify(paramType, argType)) {
        this.reportError(
          ErrorCodes.TYPE_MISMATCH,
          `argument ${i + 1} has incompatible type: expected \`${typeToString(paramType)}\`, found \`${typeToString(argType)}\``,
          args[i].span || expr.span,
          `Pass a value of type \`${typeToString(paramType)}\` for argument ${i + 1}`
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
          expr.span,
          `Convert both operands of \`${op}\` to \`bool\` expressions`
        );
        return Types.ERROR;
      }
      return Types.BOOL;
    }

    // Equality operators `==`, `!=`
    if (op === "==" || op === "!=") {
      if (isVoidType(leftType) || isVoidType(rightType) || !unify(leftType, rightType)) {
        this.reportError(
          ErrorCodes.TYPE_BINARY_OP_MISMATCH,
          `cannot compare \`${typeToString(leftType)}\` and \`${typeToString(rightType)}\` with \`${op}\``,
          expr.span,
          `Ensure both sides of \`${op}\` have the same non-void type`
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
          expr.span,
          `Use matching ordered types (\`i32\`, \`i64\`, \`f64\`, or \`string\`) with \`${op}\``
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
      let suggestion =
        "Use matching numeric types (`i32`, `i64`, `f64`) or `string + string`";
      if (isStringType(leftType) || isStringType(rightType)) {
        suggestion =
          "Convert non-string operand to `string` with `int_to_string`, `float_to_string`, or `bool_to_string` before concatenating";
      } else if (isNumericType(leftType) && isNumericType(rightType)) {
        suggestion = `Cast one operand with \`as ${typeToString(leftType)}\` so both operands have the same numeric type`;
      }
      this.reportError(
        ErrorCodes.TYPE_BINARY_OP_MISMATCH,
        `operator \`+\` cannot be applied to \`${typeToString(leftType)}\` and \`${typeToString(rightType)}\``,
        expr.span,
        suggestion
      );
      return Types.ERROR;
    }

    // Arithmetic `-`, `*`, `/`, `%`
    if (op === "-" || op === "*" || op === "/" || op === "%") {
      if (isNumericType(leftType) && unify(leftType, rightType)) {
        return unwrapType(leftType);
      }
      const suggestion =
        isNumericType(leftType) && isNumericType(rightType)
          ? `Cast one operand with \`as ${typeToString(leftType)}\` so both sides have the same numeric type`
          : `Operator \`${op}\` requires matching numeric operands (\`i32\`, \`i64\`, or \`f64\`)`;
      this.reportError(
        ErrorCodes.TYPE_BINARY_OP_MISMATCH,
        `arithmetic operator \`${op}\` cannot be applied to \`${typeToString(leftType)}\` and \`${typeToString(rightType)}\``,
        expr.span,
        suggestion
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
        `bitwise operator \`${op}\` requires matching integer operands (\`i32\` or \`i64\`), found \`${typeToString(leftType)}\` and \`${typeToString(rightType)}\``,
        expr.span,
        `Use \`i32\` or \`i64\` operands of the same width with bitwise \`${op}\``
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
