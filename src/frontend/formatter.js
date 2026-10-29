/**
 * Lumen Source Code Formatter (`src/frontend/formatter.js`)
 * Canonical 4-space AST pretty-printer for `lumen fmt`.
 * Returns the original source unchanged if any lexical or syntax errors exist.
 */

import { parse } from "./parser.js";

const INDENT = "    ";

const OP_PRECEDENCE = {
  "..": 1,
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  "<=": 5,
  ">": 5,
  ">=": 5,
  "|": 6,
  "^": 7,
  "&": 8,
  "<<": 9,
  ">>": 9,
  "+": 10,
  "-": 10,
  "*": 11,
  "/": 11,
  "%": 11,
};

function escapeString(str) {
  let out = '"';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    switch (ch) {
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\0":
        out += "\\0";
        break;
      default:
        out += ch;
        break;
    }
  }
  out += '"';
  return out;
}

function formatType(typeNode) {
  if (!typeNode) return "void";
  switch (typeNode.kind) {
    case "NamedType": {
      if (typeNode.typeArgs && typeNode.typeArgs.length > 0) {
        return `${typeNode.name}<${typeNode.typeArgs.map(formatType).join(", ")}>`;
      }
      return typeNode.name;
    }
    case "ArrayType":
      return `[${formatType(typeNode.elem)}]`;
    case "FnType": {
      const params = (typeNode.params || []).map(formatType).join(", ");
      const ret = formatType(typeNode.ret);
      return `fn(${params}) -> ${ret}`;
    }
    default:
      return "void";
  }
}

function formatPattern(pat) {
  if (!pat) return "_";
  switch (pat.kind) {
    case "WildcardPattern":
      return "_";
    case "VarPattern":
      return pat.name;
    case "LiteralPattern":
      return formatLiteral(pat.literal);
    case "EnumPattern": {
      const prefix = pat.enumName ? `${pat.enumName}::` : "";
      if (pat.args && pat.args.length > 0) {
        return `${prefix}${pat.variantName}(${pat.args.map(formatPattern).join(", ")})`;
      }
      return `${prefix}${pat.variantName}`;
    }
    case "StructPattern": {
      if (!pat.fields || pat.fields.length === 0) {
        return `${pat.structName} {}`;
      }
      const fields = pat.fields
        .map((f) => {
          if (f.pattern.kind === "VarPattern" && f.pattern.name === f.name) {
            return f.name;
          }
          return `${f.name}: ${formatPattern(f.pattern)}`;
        })
        .join(", ");
      return `${pat.structName} { ${fields} }`;
    }
    default:
      return "_";
  }
}

function formatLiteral(lit) {
  if (!lit) return "()";
  switch (lit.literalType) {
    case "i32":
      return String(lit.value);
    case "i64":
      return `${String(lit.value)}i64`;
    case "f64": {
      const s = String(lit.value);
      return s.includes(".") || s.includes("e") || s.includes("E")
        ? s
        : `${s}.0`;
    }
    case "bool":
      return lit.value ? "true" : "false";
    case "string":
      return escapeString(String(lit.value ?? ""));
    case "void":
      return "()";
    default:
      return String(lit.value);
  }
}

