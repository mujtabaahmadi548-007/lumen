/**
 * Lumen Recursive-Descent + Pratt Precedence Parser (`src/frontend/parser.js`)
 * Parses token streams into the formal Lumen AST with multi-error recovery.
 */

import {
  ErrorCodes,
  createSpan,
  mergeSpans,
  createDiagnostic,
} from "../contracts/index.js";
import {
  TokenKind,
  ASSIGN_OP_TOKENS,
  createToken,
  isPrimitiveTypeToken,
  formatTokenKind,
} from "./token.js";
import { tokenize } from "./lexer.js";

const PRELUDE_ENUM_VARIANTS = new Set(["Some", "Ok", "Err"]);

const BINARY_PRECEDENCE = new Map([
  [TokenKind.DOT_DOT, { prec: 1, op: ".." }],
  [TokenKind.PIPE_PIPE, { prec: 2, op: "||" }],
  [TokenKind.AMP_AMP, { prec: 3, op: "&&" }],
  [TokenKind.EQ_EQ, { prec: 4, op: "==" }],
  [TokenKind.BANG_EQ, { prec: 4, op: "!=" }],
  [TokenKind.LT, { prec: 5, op: "<" }],
  [TokenKind.LT_EQ, { prec: 5, op: "<=" }],
  [TokenKind.GT, { prec: 5, op: ">" }],
  [TokenKind.GT_EQ, { prec: 5, op: ">=" }],
  [TokenKind.PIPE, { prec: 6, op: "|" }],
  [TokenKind.CARET, { prec: 7, op: "^" }],
  [TokenKind.AMP, { prec: 8, op: "&" }],
  [TokenKind.LT_LT, { prec: 9, op: "<<" }],
  [TokenKind.GT_GT, { prec: 9, op: ">>" }],
  [TokenKind.PLUS, { prec: 10, op: "+" }],
  [TokenKind.MINUS, { prec: 10, op: "-" }],
  [TokenKind.STAR, { prec: 11, op: "*" }],
  [TokenKind.SLASH, { prec: 11, op: "/" }],
  [TokenKind.PERCENT, { prec: 11, op: "%" }],
]);

const CAST_PRECEDENCE = 12;

function deriveModuleName(filename) {
  if (!filename || filename === "<input>") return "main";
  const base = filename.replace(/\\/g, "/").split("/").pop() || "main";
  return base.replace(/\.lm$/, "") || "main";
}

function blockHasTailValue(block) {
  if (!block || block.kind !== "BlockStmt") return false;
  if (block.tailExpr !== null && block.tailExpr !== undefined) {
    if (block.tailExpr.kind === "IfExpr") {
      return (
        blockHasTailValue(block.tailExpr.thenBlock) ||
        blockHasTailValue(block.tailExpr.elseBlock)
      );
    }
    return true;
  }
  return false;
}

function ifStmtToIfExpr(ifStmt) {
  let elseBlock;
  if (!ifStmt.elseBranch) {
    elseBlock = {
      kind: "BlockStmt",
      stmts: [],
      tailExpr: null,
      span: ifStmt.span,
    };
  } else if (ifStmt.elseBranch.kind === "IfStmt") {
    const nestedIfExpr = ifStmtToIfExpr(ifStmt.elseBranch);
    elseBlock = {
      kind: "BlockStmt",
      stmts: [],
      tailExpr: nestedIfExpr,
      span: nestedIfExpr.span,
    };
  } else {
    elseBlock = ifStmt.elseBranch;
  }

  return {
    kind: "IfExpr",
    cond: ifStmt.cond,
    thenBlock: ifStmt.thenBranch,
    elseBlock,
    span: ifStmt.span,
  };
}

function ifStmtHasCompleteElseAndTailValue(ifStmt) {
  if (!ifStmt || !ifStmt.elseBranch) return false;
  const thenHasVal = blockHasTailValue(ifStmt.thenBranch);
  let elseHasVal = false;
  if (ifStmt.elseBranch.kind === "IfStmt") {
    if (!ifStmtHasCompleteElseAndTailValue(ifStmt.elseBranch)) return false;
    elseHasVal = true;
  } else if (ifStmt.elseBranch.kind === "BlockStmt") {
    elseHasVal = blockHasTailValue(ifStmt.elseBranch);
  }
  return thenHasVal || elseHasVal;
}

class Parser {
  constructor(tokens, filename = "<input>", sourceText = "", initialDiagnostics = []) {
    this.rawTokens = tokens;
    this.filename = filename;
    this.sourceText = sourceText;
    this.lines = sourceText ? sourceText.split(/\r?\n/) : [];
    this.diagnostics = [...initialDiagnostics];
    this.pos = 0;
    this.allowStructLiteral = true;
  }

  getLineText(lineNum) {
    return this.lines[lineNum - 1] ?? "";
  }

  addDiag(code, message, span, suggestion = null) {
    const safeSpan = span || this.peek().span || createSpan(this.filename);
    this.diagnostics.push(
      createDiagnostic({
        code,
        severity: "error",
        message,
        span: safeSpan,
        sourceLine: this.getLineText(safeSpan.startLine),
        suggestion,
      })
    );
  }

  // Skip DOC_COMMENT tokens transparently except when explicitly collected at top-level
  skipDocComments() {
    while (
      this.pos < this.rawTokens.length &&
      this.rawTokens[this.pos].kind === TokenKind.DOC_COMMENT
    ) {
      this.pos++;
    }
  }

  peek(offset = 0) {
    let idx = this.pos;
    let remaining = offset;
    while (idx < this.rawTokens.length) {
      if (this.rawTokens[idx].kind === TokenKind.DOC_COMMENT) {
        idx++;
        continue;
      }
      if (remaining === 0) {
        return this.rawTokens[idx];
      }
      remaining--;
      idx++;
    }
    return (
      this.rawTokens[this.rawTokens.length - 1] ||
      createToken(TokenKind.EOF, "", null, createSpan(this.filename))
    );
  }

  previous() {
    let idx = this.pos - 1;
    while (idx >= 0 && this.rawTokens[idx].kind === TokenKind.DOC_COMMENT) {
      idx--;
    }
    return (
      this.rawTokens[Math.max(0, idx)] ||
      createToken(TokenKind.EOF, "", null, createSpan(this.filename))
    );
  }

  isAtEnd() {
    return this.peek().kind === TokenKind.EOF;
  }

  check(kind) {
    return this.peek().kind === kind;
  }

  advance() {
    this.skipDocComments();
    if (this.pos < this.rawTokens.length - 1) {
      return this.rawTokens[this.pos++];
    }
    return this.rawTokens[this.rawTokens.length - 1];
  }

  match(...kinds) {
    for (const k of kinds) {
      if (this.check(k)) {
        return this.advance();
      }
    }
    return null;
  }

  expect(kind, customMessage = null, suggestion = null) {
    if (this.check(kind)) {
      return this.advance();
    }
    const tok = this.peek();
    const expectedStr = formatTokenKind(kind);
    const foundStr =
      tok.kind === TokenKind.EOF ? "end of file" : `\`${tok.lexeme}\``;
    const msg =
      customMessage || `expected \`${expectedStr}\`, found ${foundStr}`;
    const sug =
      suggestion ||
      (kind === TokenKind.SEMI
        ? "Add `;` to terminate the statement"
        : kind === TokenKind.RBRACE
        ? "Add `}` to close the block"
        : kind === TokenKind.RPAREN
        ? "Add `)` to close the parenthesized list"
        : `Insert \`${expectedStr}\` here`);
    this.addDiag(ErrorCodes.PARSE_EXPECTED_TOKEN, msg, tok.span, sug);
    return createToken(kind, expectedStr, expectedStr, tok.span);
  }

  expectIdent(contextMsg = "identifier") {
    const tok = this.peek();
    if (tok.kind === TokenKind.IDENT) {
      return this.advance();
    }
    const foundStr =
      tok.kind === TokenKind.EOF ? "end of file" : `\`${tok.lexeme}\``;
    this.addDiag(
      ErrorCodes.PARSE_EXPECTED_TOKEN,
      `expected ${contextMsg}, found ${foundStr}`,
      tok.span,
      `Provide a valid ${contextMsg} name`
    );
    return createToken(TokenKind.IDENT, "_error", "_error", tok.span);
  }

  // Handles closing `>` in generic parameter/argument lists, splitting `>>` (`GT_GT`) when needed
  expectClosingGT() {
    this.skipDocComments();
    const tok = this.peek();
    if (tok.kind === TokenKind.GT) {
      return this.advance();
    }
    if (tok.kind === TokenKind.GT_GT) {
      // Split `>>` into two `>` tokens in place
      const firstSpan = createSpan(
        tok.span.file,
        tok.span.startLine,
        tok.span.startCol,
        tok.span.startLine,
        tok.span.startCol + 1,
        tok.span.startOffset,
        tok.span.startOffset + 1
      );
      const secondSpan = createSpan(
        tok.span.file,
        tok.span.endLine,
        tok.span.startCol + 1,
        tok.span.endLine,
        tok.span.endCol,
        tok.span.startOffset + 1,
        tok.span.endOffset
      );
      this.rawTokens[this.pos] = createToken(
        TokenKind.GT,
        ">",
        ">",
        secondSpan
      );
      return createToken(TokenKind.GT, ">", ">", firstSpan);
    }
    return this.expect(
      TokenKind.GT,
      "expected `>` to close generic type arguments",
      "Add `>` to close `<...>`"
    );
  }

  collectLeadingDocComments() {
    const docs = [];
    while (
      this.pos < this.rawTokens.length &&
      this.rawTokens[this.pos].kind === TokenKind.DOC_COMMENT
    ) {
      docs.push(this.rawTokens[this.pos].value);
      this.pos++;
    }
    return docs.length > 0 ? docs.join("\n") : undefined;
  }

  synchronizeTopLevel() {
    while (!this.isAtEnd()) {
      if (this.previous().kind === TokenKind.SEMI) return;
      switch (this.peek().kind) {
        case TokenKind.PUB:
        case TokenKind.FN:
        case TokenKind.STRUCT:
        case TokenKind.ENUM:
        case TokenKind.CONST:
        case TokenKind.IMPORT:
          return;
        default:
          this.advance();
      }
    }
  }

  synchronizeStmt() {
    while (!this.isAtEnd()) {
      const prev = this.previous().kind;
      if (prev === TokenKind.SEMI || prev === TokenKind.RBRACE) return;
      switch (this.peek().kind) {
        case TokenKind.RBRACE:
        case TokenKind.LET:
        case TokenKind.IF:
        case TokenKind.WHILE:
        case TokenKind.FOR:
        case TokenKind.RETURN:
        case TokenKind.BREAK:
        case TokenKind.CONTINUE:
        case TokenKind.MATCH:
        case TokenKind.FN:
        case TokenKind.STRUCT:
        case TokenKind.ENUM:
        case TokenKind.PUB:
          return;
        default:
          this.advance();
      }
    }
  }

  // ==========================================================================
  // Program & Top-Level Declarations
  // ==========================================================================

  parseProgram() {
    const startSpan = this.peek().span;
    const imports = [];
    const decls = [];

    while (!this.isAtEnd()) {
      const docComment = this.collectLeadingDocComments();
      if (this.isAtEnd()) break;

      if (this.check(TokenKind.SEMI)) {
        this.advance();
        continue;
      }

      if (this.check(TokenKind.IMPORT)) {
        const imp = this.parseImportDecl();
        if (imp) imports.push(imp);
        continue;
      }

      const decl = this.parseTopLevelDecl(docComment);
      if (decl) {
        decls.push(decl);
      }
    }

    const endSpan = this.previous().span || startSpan;
    return {
      kind: "Program",
      moduleName: deriveModuleName(this.filename),
      imports,
      decls,
      span: mergeSpans(startSpan, endSpan),
    };
  }

  parseImportDecl() {
    const startTok = this.expect(TokenKind.IMPORT);
    const path = [];
    let symbols = "*";

    // Support `import "path.lm";` or `import a::b::{c, d};` or `import a::b::*;` or `import a::b;`
    if (this.check(TokenKind.STRING_LIT)) {
      const strTok = this.advance();
      const parts = strTok.value
        .replace(/\.lm$/, "")
        .split(/[/:]+/)
        .filter(Boolean);
      path.push(...parts);
    } else {
      const firstIdent = this.expectIdent("module name");
      path.push(firstIdent.lexeme);

      while (this.match(TokenKind.COLON_COLON)) {
        if (this.match(TokenKind.STAR)) {
          symbols = "*";
          break;
        }
        if (this.match(TokenKind.LBRACE)) {
          const symList = [];
          while (!this.check(TokenKind.RBRACE) && !this.isAtEnd()) {
            const symTok = this.expectIdent("imported symbol name");
            symList.push(symTok.lexeme);
            if (!this.match(TokenKind.COMMA)) break;
          }
          this.expect(
            TokenKind.RBRACE,
            "expected `}` after import symbol list",
            "Add `}` to close import group"
          );
          symbols = symList;
          break;
        }
        const seg = this.expectIdent("module path segment");
        path.push(seg.lexeme);
      }
    }

    const endTok = this.match(TokenKind.SEMI) || this.previous();
    return {
      kind: "ImportDecl",
      path,
      symbols,
      span: mergeSpans(startTok.span, endTok.span),
    };
  }

  parseTopLevelDecl(docComment) {
    const startTok = this.peek();
    const isPublic = Boolean(this.match(TokenKind.PUB));

    const tok = this.peek();
    switch (tok.kind) {
      case TokenKind.FN:
        return this.parseFnDecl(isPublic, startTok.span, docComment);
      case TokenKind.STRUCT:
        return this.parseStructDecl(isPublic, startTok.span, docComment);
      case TokenKind.ENUM:
        return this.parseEnumDecl(isPublic, startTok.span, docComment);
      case TokenKind.CONST:
        return this.parseConstDecl(isPublic, startTok.span, docComment);
      case TokenKind.RPAREN:
      case TokenKind.RBRACKET:
      case TokenKind.RBRACE: {
        this.addDiag(
          ErrorCodes.PARSE_UNEXPECTED_TOKEN,
          `unexpected token \`${tok.lexeme}\``,
          tok.span,
          `Remove \`${tok.lexeme}\` or check for matching opening delimiter`
        );
        this.advance();
        return {
          kind: "ErrorExpr",
          message: `unexpected token \`${tok.lexeme}\``,
          span: tok.span,
        };
      }

      default: {
        this.addDiag(
          ErrorCodes.PARSE_EXPECTED_DECL,
          `expected top-level declaration (\`fn\`, \`struct\`, \`enum\`, \`const\`, or \`import\`), found \`${tok.lexeme}\``,
          tok.span,
          "Top-level items must be `fn`, `struct`, `enum`, `const`, or `import` declarations"
        );
        this.advance();
        this.synchronizeTopLevel();
        return null;
      }
    }
  }

  parseTypeParams() {
    const typeParams = [];
    if (this.match(TokenKind.LT)) {
      while (!this.check(TokenKind.GT) && !this.isAtEnd()) {
        const paramTok = this.expectIdent("type parameter");
        typeParams.push(paramTok.lexeme);
        if (!this.match(TokenKind.COMMA)) break;
      }
      this.expectClosingGT();
    }
    return typeParams;
  }