function formatExpr(expr, level = 0, parentPrec = 0, isRightChild = false) {
  if (!expr) return "";

  switch (expr.kind) {
    case "LiteralExpr":
      return formatLiteral(expr);

    case "IdentExpr": {
      if (expr.typeArgs && expr.typeArgs.length > 0) {
        return `${expr.name}::<${expr.typeArgs.map(formatType).join(", ")}>`;
      }
      return expr.name;
    }

    case "RangeExpr": {
      const prec = OP_PRECEDENCE[".."] || 1;
      const needsParens =
        prec < parentPrec || (isRightChild && prec === parentPrec);
      const startStr = formatExpr(expr.start, level, prec, false);
      const endStr = formatExpr(expr.end, level, prec, true);
      const combined = `${startStr}..${endStr}`;
      return needsParens ? `(${combined})` : combined;
    }

    case "BinaryExpr": {
      const prec = OP_PRECEDENCE[expr.op] || 1;
      const needsParens =
        prec < parentPrec || (isRightChild && prec === parentPrec);
      const leftStr = formatExpr(expr.left, level, prec, false);
      const rightStr = formatExpr(expr.right, level, prec, true);
      const combined =
        expr.op === ".."
          ? `${leftStr}..${rightStr}`
          : `${leftStr} ${expr.op} ${rightStr}`;
      return needsParens ? `(${combined})` : combined;
    }

    case "UnaryExpr": {
      const inner = formatExpr(expr.operand, level, 13, false);
      const str = `${expr.op}${inner}`;
      return parentPrec > 13 ? `(${str})` : str;
    }

    case "CastExpr": {
      const inner = formatExpr(expr.expr, level, 12, false);
      const str = `${inner} as ${formatType(expr.targetType)}`;
      return parentPrec > 12 ? `(${str})` : str;
    }

    case "CallExpr": {
      let calleeStr;
      if (
        expr.callee.kind === "IdentExpr" &&
        expr.typeArgs &&
        expr.typeArgs.length > 0
      ) {
        calleeStr = `${expr.callee.name}::<${expr.typeArgs.map(formatType).join(", ")}>`;
      } else {
        calleeStr = formatExpr(expr.callee, level, 14, false);
      }
      const argsStr = (expr.args || [])
        .map((a) => formatExpr(a, level, 0, false))
        .join(", ");
      return `${calleeStr}(${argsStr})`;
    }

    case "IndexExpr": {
      const objStr = formatExpr(expr.object, level, 14, false);
      const idxStr = formatExpr(expr.index, level, 0, false);
      return `${objStr}[${idxStr}]`;
    }

    case "FieldExpr": {
      const objStr = formatExpr(expr.object, level, 14, false);
      return `${objStr}.${expr.field}`;
    }

    case "StructLitExpr": {
      const tf =
        expr.typeArgs && expr.typeArgs.length > 0
          ? `::<${expr.typeArgs.map(formatType).join(", ")}>`
          : "";
      if (!expr.fields || expr.fields.length === 0) {
        return `${expr.structName}${tf} {}`;
      }
      const fieldsStr = expr.fields
        .map((f) => `${f.name}: ${formatExpr(f.value, level, 0, false)}`)
        .join(", ");
      return `${expr.structName}${tf} { ${fieldsStr} }`;
    }

    case "EnumInitExpr": {
      const tf =
        expr.typeArgs && expr.typeArgs.length > 0
          ? `::<${expr.typeArgs.map(formatType).join(", ")}>`
          : "";
      const prefix = expr.enumName ? `${expr.enumName}${tf}::` : "";
      const suffixTf = !expr.enumName ? tf : "";
      if (expr.args && expr.args.length > 0) {
        const argsStr = expr.args
          .map((a) => formatExpr(a, level, 0, false))
          .join(", ");
        return `${prefix}${expr.variantName}${suffixTf}(${argsStr})`;
      }
      return `${prefix}${expr.variantName}${suffixTf}`;
    }

    case "ArrayLitExpr": {
      const elems = (expr.elements || [])
        .map((e) => formatExpr(e, level, 0, false))
        .join(", ");
      return `[${elems}]`;
    }

    case "IfExpr": {
      const condStr = formatExpr(expr.cond, level, 0, false);
      const thenStr = formatBlock(expr.thenBlock, level);
      if (
        expr.elseBlock &&
        (expr.elseBlock.stmts.length > 0 || expr.elseBlock.tailExpr !== null)
      ) {
        if (
          expr.elseBlock.stmts.length === 0 &&
          expr.elseBlock.tailExpr &&
          expr.elseBlock.tailExpr.kind === "IfExpr"
        ) {
          return `if ${condStr} ${thenStr} else ${formatExpr(
            expr.elseBlock.tailExpr,
            level,
            0,
            false
          )}`;
        }
        return `if ${condStr} ${thenStr} else ${formatBlock(expr.elseBlock, level)}`;
      }
      return `if ${condStr} ${thenStr}`;
    }

    case "MatchExpr": {
      const pad = INDENT.repeat(level);
      const armPad = INDENT.repeat(level + 1);
      const scrutStr = formatExpr(expr.scrutinee, level, 0, false);
      if (!expr.arms || expr.arms.length === 0) {
        return `match ${scrutStr} {}`;
      }
      const armLines = expr.arms.map((arm) => {
        const patStr = formatPattern(arm.pattern);
        const guardStr = arm.guard
          ? ` if ${formatExpr(arm.guard, level + 1, 0, false)}`
          : "";
        if (arm.body.kind === "BlockStmt") {
          return `${armPad}${patStr}${guardStr} => ${formatBlock(arm.body, level + 1)},`;
        }
        return `${armPad}${patStr}${guardStr} => ${formatExpr(
          arm.body,
          level + 1,
          0,
          false
        )},`;
      });
      return `match ${scrutStr} {\n${armLines.join("\n")}\n${pad}}`;
    }

    case "ClosureExpr": {
      const paramsStr = (expr.params || [])
        .map((p) => (p.typeAnn ? `${p.name}: ${formatType(p.typeAnn)}` : p.name))
        .join(", ");
      const retStr = expr.returnType ? ` -> ${formatType(expr.returnType)} ` : " ";
      const bodyStr =
        expr.body.kind === "BlockStmt"
          ? formatBlock(expr.body, level)
          : formatExpr(expr.body, level, 0, false);
      return `|${paramsStr}|${retStr}${bodyStr}`;
    }

    case "BlockExpr":
      return formatBlock(expr.block, level);

    default:
      return "";
  }
}