  parseFnDecl(isPublic, startSpan, docComment) {
    this.expect(TokenKind.FN);
    const nameTok = this.expectIdent("function name");
    const typeParams = this.parseTypeParams();

    this.expect(
      TokenKind.LPAREN,
      "expected `(` after function name",
      "Add `(` to start parameter list"
    );
    const params = [];
    while (!this.check(TokenKind.RPAREN) && !this.isAtEnd()) {
      const paramStart = this.peek().span;
      const mutable = Boolean(this.match(TokenKind.MUT));
      const pNameTok = this.expectIdent("parameter name");
      this.expect(
        TokenKind.COLON,
        `expected \`:\` and type annotation for parameter \`${pNameTok.lexeme}\``,
        `Add \`: <Type>\` after \`${pNameTok.lexeme}\``
      );
      const typeAnn = this.parseType();
      params.push({
        name: pNameTok.lexeme,
        mutable,
        typeAnn,
        span: mergeSpans(paramStart, typeAnn.span),
      });
      if (!this.match(TokenKind.COMMA)) break;
    }
    this.expect(
      TokenKind.RPAREN,
      "expected `)` after function parameters",
      "Add `)` to close parameter list"
    );

    let returnType = null;
    if (this.match(TokenKind.ARROW)) {
      returnType = this.parseType();
    }

    const body = this.parseBlockStmt();
    const node = {
      kind: "FnDecl",
      name: nameTok.lexeme,
      typeParams,
      params,
      returnType,
      body,
      isPublic,
      span: mergeSpans(startSpan, body.span),
    };
    if (docComment !== undefined) {
      node.docComment = docComment;
    }
    return node;
  }

  parseStructDecl(isPublic, startSpan, docComment) {
    this.expect(TokenKind.STRUCT);
    const nameTok = this.expectIdent("struct name");
    const typeParams = this.parseTypeParams();

    this.expect(
      TokenKind.LBRACE,
      `expected \`{\` to start body of struct \`${nameTok.lexeme}\``,
      "Add `{` before struct fields"
    );
    const fields = [];
    while (!this.check(TokenKind.RBRACE) && !this.isAtEnd()) {
      const fStart = this.peek().span;
      this.match(TokenKind.PUB); // optional `pub` on field
      const fNameTok = this.expectIdent("field name");
      this.expect(
        TokenKind.COLON,
        `expected \`:\` after struct field \`${fNameTok.lexeme}\``,
        `Add \`: <Type>\` after field \`${fNameTok.lexeme}\``
      );
      const typeAnn = this.parseType();
      fields.push({
        name: fNameTok.lexeme,
        typeAnn,
        span: mergeSpans(fStart, typeAnn.span),
      });
      if (!this.match(TokenKind.COMMA) && !this.match(TokenKind.SEMI)) {
        break;
      }
    }
    const endTok = this.expect(
      TokenKind.RBRACE,
      `expected \`}\` to close struct \`${nameTok.lexeme}\``,
      "Add `}` after struct fields"
    );

    const node = {
      kind: "StructDecl",
      name: nameTok.lexeme,
      typeParams,
      fields,
      isPublic,
      span: mergeSpans(startSpan, endTok.span),
    };
    if (docComment !== undefined) {
      node.docComment = docComment;
    }
    return node;
  }

  parseEnumDecl(isPublic, startSpan, docComment) {
    this.expect(TokenKind.ENUM);
    const nameTok = this.expectIdent("enum name");
    const typeParams = this.parseTypeParams();

    this.expect(
      TokenKind.LBRACE,
      `expected \`{\` to start body of enum \`${nameTok.lexeme}\``,
      "Add `{` before enum variants"
    );
    const variants = [];
    while (!this.check(TokenKind.RBRACE) && !this.isAtEnd()) {
      const vStart = this.peek().span;
      const vNameTok = this.expectIdent("enum variant name");
      const payload = [];
      let vEnd = vNameTok.span;

      if (this.match(TokenKind.LPAREN)) {
        while (!this.check(TokenKind.RPAREN) && !this.isAtEnd()) {
          payload.push(this.parseType());
          if (!this.match(TokenKind.COMMA)) break;
        }
        const closeParen = this.expect(
          TokenKind.RPAREN,
          `expected \`)\` after payload types of variant \`${vNameTok.lexeme}\``,
          "Add `)` to close variant payload"
        );
        vEnd = closeParen.span;
      }

      variants.push({
        name: vNameTok.lexeme,
        payload,
        span: mergeSpans(vStart, vEnd),
      });

      if (!this.match(TokenKind.COMMA) && !this.match(TokenKind.SEMI)) {
        break;
      }
    }
    const endTok = this.expect(
      TokenKind.RBRACE,
      `expected \`}\` to close enum \`${nameTok.lexeme}\``,
      "Add `}` after enum variants"
    );

    const node = {
      kind: "EnumDecl",
      name: nameTok.lexeme,
      typeParams,
      variants,
      isPublic,
      span: mergeSpans(startSpan, endTok.span),
    };
    if (docComment !== undefined) {
      node.docComment = docComment;
    }
    return node;
  }

  parseConstDecl(isPublic, startSpan, docComment) {
    this.expect(TokenKind.CONST);
    const nameTok = this.expectIdent("constant name");
    let typeAnn = null;
    if (this.match(TokenKind.COLON)) {
      typeAnn = this.parseType();
    }
    this.expect(
      TokenKind.EQ,
      `expected \`=\` in constant declaration \`${nameTok.lexeme}\``,
      "Initialize the constant with `= <expr>;`"
    );
    const init = this.parseExpr();
    const endTok = this.expect(
      TokenKind.SEMI,
      "expected `;` after constant declaration",
      "Add `;` at the end of the `const` declaration"
    );
    const node = {
      kind: "ConstDecl",
      name: nameTok.lexeme,
      typeAnn,
      init,
      isPublic,
      span: mergeSpans(startSpan, endTok.span),
    };
    if (docComment !== undefined) {
      node.docComment = docComment;
    }
    return node;
  }

  // ==========================================================================
  // Types (`TypeNode`)
  // ==========================================================================

  parseType() {
    const tok = this.peek();

    // Array type `[T]`
    if (this.match(TokenKind.LBRACKET)) {
      const elem = this.parseType();
      const closeTok = this.expect(
        TokenKind.RBRACKET,
        "expected `]` to close array type `[T]`",
        "Add `]` after the element type"
      );
      return {
        kind: "ArrayType",
        elem,
        span: mergeSpans(tok.span, closeTok.span),
      };
    }

    // Function type `fn(T1, T2) -> Ret`
    if (this.match(TokenKind.FN)) {
      this.expect(
        TokenKind.LPAREN,
        "expected `(` in function type `fn(...) -> Ret`",
        "Add `(` after `fn`"
      );
      const params = [];
      while (!this.check(TokenKind.RPAREN) && !this.isAtEnd()) {
        params.push(this.parseType());
        if (!this.match(TokenKind.COMMA)) break;
      }
      const closeParen = this.expect(
        TokenKind.RPAREN,
        "expected `)` after function type parameter list",
        "Add `)` after parameter types"
      );
      let ret;
      if (this.match(TokenKind.ARROW)) {
        ret = this.parseType();
      } else {
        ret = {
          kind: "NamedType",
          name: "void",
          typeArgs: [],
          span: closeParen.span,
        };
      }
      return {
        kind: "FnType",
        params,
        ret,
        span: mergeSpans(tok.span, ret.span),
      };
    }

    // Unit type `()` alias for `void`
    if (this.match(TokenKind.LPAREN)) {
      const closeTok = this.expect(
        TokenKind.RPAREN,
        "expected `)` for unit type `()`",
        "Use `void` or `()`"
      );
      return {
        kind: "NamedType",
        name: "void",
        typeArgs: [],
        span: mergeSpans(tok.span, closeTok.span),
      };
    }

    // Primitive or Named type (`i32`, `string`, `Option<i32>`, `Result<T, E>`)
    if (isPrimitiveTypeToken(tok.kind) || tok.kind === TokenKind.IDENT) {
      const nameTok = this.advance();
      const typeArgs = [];
      let endSpan = nameTok.span;

      if (this.match(TokenKind.LT)) {
        while (
          !this.check(TokenKind.GT) &&
          !this.check(TokenKind.GT_GT) &&
          !this.isAtEnd()
        ) {
          typeArgs.push(this.parseType());
          if (!this.match(TokenKind.COMMA)) break;
        }
        const closeGt = this.expectClosingGT();
        endSpan = closeGt.span;
      }

      return {
        kind: "NamedType",
        name: nameTok.lexeme,
        typeArgs,
        span: mergeSpans(nameTok.span, endSpan),
      };
    }

    this.addDiag(
      ErrorCodes.PARSE_EXPECTED_TYPE,
      `expected type annotation, found \`${tok.lexeme}\``,
      tok.span,
      "Use a valid type such as `i32`, `f64`, `bool`, `string`, `[T]`, or `Option<T>`"
    );
    this.advance();
    return {
      kind: "NamedType",
      name: "void",
      typeArgs: [],
      span: tok.span,
    };
  }

  parseTypeArgsList() {
    const typeArgs = [];
    this.expect(TokenKind.LT);
    while (
      !this.check(TokenKind.GT) &&
      !this.check(TokenKind.GT_GT) &&
      !this.isAtEnd()
    ) {
      typeArgs.push(this.parseType());
      if (!this.match(TokenKind.COMMA)) break;
    }
    this.expectClosingGT();
    return typeArgs;
  }

  // ==========================================================================
  // Statements (`Stmt`)
  // ==========================================================================

  parseBlockStmt() {
    const openTok = this.expect(
      TokenKind.LBRACE,
      "expected `{` to start block",
      "Add `{` to start block"
    );
    const stmts = [];
    let tailExpr = null;

    while (!this.check(TokenKind.RBRACE) && !this.isAtEnd()) {
      if (this.match(TokenKind.SEMI)) {
        continue;
      }

      const tok = this.peek();

      if (tok.kind === TokenKind.LET) {
        stmts.push(this.parseLetStmt());
        continue;
      }
      if (tok.kind === TokenKind.WHILE) {
        stmts.push(this.parseWhileStmt());
        continue;
      }
      if (tok.kind === TokenKind.FOR) {
        stmts.push(this.parseForStmt());
        continue;
      }
      if (tok.kind === TokenKind.RETURN) {
        stmts.push(this.parseReturnStmt());
        continue;
      }
      if (tok.kind === TokenKind.BREAK) {
        stmts.push(this.parseBreakStmt());
        continue;
      }
      if (tok.kind === TokenKind.CONTINUE) {
        stmts.push(this.parseContinueStmt());
        continue;
      }

      if (tok.kind === TokenKind.IF) {
        const ifStmt = this.parseIfStmt();
        const hasSemi = Boolean(this.match(TokenKind.SEMI));
        if (
          !hasSemi &&
          this.check(TokenKind.RBRACE) &&
          ifStmtHasCompleteElseAndTailValue(ifStmt)
        ) {
          tailExpr = ifStmtToIfExpr(ifStmt);
          break;
        }
        stmts.push(ifStmt);
        continue;
      }

      if (tok.kind === TokenKind.MATCH) {
        const matchExpr = this.parseMatchExpr();
        const hasSemi = Boolean(this.match(TokenKind.SEMI));
        if (!hasSemi && this.check(TokenKind.RBRACE)) {
          const producesValue = matchExpr.arms.some(
            (arm) =>
              arm.body.kind !== "BlockStmt" || blockHasTailValue(arm.body)
          );
          if (producesValue) {
            tailExpr = matchExpr;
            break;
          }
        }
        stmts.push({
          kind: "ExprStmt",
          expr: matchExpr,
          span: matchExpr.span,
        });
        continue;
      }

      // Parse an expression (which may be followed by assignment `=`, `;`, or `}` for tailExpr)
      const expr = this.parseExpr();

      if (expr.kind === "ErrorExpr") {
        stmts.push({
          kind: "ErrorStmt",
          message: expr.message,
          span: expr.span,
        });
        this.synchronizeStmt();
        continue;
      }

      // Check for assignment (`=`, `+=`, `-=`, `*=`, `/=`)
      if (ASSIGN_OP_TOKENS.has(this.peek().kind)) {
        const opTok = this.advance();
        const op = ASSIGN_OP_TOKENS.get(opTok.kind);
        if (
          expr.kind !== "IdentExpr" &&
          expr.kind !== "FieldExpr" &&
          expr.kind !== "IndexExpr"
        ) {
          this.addDiag(
            ErrorCodes.PARSE_INVALID_ASSIGN_TARGET,
            "invalid left-hand side in assignment",
            expr.span,
            "Assignment target must be a variable, struct field (`a.b`), or array element (`a[i]`)"
          );
        }
        const value = this.parseExpr();
        const semiTok = this.expect(
          TokenKind.SEMI,
          "expected `;` after assignment statement",
          "Add `;` at the end of the assignment"
        );
        stmts.push({
          kind: "AssignStmt",
          target: expr,
          op,
          value,
          span: mergeSpans(expr.span, semiTok.span),
        });
        continue;
      }

      // Semicolon -> ExprStmt
      if (this.match(TokenKind.SEMI)) {
        stmts.push({
          kind: "ExprStmt",
          expr,
          span: mergeSpans(expr.span, this.previous().span),
        });
        continue;
      }

      // End of block without semicolon -> tailExpr!
      if (this.check(TokenKind.RBRACE)) {
        tailExpr = expr;
        break;
      }

      // Block-ended expressions (`IfExpr`, `MatchExpr`, `BlockExpr`) don't require `;` when followed by more statements
      if (
        expr.kind === "IfExpr" ||
        expr.kind === "MatchExpr" ||
        expr.kind === "BlockExpr"
      ) {
        stmts.push({
          kind: "ExprStmt",
          expr,
          span: expr.span,
        });
        continue;
      }

      // Missing semicolon on regular expression statement
      const missingSemiTok = this.expect(
        TokenKind.SEMI,
        "expected `;` after expression statement",
        "Add `;` at the end of the statement"
      );
      stmts.push({
        kind: "ExprStmt",
        expr,
        span: mergeSpans(expr.span, missingSemiTok.span),
      });
    }

    const closeTok = this.expect(
      TokenKind.RBRACE,
      "expected `}` to close block",
      "Add `}` to close the block"
    );

    return {
      kind: "BlockStmt",
      stmts,
      tailExpr,
      span: mergeSpans(openTok.span, closeTok.span),
    };
  }

  parseLetStmt() {
    const startTok = this.expect(TokenKind.LET);
    const mutable = Boolean(this.match(TokenKind.MUT));
    const nameTok = this.expectIdent("variable name");

    let typeAnn = null;
    if (this.match(TokenKind.COLON)) {
      typeAnn = this.parseType();
    }

    this.expect(
      TokenKind.EQ,
      `expected \`=\` to initialize variable \`${nameTok.lexeme}\``,
      `Add \`= <expr>\` to initialize \`${nameTok.lexeme}\``
    );
    const init = this.parseExpr();
    const semiTok = this.expect(
      TokenKind.SEMI,
      "expected `;` after `let` binding",
      "Add `;` at the end of the `let` statement"
    );

    return {
      kind: "LetStmt",
      name: nameTok.lexeme,
      mutable,
      typeAnn,
      init,
      span: mergeSpans(startTok.span, semiTok.span),
    };
  }