function formatStmt(stmt, level) {
  const pad = INDENT.repeat(level);
  switch (stmt.kind) {
    case "BlockStmt":
      return `${pad}${formatBlock(stmt, level)}`;

    case "LetStmt": {
      const mutStr = stmt.mutable ? "mut " : "";
      const typeStr = stmt.typeAnn ? `: ${formatType(stmt.typeAnn)}` : "";
      const initStr = formatExpr(stmt.init, level, 0, false);
      return `${pad}let ${mutStr}${stmt.name}${typeStr} = ${initStr};`;
    }

    case "AssignStmt": {
      const targetStr = formatExpr(stmt.target, level, 0, false);
      const valStr = formatExpr(stmt.value, level, 0, false);
      return `${pad}${targetStr} ${stmt.op} ${valStr};`;
    }

    case "IfStmt":
      return `${pad}${formatIfStmtInline(stmt, level)}`;

    case "WhileStmt": {
      const condStr = formatExpr(stmt.cond, level, 0, false);
      return `${pad}while ${condStr} ${formatBlock(stmt.body, level)}`;
    }

    case "ForStmt": {
      const iterStr = formatExpr(stmt.iterable, level, 0, false);
      return `${pad}for ${stmt.iteratorVar} in ${iterStr} ${formatBlock(
        stmt.body,
        level
      )}`;
    }

    case "ReturnStmt": {
      if (stmt.value) {
        return `${pad}return ${formatExpr(stmt.value, level, 0, false)};`;
      }
      return `${pad}return;`;
    }

    case "BreakStmt":
      return `${pad}break;`;

    case "ContinueStmt":
      return `${pad}continue;`;

    case "ExprStmt": {
      const exprStr = formatExpr(stmt.expr, level, 0, false);
      if (stmt.expr.kind === "MatchExpr" || stmt.expr.kind === "IfExpr") {
        return `${pad}${exprStr}`;
      }
      return `${pad}${exprStr};`;
    }

    default:
      return "";
  }
}

function formatIfStmtInline(ifStmt, level) {
  const condStr = formatExpr(ifStmt.cond, level, 0, false);
  const thenStr = formatBlock(ifStmt.thenBranch, level);
  if (!ifStmt.elseBranch) {
    return `if ${condStr} ${thenStr}`;
  }
  if (ifStmt.elseBranch.kind === "IfStmt") {
    return `if ${condStr} ${thenStr} else ${formatIfStmtInline(
      ifStmt.elseBranch,
      level
    )}`;
  }
  return `if ${condStr} ${thenStr} else ${formatBlock(ifStmt.elseBranch, level)}`;
}

function formatBlock(block, level) {
  const pad = INDENT.repeat(level);
  const innerPad = INDENT.repeat(level + 1);
  const lines = [];

  for (const s of block.stmts || []) {
    lines.push(formatStmt(s, level + 1));
  }
  if (block.tailExpr) {
    lines.push(`${innerPad}${formatExpr(block.tailExpr, level + 1, 0, false)}`);
  }

  if (lines.length === 0) {
    return "{}";
  }
  return `{\n${lines.join("\n")}\n${pad}}`;
}