  parseIfStmt() {
    const startTok = this.expect(TokenKind.IF);
    const cond = this.parseExprNoStructLit();
    const thenBranch = this.parseBlockStmt();
    let elseBranch = null;
    let endSpan = thenBranch.span;

    if (this.match(TokenKind.ELSE)) {
      if (this.check(TokenKind.IF)) {
        elseBranch = this.parseIfStmt();
      } else {
        elseBranch = this.parseBlockStmt();
      }
      endSpan = elseBranch.span;
    }

    return {
      kind: "IfStmt",
      cond,
      thenBranch,
      elseBranch,
      span: mergeSpans(startTok.span, endSpan),
    };
  }

  parseWhileStmt() {
    const startTok = this.expect(TokenKind.WHILE);
    const cond = this.parseExprNoStructLit();
    const body = this.parseBlockStmt();
    return {
      kind: "WhileStmt",
      cond,
      body,
      span: mergeSpans(startTok.span, body.span),
    };
  }

  parseForStmt() {
    const startTok = this.expect(TokenKind.FOR);
    this.match(TokenKind.MUT);
    const iterTok = this.expectIdent("loop variable");
    this.expect(
      TokenKind.IN,
      `expected \`in\` after loop variable \`${iterTok.lexeme}\``,
      `Use \`for ${iterTok.lexeme} in <iterable> { ... }\``
    );
    const iterable = this.parseExprNoStructLit();
    const body = this.parseBlockStmt();
    return {
      kind: "ForStmt",
      iteratorVar: iterTok.lexeme,
      iterable,
      body,
      span: mergeSpans(startTok.span, body.span),
    };
  }

  parseReturnStmt() {
    const startTok = this.expect(TokenKind.RETURN);
    let value = null;
    if (!this.check(TokenKind.SEMI) && !this.check(TokenKind.RBRACE) && !this.isAtEnd()) {
      value = this.parseExpr();
    }
    const endTok = this.check(TokenKind.RBRACE)
      ? this.match(TokenKind.SEMI) || this.previous()
      : this.expect(
          TokenKind.SEMI,
          "expected `;` after `return` statement",
          "Add `;` after the return statement"
        );
    return {
      kind: "ReturnStmt",
      value,
      span: mergeSpans(startTok.span, endTok.span),
    };
  }

  parseBreakStmt() {
    const startTok = this.expect(TokenKind.BREAK);
    const endTok = this.check(TokenKind.RBRACE)
      ? this.match(TokenKind.SEMI) || startTok
      : this.expect(
          TokenKind.SEMI,
          "expected `;` after `break`",
          "Add `;` after `break`"
        );
    return {
      kind: "BreakStmt",
      span: mergeSpans(startTok.span, endTok.span),
    };
  }

  parseContinueStmt() {
    const startTok = this.expect(TokenKind.CONTINUE);
    const endTok = this.check(TokenKind.RBRACE)
      ? this.match(TokenKind.SEMI) || startTok
      : this.expect(
          TokenKind.SEMI,
          "expected `;` after `continue`",
          "Add `;` after `continue`"
        );
    return {
      kind: "ContinueStmt",
      span: mergeSpans(startTok.span, endTok.span),
    };
  }

  // ==========================================================================
  // Expressions (`Expr`) — Pratt Precedence Parser
  // ==========================================================================

  parseExprNoStructLit() {
    const prev = this.allowStructLiteral;
    this.allowStructLiteral = false;
    try {
      return this.parseExpr(0);
    } finally {
      this.allowStructLiteral = prev;
    }
  }

  parseExpr(minPrec = 0) {
    let left = this.parsePrefixExpr();

    while (!this.isAtEnd()) {
      // 1. Postfix operators (`(...)`, `[...]`, `.field`) — highest precedence
      if (
        this.check(TokenKind.LPAREN) ||
        this.check(TokenKind.LBRACKET) ||
        this.check(TokenKind.DOT)
      ) {
        left = this.parsePostfixExpr(left);
        continue;
      }

      // 2. Type cast `expr as Type`
      if (this.check(TokenKind.AS) && CAST_PRECEDENCE > minPrec) {
        this.advance(); // consume `as`
        const targetType = this.parseType();
        left = {
          kind: "CastExpr",
          expr: left,
          targetType,
          span: mergeSpans(left.span, targetType.span),
        };
        continue;
      }

      // 3. Binary infix operators & RangeExpr (`a..b`)
      const binInfo = BINARY_PRECEDENCE.get(this.peek().kind);
      if (binInfo && binInfo.prec > minPrec) {
        this.advance(); // consume operator
        const right = this.parseExpr(binInfo.prec);
        if (binInfo.op === "..") {
          left = {
            kind: "RangeExpr",
            start: left,
            end: right,
            span: mergeSpans(left.span, right.span),
          };
        } else {
          left = {
            kind: "BinaryExpr",
            op: binInfo.op,
            left,
            right,
            span: mergeSpans(left.span, right.span),
          };
        }
        continue;
      }

      break;
    }

    return left;
  }

  parsePrefixExpr() {
    const tok = this.peek();

    // Literals
    switch (tok.kind) {
      case TokenKind.INT_LIT: {
        this.advance();
        return {
          kind: "LiteralExpr",
          literalType: "i32",
          value: tok.value,
          span: tok.span,
        };
      }
      case TokenKind.INT64_LIT: {
        this.advance();
        return {
          kind: "LiteralExpr",
          literalType: "i64",
          value: tok.value,
          span: tok.span,
        };
      }
      case TokenKind.FLOAT_LIT: {
        this.advance();
        return {
          kind: "LiteralExpr",
          literalType: "f64",
          value: tok.value,
          span: tok.span,
        };
      }
      case TokenKind.STRING_LIT: {
        this.advance();
        return {
          kind: "LiteralExpr",
          literalType: "string",
          value: tok.value,
          span: tok.span,
        };
      }
      case TokenKind.TRUE:
      case TokenKind.FALSE: {
        this.advance();
        return {
          kind: "LiteralExpr",
          literalType: "bool",
          value: tok.kind === TokenKind.TRUE,
          span: tok.span,
        };
      }

      // Unary prefix operators (`-`, `!`, `~`)
      case TokenKind.MINUS:
      case TokenKind.BANG:
      case TokenKind.TILDE: {
        const opTok = this.advance();
        const operand = this.parseExpr(13);
        return {
          kind: "UnaryExpr",
          op: opTok.lexeme,
          operand,
          span: mergeSpans(opTok.span, operand.span),
        };
      }

      // Parenthesized expression `(expr)` or unit literal `()`
      case TokenKind.LPAREN: {
        const openTok = this.advance();
        if (this.match(TokenKind.RPAREN)) {
          return {
            kind: "LiteralExpr",
            literalType: "void",
            value: null,
            span: mergeSpans(openTok.span, this.previous().span),
          };
        }
        const prev = this.allowStructLiteral;
        this.allowStructLiteral = true;
        let inner;
        try {
          inner = this.parseExpr(0);
        } finally {
          this.allowStructLiteral = prev;
        }
        const closeTok = this.expect(
          TokenKind.RPAREN,
          "expected `)` after expression",
          "Add `)` to close the parenthesized expression"
        );
        inner.span = mergeSpans(openTok.span, closeTok.span);
        return inner;
      }

      // Array literal `[e1, e2, ...]` or repeat `[val; count]`
      case TokenKind.LBRACKET: {
        return this.parseArrayLitExpr();
      }

      // Block expression `{ ... }`
      case TokenKind.LBRACE: {
        const prev = this.allowStructLiteral;
        this.allowStructLiteral = true;
        try {
          const block = this.parseBlockStmt();
          return {
            kind: "BlockExpr",
            block,
            span: block.span,
          };
        } finally {
          this.allowStructLiteral = prev;
        }
      }

      // `if` expression
      case TokenKind.IF: {
        return this.parseIfExpr();
      }

      // `match` expression
      case TokenKind.MATCH: {
        return this.parseMatchExpr();
      }

      // Closure expression `|x, y| ...` or `|| ...`
      case TokenKind.PIPE:
      case TokenKind.PIPE_PIPE: {
        return this.parseClosureExpr();
      }

      // Identifier, Struct Literal, Enum Constructor, or Turbofish Call
      case TokenKind.IDENT: {
        return this.parseIdentOrCompoundExpr();
      }

      case TokenKind.RPAREN:
      case TokenKind.RBRACKET:
      case TokenKind.RBRACE: {
        this.addDiag(
          ErrorCodes.PARSE_UNEXPECTED_TOKEN,
          `unexpected token \`${tok.lexeme}\``,
          tok.span,
          `Remove \`${tok.lexeme}\` or check for matching opening delimiter`
        );
        this.advance();
        return {
          kind: "ErrorExpr",
          message: `unexpected token \`${tok.lexeme}\``,
          span: tok.span,
        };
      }

      default: {
        this.addDiag(
          ErrorCodes.PARSE_EXPECTED_EXPR,
          `expected expression, found \`${tok.lexeme || formatTokenKind(tok.kind)}\``,
          tok.span,
          "Provide a valid expression (literal, variable, function call, `if`, or `match`)"
        );
        this.advance();
        return {
          kind: "ErrorExpr",
          message: `unexpected token \`${tok.lexeme}\``,
          span: tok.span,
        };
      }
    }
  }

  // Lookahead to check whether `{` after `Ident` is a struct literal `{ field: val }` / `{ x, y }` / `{}`
  isLikelyStructLiteralBody() {
    if (!this.check(TokenKind.LBRACE)) return false;
    const afterBrace = this.peek(1);
    // `StructName {}`
    if (afterBrace.kind === TokenKind.RBRACE) return true;
    // `StructName { field: ... }` or `StructName { x, ... }` or `StructName { x }`
    if (afterBrace.kind === TokenKind.IDENT) {
      const afterIdent = this.peek(2);
      if (
        afterIdent.kind === TokenKind.COLON ||
        afterIdent.kind === TokenKind.COMMA ||
        afterIdent.kind === TokenKind.RBRACE
      ) {
        return true;
      }
    }
    return false;
  }

  parseIdentOrCompoundExpr() {
    const identTok = this.advance();
    const name = identTok.lexeme;
    let typeArgs = [];
    let hasTurbofish = false;
    let endSpan = identTok.span;

    // Check for `::<T, U>` turbofish
    if (this.check(TokenKind.COLON_COLON) && this.peek(1).kind === TokenKind.LT) {
      this.advance(); // consume `::`
      typeArgs = this.parseTypeArgsList();
      hasTurbofish = true;
      endSpan = this.previous().span;
    }

    // 1. Qualified Enum Constructor: `Enum::Variant` or `Enum::<T>::Variant(args...)`
    if (this.match(TokenKind.COLON_COLON)) {
      const variantTok = this.expectIdent("enum variant name");
      endSpan = variantTok.span;

      // Also support `Enum::Variant::<T>(args...)`
      if (this.check(TokenKind.COLON_COLON) && this.peek(1).kind === TokenKind.LT) {
        this.advance(); // `::`
        const moreArgs = this.parseTypeArgsList();
        if (typeArgs.length === 0) typeArgs = moreArgs;
        endSpan = this.previous().span;
      } else if (this.check(TokenKind.LT) && this.peek(1).kind !== TokenKind.EOF) {
        // Check if `Enum::Variant<T>(...)` was written without second `::`
      }

      const args = [];
      if (this.match(TokenKind.LPAREN)) {
        const prev = this.allowStructLiteral;
        this.allowStructLiteral = true;
        try {
          while (!this.check(TokenKind.RPAREN) && !this.isAtEnd()) {
            args.push(this.parseExpr(0));
            if (!this.match(TokenKind.COMMA)) break;
          }
        } finally {
          this.allowStructLiteral = prev;
        }
        const closeParen = this.expect(
          TokenKind.RPAREN,
          `expected \`)\` after arguments to \`${name}::${variantTok.lexeme}\``,
          "Add `)` to close enum constructor arguments"
        );
        endSpan = closeParen.span;
      }

      return {
        kind: "EnumInitExpr",
        enumName: name,
        variantName: variantTok.lexeme,
        typeArgs,
        args,
        span: mergeSpans(identTok.span, endSpan),
      };
    }

    // 2. Struct Literal: `Point { x: 1, y: 2 }`, `Point { x, y }`, or `Pair::<i32, i32> { ... }`
    if (
      this.check(TokenKind.LBRACE) &&
      (hasTurbofish || (this.allowStructLiteral && this.isLikelyStructLiteralBody()))
    ) {
      this.advance(); // consume `{`
      const fields = [];
      const prev = this.allowStructLiteral;
      this.allowStructLiteral = true;
      try {
        while (!this.check(TokenKind.RBRACE) && !this.isAtEnd()) {
          const fieldTok = this.expectIdent("struct field name");
          let value;
          if (this.match(TokenKind.COLON)) {
            value = this.parseExpr(0);
          } else {
            // Field shorthand: `Point { x, y }` -> `x: x`
            value = {
              kind: "IdentExpr",
              name: fieldTok.lexeme,
              typeArgs: [],
              span: fieldTok.span,
            };
          }
          fields.push({
            name: fieldTok.lexeme,
            value,
          });
          if (!this.match(TokenKind.COMMA)) break;
        }
      } finally {
        this.allowStructLiteral = prev;
      }
      const closeBrace = this.expect(
        TokenKind.RBRACE,
        `expected \`}\` to close struct literal \`${name}\``,
        "Add `}` after struct literal fields"
      );
      return {
        kind: "StructLitExpr",
        structName: name,
        typeArgs,
        fields,
        span: mergeSpans(identTok.span, closeBrace.span),
      };
    }

    // 3. Unqualified Prelude Enum Unit Variant: `None` or `None::<i32>`
    if (name === "None" && !this.check(TokenKind.LPAREN)) {
      return {
        kind: "EnumInitExpr",
        enumName: null,
        variantName: "None",
        typeArgs,
        args: [],
        span: mergeSpans(identTok.span, endSpan),
      };
    }

    // 4. Unqualified Prelude Enum Payload Variant: `Some(x)`, `Ok(x)`, `Err(e)`
    if (PRELUDE_ENUM_VARIANTS.has(name) && this.check(TokenKind.LPAREN)) {
      this.advance(); // consume `(`
      const args = [];
      const prev = this.allowStructLiteral;
      this.allowStructLiteral = true;
      try {
        while (!this.check(TokenKind.RPAREN) && !this.isAtEnd()) {
          args.push(this.parseExpr(0));
          if (!this.match(TokenKind.COMMA)) break;
        }
      } finally {
        this.allowStructLiteral = prev;
      }
      const closeParen = this.expect(
        TokenKind.RPAREN,
        `expected \`)\` after arguments to \`${name}(...)\``,
        "Add `)` to close variant arguments"
      );
      return {
        kind: "EnumInitExpr",
        enumName: null,
        variantName: name,
        typeArgs,
        args,
        span: mergeSpans(identTok.span, closeParen.span),
      };
    }

    // 5. Regular identifier (with optional turbofish `foo::<T>`)
    return {
      kind: "IdentExpr",
      name,
      typeArgs,
      span: mergeSpans(identTok.span, endSpan),
    };
  }