function formatDocComment(docComment) {
  if (!docComment) return "";
  return (
    docComment
      .split(/\r?\n/)
      .map((line) => (line.length > 0 ? `/// ${line}` : "///"))
      .join("\n") + "\n"
  );
}

function formatDecl(decl) {
  const docPrefix = formatDocComment(decl.docComment);
  const pubPrefix = decl.isPublic ? "pub " : "";
  const tpStr =
    decl.typeParams && decl.typeParams.length > 0
      ? `<${decl.typeParams.join(", ")}>`
      : "";

  switch (decl.kind) {
    case "FnDecl": {
      const paramsStr = (decl.params || [])
        .map((p) => {
          const mutStr = p.mutable ? "mut " : "";
          return `${mutStr}${p.name}: ${formatType(p.typeAnn)}`;
        })
        .join(", ");
      const retStr = decl.returnType ? ` -> ${formatType(decl.returnType)}` : "";
      return `${docPrefix}${pubPrefix}fn ${decl.name}${tpStr}(${paramsStr})${retStr} ${formatBlock(
        decl.body,
        0
      )}`;
    }

    case "StructDecl": {
      if (!decl.fields || decl.fields.length === 0) {
        return `${docPrefix}${pubPrefix}struct ${decl.name}${tpStr} {}`;
      }
      const fieldLines = decl.fields.map(
        (f) => `${INDENT}${f.name}: ${formatType(f.typeAnn)},`
      );
      return `${docPrefix}${pubPrefix}struct ${decl.name}${tpStr} {\n${fieldLines.join(
        "\n"
      )}\n}`;
    }

    case "EnumDecl": {
      if (!decl.variants || decl.variants.length === 0) {
        return `${docPrefix}${pubPrefix}enum ${decl.name}${tpStr} {}`;
      }
      const variantLines = decl.variants.map((v) => {
        if (v.payload && v.payload.length > 0) {
          return `${INDENT}${v.name}(${v.payload.map(formatType).join(", ")}),`;
        }
        return `${INDENT}${v.name},`;
      });
      return `${docPrefix}${pubPrefix}enum ${decl.name}${tpStr} {\n${variantLines.join(
        "\n"
      )}\n}`;
    }

    case "ConstDecl": {
      const typeStr = decl.typeAnn ? `: ${formatType(decl.typeAnn)}` : "";
      const initStr = formatExpr(decl.init, 0, 0, false);
      return `${docPrefix}${pubPrefix}const ${decl.name}${typeStr} = ${initStr};`;
    }

    default:
      return "";
  }
}

function formatImport(imp) {
  const pathStr = (imp.path || []).join("::");
  if (Array.isArray(imp.symbols)) {
    return `import ${pathStr}::{${imp.symbols.join(", ")}};`;
  }
  return `import ${pathStr};`;
}

function extractLeadingHeaderComments(source) {
  const lines = source.split(/\r?\n/);
  const header = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") && !trimmed.startsWith("///")) {
      header.push(trimmed);
    } else if (trimmed === "" && header.length > 0) {
      break;
    } else {
      break;
    }
  }
  return header.length > 0 ? header.join("\n") + "\n\n" : "";
}

/**
 * Format Lumen source code into canonical 4-space indented style.
 * If syntax or lex errors exist, returns the original source unchanged.
 * @param {string} source
 * @param {string} [filename="<input>"]
 * @returns {string}
 */
export function formatSource(source, filename = "<input>") {
  if (typeof source !== "string") return "";

  const { ast, diagnostics } = parse(source, filename, source);
  if (!ast || diagnostics.some((d) => d.severity === "error")) {
    return source;
  }

  const headerComments = extractLeadingHeaderComments(source);
  const sections = [];

  if (ast.imports && ast.imports.length > 0) {
    sections.push(ast.imports.map(formatImport).join("\n"));
  }

  if (ast.decls && ast.decls.length > 0) {
    sections.push(ast.decls.map(formatDecl).join("\n\n"));
  }

  const body = sections.join("\n\n");
  return `${headerComments}${body}\n`;
}