  parsePostfixExpr(left) {
    // Function call `callee(arg1, arg2)`
    if (this.match(TokenKind.LPAREN)) {
      const args = [];
      const prev = this.allowStructLiteral;
      this.allowStructLiteral = true;
      try {
        while (!this.check(TokenKind.RPAREN) && !this.isAtEnd()) {
          args.push(this.parseExpr(0));
          if (!this.match(TokenKind.COMMA)) break;
        }
      } finally {
        this.allowStructLiteral = prev;
      }
      const closeParen = this.expect(
        TokenKind.RPAREN,
        "expected `)` after call arguments",
        "Add `)` to close argument list"
      );
      const typeArgs =
        left.kind === "IdentExpr" && Array.isArray(left.typeArgs)
          ? left.typeArgs
          : [];
      return {
        kind: "CallExpr",
        callee: left,
        typeArgs,
        args,
        span: mergeSpans(left.span, closeParen.span),
      };
    }

    // Array indexing `object[index]`
    if (this.match(TokenKind.LBRACKET)) {
      const prev = this.allowStructLiteral;
      this.allowStructLiteral = true;
      let index;
      try {
        index = this.parseExpr(0);
      } finally {
        this.allowStructLiteral = prev;
      }
      const closeBracket = this.expect(
        TokenKind.RBRACKET,
        "expected `]` after array index",
        "Add `]` to close index expression"
      );
      return {
        kind: "IndexExpr",
        object: left,
        index,
        span: mergeSpans(left.span, closeBracket.span),
      };
    }

    // Field access `object.field`
    if (this.match(TokenKind.DOT)) {
      const tok = this.peek();
      let fieldTok;
      if (tok.kind === TokenKind.IDENT || tok.kind === TokenKind.INT_LIT) {
        fieldTok = this.advance();
      } else {
        fieldTok = this.expectIdent("field name after `.`");
      }
      return {
        kind: "FieldExpr",
        object: left,
        field: fieldTok.lexeme,
        span: mergeSpans(left.span, fieldTok.span),
      };
    }

    return left;
  }

  parseArrayLitExpr() {
    const openTok = this.expect(TokenKind.LBRACKET);
    const elements = [];
    const prev = this.allowStructLiteral;
    this.allowStructLiteral = true;
    try {
      if (!this.check(TokenKind.RBRACKET) && !this.isAtEnd()) {
        const firstElem = this.parseExpr(0);
        // Support repeat syntax `[val; count]`
        if (this.match(TokenKind.SEMI)) {
          const countExpr = this.parseExpr(0);
          if (
            countExpr.kind === "LiteralExpr" &&
            countExpr.literalType === "i32" &&
            typeof countExpr.value === "number" &&
            countExpr.value >= 0 &&
            countExpr.value <= 10000
          ) {
            for (let i = 0; i < countExpr.value; i++) {
              elements.push(firstElem);
            }
          } else {
            elements.push(firstElem);
          }
        } else {
          elements.push(firstElem);
          while (this.match(TokenKind.COMMA)) {
            if (this.check(TokenKind.RBRACKET) || this.isAtEnd()) break;
            elements.push(this.parseExpr(0));
          }
        }
      }
    } finally {
      this.allowStructLiteral = prev;
    }
    const closeTok = this.expect(
      TokenKind.RBRACKET,
      "expected `]` to close array literal",
      "Add `]` at the end of the array literal"
    );
    return {
      kind: "ArrayLitExpr",
      elements,
      span: mergeSpans(openTok.span, closeTok.span),
    };
  }

  parseIfExpr() {
    const startTok = this.expect(TokenKind.IF);
    const cond = this.parseExprNoStructLit();
    const thenBlock = this.parseBlockStmt();
    let elseBlock;
    let endSpan = thenBlock.span;

    if (this.match(TokenKind.ELSE)) {
      if (this.check(TokenKind.IF)) {
        const nestedIf = this.parseIfExpr();
        elseBlock = {
          kind: "BlockStmt",
          stmts: [],
          tailExpr: nestedIf,
          span: nestedIf.span,
        };
        endSpan = nestedIf.span;
      } else {
        elseBlock = this.parseBlockStmt();
        endSpan = elseBlock.span;
      }
    } else {
      elseBlock = {
        kind: "BlockStmt",
        stmts: [],
        tailExpr: null,
        span: thenBlock.span,
      };
    }

    return {
      kind: "IfExpr",
      cond,
      thenBlock,
      elseBlock,
      span: mergeSpans(startTok.span, endSpan),
    };
  }

  parseMatchExpr() {
    const startTok = this.expect(TokenKind.MATCH);
    const scrutinee = this.parseExprNoStructLit();
    this.expect(
      TokenKind.LBRACE,
      "expected `{` after `match` scrutinee",
      "Add `{` to start match arms"
    );

    const arms = [];
    while (!this.check(TokenKind.RBRACE) && !this.isAtEnd()) {
      const armStart = this.peek().span;
      const pattern = this.parsePattern();

      let guard = null;
      if (this.match(TokenKind.IF)) {
        guard = this.parseExprNoStructLit();
      }

      this.expect(
        TokenKind.FAT_ARROW,
        "expected `=>` after match pattern",
        "Use `pattern => expression` in match arms"
      );

      let body;
      if (this.check(TokenKind.LBRACE)) {
        body = this.parseBlockStmt();
      } else {
        body = this.parseExpr(0);
      }

      arms.push({
        pattern,
        guard,
        body,
        span: mergeSpans(armStart, body.span),
      });

      // Optional comma or semicolon after match arm
      if (!this.match(TokenKind.COMMA) && !this.match(TokenKind.SEMI)) {
        if (body.kind !== "BlockStmt" && !this.check(TokenKind.RBRACE)) {
          this.expect(
            TokenKind.COMMA,
            "expected `,` between match arms",
            "Add `,` at the end of the match arm"
          );
        }
      }
    }

    const closeTok = this.expect(
      TokenKind.RBRACE,
      "expected `}` to close `match` expression",
      "Add `}` after match arms"
    );

    return {
      kind: "MatchExpr",
      scrutinee,
      arms,
      span: mergeSpans(startTok.span, closeTok.span),
    };
  }

  parseClosureExpr() {
    const startTok = this.peek();
    const params = [];

    if (this.match(TokenKind.PIPE_PIPE)) {
      // Zero-parameter closure `|| ...`
    } else {
      this.expect(TokenKind.PIPE);
      while (!this.check(TokenKind.PIPE) && !this.isAtEnd()) {
        const pStart = this.peek().span;
        this.match(TokenKind.MUT);
        const pNameTok = this.expectIdent("closure parameter name");
        let typeAnn = null;
        if (this.match(TokenKind.COLON)) {
          typeAnn = this.parseType();
        }
        params.push({
          name: pNameTok.lexeme,
          typeAnn,
          span: mergeSpans(pStart, (typeAnn || pNameTok).span),
        });
        if (!this.match(TokenKind.COMMA)) break;
      }
      this.expect(
        TokenKind.PIPE,
        "expected `|` to close closure parameter list",
        "Add `|` after closure parameters"
      );
    }

    let returnType = null;
    if (this.match(TokenKind.ARROW)) {
      returnType = this.parseType();
    }

    let body;
    if (this.check(TokenKind.LBRACE)) {
      body = this.parseBlockStmt();
    } else {
      body = this.parseExpr(0);
    }

    return {
      kind: "ClosureExpr",
      params,
      returnType,
      body,
      span: mergeSpans(startTok.span, body.span),
    };
  }

  // ==========================================================================
  // Patterns (`Pattern`)
  // ==========================================================================

  parsePattern() {
    const tok = this.peek();

    // Negative number literal pattern (`-1`, `-3.14`, `-10i64`)
    if (tok.kind === TokenKind.MINUS) {
      const minusTok = this.advance();
      const numTok = this.peek();
      if (
        numTok.kind === TokenKind.INT_LIT ||
        numTok.kind === TokenKind.INT64_LIT ||
        numTok.kind === TokenKind.FLOAT_LIT
      ) {
        this.advance();
        const span = mergeSpans(minusTok.span, numTok.span);
        const literalType =
          numTok.kind === TokenKind.INT64_LIT
            ? "i64"
            : numTok.kind === TokenKind.FLOAT_LIT
            ? "f64"
            : "i32";
        const negValue =
          numTok.kind === TokenKind.INT64_LIT ? -numTok.value : -numTok.value;
        return {
          kind: "LiteralPattern",
          literal: {
            kind: "LiteralExpr",
            literalType,
            value: negValue,
            span,
          },
          span,
        };
      }
      this.addDiag(
        ErrorCodes.PARSE_EXPECTED_PATTERN,
        `expected numeric literal after \`-\` in pattern, found \`${numTok.lexeme}\``,
        minusTok.span,
        "Only numeric literals can be negated in a pattern (e.g. `-1`)"
      );
      return {
        kind: "WildcardPattern",
        span: minusTok.span,
      };
    }

    // Positive literal patterns (`0`, `42i64`, `3.14`, `"abc"`, `true`, `false`)
    if (
      tok.kind === TokenKind.INT_LIT ||
      tok.kind === TokenKind.INT64_LIT ||
      tok.kind === TokenKind.FLOAT_LIT ||
      tok.kind === TokenKind.STRING_LIT ||
      tok.kind === TokenKind.TRUE ||
      tok.kind === TokenKind.FALSE
    ) {
      this.advance();
      const literalType =
        tok.kind === TokenKind.INT_LIT
          ? "i32"
          : tok.kind === TokenKind.INT64_LIT
          ? "i64"
          : tok.kind === TokenKind.FLOAT_LIT
          ? "f64"
          : tok.kind === TokenKind.STRING_LIT
          ? "string"
          : "bool";
      return {
        kind: "LiteralPattern",
        literal: {
          kind: "LiteralExpr",
          literalType,
          value: tok.value,
          span: tok.span,
        },
        span: tok.span,
      };
    }

    // Optional `mut` before variable binding in pattern
    if (tok.kind === TokenKind.MUT) {
      const mutTok = this.advance();
      const identTok = this.expectIdent("variable name in pattern");
      return {
        kind: "VarPattern",
        name: identTok.lexeme,
        span: mergeSpans(mutTok.span, identTok.span),
      };
    }

    // Identifier-based patterns: Wildcard (`_`), EnumPattern, StructPattern, or VarPattern
    if (tok.kind === TokenKind.IDENT) {
      const identTok = this.advance();
      const name = identTok.lexeme;

      // 1. Wildcard `_`
      if (name === "_") {
        return {
          kind: "WildcardPattern",
          span: identTok.span,
        };
      }

      // Optional turbofish `Option::<i32>::Some(x)`
      if (this.check(TokenKind.COLON_COLON) && this.peek(1).kind === TokenKind.LT) {
        this.advance(); // `::`
        this.parseTypeArgsList();
      }

      // 2. Qualified Enum Pattern: `Enum::Variant` or `Enum::Variant(p1, p2)`
      if (this.match(TokenKind.COLON_COLON)) {
        const variantTok = this.expectIdent("enum variant name in pattern");
        let endSpan = variantTok.span;
        const args = [];
        if (this.match(TokenKind.LPAREN)) {
          while (!this.check(TokenKind.RPAREN) && !this.isAtEnd()) {
            args.push(this.parsePattern());
            if (!this.match(TokenKind.COMMA)) break;
          }
          const closeParen = this.expect(
            TokenKind.RPAREN,
            `expected \`)\` to close pattern \`${name}::${variantTok.lexeme}(...)\``,
            "Add `)` after variant pattern arguments"
          );
          endSpan = closeParen.span;
        }
        return {
          kind: "EnumPattern",
          enumName: name,
          variantName: variantTok.lexeme,
          args,
          span: mergeSpans(identTok.span, endSpan),
        };
      }

      // 3. Struct Pattern: `Point { x, y: py }`
      if (this.match(TokenKind.LBRACE)) {
        const fields = [];
        while (!this.check(TokenKind.RBRACE) && !this.isAtEnd()) {
          if (this.match(TokenKind.DOT_DOT)) {
            this.match(TokenKind.COMMA);
            break;
          }
          const fieldTok = this.expectIdent("struct field name in pattern");
          let fieldPattern;
          if (this.match(TokenKind.COLON)) {
            fieldPattern = this.parsePattern();
          } else {
            fieldPattern = {
              kind: "VarPattern",
              name: fieldTok.lexeme,
              span: fieldTok.span,
            };
          }
          fields.push({
            name: fieldTok.lexeme,
            pattern: fieldPattern,
          });
          if (!this.match(TokenKind.COMMA)) break;
        }
        const closeBrace = this.expect(
          TokenKind.RBRACE,
          `expected \`}\` to close struct pattern \`${name}\``,
          "Add `}` after struct pattern fields"
        );
        return {
          kind: "StructPattern",
          structName: name,
          fields,
          span: mergeSpans(identTok.span, closeBrace.span),
        };
      }

      // 4. Unqualified Enum Pattern with args: `Some(x)`, `Ok(x)`, `Err(e)`, `Variant(a, b)`
      if (this.match(TokenKind.LPAREN)) {
        const args = [];
        while (!this.check(TokenKind.RPAREN) && !this.isAtEnd()) {
          args.push(this.parsePattern());
          if (!this.match(TokenKind.COMMA)) break;
        }
        const closeParen = this.expect(
          TokenKind.RPAREN,
          `expected \`)\` to close enum pattern \`${name}(...)\``,
          "Add `)` after pattern arguments"
        );
        return {
          kind: "EnumPattern",
          enumName: null,
          variantName: name,
          args,
          span: mergeSpans(identTok.span, closeParen.span),
        };
      }

      // 5. Unqualified `None` unit variant pattern
      if (name === "None") {
        return {
          kind: "EnumPattern",
          enumName: null,
          variantName: "None",
          args: [],
          span: identTok.span,
        };
      }

      // 6. Variable binding pattern
      return {
        kind: "VarPattern",
        name,
        span: identTok.span,
      };
    }

    this.addDiag(
      ErrorCodes.PARSE_EXPECTED_PATTERN,
      `expected pattern, found \`${tok.lexeme}\``,
      tok.span,
      "Use a valid pattern (`_`, literal, variable, `Variant(...)`, or `Struct { ... }`)"
    );
    this.advance();
    return {
      kind: "WildcardPattern",
      span: tok.span,
    };
  }
}

/**
 * Parse Lumen source code or a token array into a Program AST and diagnostics.
 * @param {string | Array<object>} tokensOrSource
 * @param {string} [filename="<input>"]
 * @param {string} [sourceText=""]
 * @returns {{ ast: object, diagnostics: Array<object> }}
 */
export function parse(tokensOrSource, filename = "<input>", sourceText = "") {
  let tokens;
  let src = sourceText;
  let initialDiagnostics = [];

  if (typeof tokensOrSource === "string") {
    src = tokensOrSource;
    const lexResult = tokenize(src, filename);
    tokens = lexResult.tokens;
    initialDiagnostics = lexResult.diagnostics;
  } else if (Array.isArray(tokensOrSource)) {
    tokens =
      tokensOrSource.length > 0
        ? tokensOrSource
        : [createToken(TokenKind.EOF, "", null, createSpan(filename))];
  } else {
    tokens = [createToken(TokenKind.EOF, "", null, createSpan(filename))];
  }

  const parser = new Parser(tokens, filename, src, initialDiagnostics);
  const ast = parser.parseProgram();
  return {
    ast,
    diagnostics: parser.diagnostics,
  };
}
