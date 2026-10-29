/**
 * Lumen Lexer (`src/frontend/lexer.js`)
 * Tokenizes Lumen source code into a stream of spanned tokens with error recovery.
 */

import {
  ErrorCodes,
  createSpan,
  createDiagnostic,
} from "../contracts/index.js";
import { TokenKind, KEYWORDS, createToken } from "./token.js";

function isAsciiDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch) {
  return (
    (ch >= "0" && ch <= "9") ||
    (ch >= "a" && ch <= "f") ||
    (ch >= "A" && ch <= "F")
  );
}

function isIdentStart(ch) {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "_"
  );
}

function isIdentContinue(ch) {
  return isIdentStart(ch) || isAsciiDigit(ch);
}

/**
 * Tokenize Lumen source string into tokens and diagnostics.
 * @param {string} source
 * @param {string} [filename="<input>"]
 * @returns {{ tokens: Array<object>, diagnostics: Array<object> }}
 */
export function tokenize(source, filename = "<input>") {
  const src = typeof source === "string" ? source : String(source ?? "");
  const lines = src.split(/\r?\n/);
  const tokens = [];
  const diagnostics = [];

  let pos = 0;
  let line = 1;
  let col = 1;
  const len = src.length;

  function getLineText(lineNum) {
    return lines[lineNum - 1] ?? "";
  }

  function peek(offset = 0) {
    const idx = pos + offset;
    return idx < len ? src[idx] : "\0";
  }

  function advance() {
    const ch = src[pos++];
    if (ch === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  }

  function addDiag(code, message, span, suggestion = null) {
    diagnostics.push(
      createDiagnostic({
        code,
        severity: "error",
        message,
        span,
        sourceLine: getLineText(span.startLine),
        suggestion,
      })
    );
  }

  while (pos < len) {
    const ch = peek();

    // 1. Whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance();
      continue;
    }

    const startOffset = pos;
    const startLine = line;
    const startCol = col;

    // 2. Comments (`///`, `//`, `/* ... */`)
    if (ch === "/") {
      const next = peek(1);
      if (next === "/") {
        // Check for doc comment `///` (but not `////`)
        if (peek(2) === "/" && peek(3) !== "/") {
          advance(); // /
          advance(); // /
          advance(); // /
          let docText = "";
          while (pos < len && peek() !== "\n" && peek() !== "\r") {
            docText += advance();
          }
          const span = createSpan(
            filename,
            startLine,
            startCol,
            line,
            col,
            startOffset,
            pos
          );
          const cleaned = docText.startsWith(" ") ? docText.slice(1) : docText;
          tokens.push(
            createToken(
              TokenKind.DOC_COMMENT,
              src.slice(startOffset, pos),
              cleaned,
              span
            )
          );
          continue;
        }
        // Regular single-line comment
        while (pos < len && peek() !== "\n") {
          advance();
        }
        continue;
      }

      if (next === "*") {
        advance(); // /
        advance(); // *
        let depth = 1;
        while (pos < len && depth > 0) {
          if (peek() === "/" && peek(1) === "*") {
            advance();
            advance();
            depth++;
          } else if (peek() === "*" && peek(1) === "/") {
            advance();
            advance();
            depth--;
          } else {
            advance();
          }
        }
        if (depth > 0) {
          const span = createSpan(
            filename,
            startLine,
            startCol,
            line,
            col,
            startOffset,
            pos
          );
          addDiag(
            ErrorCodes.LEX_UNTERMINATED_COMMENT,
            "unterminated block comment",
            span,
            "Add closing `*/` to terminate the block comment"
          );
        }
        continue;
      }
    }

    // 3. String Literals
    if (ch === '"') {
      advance(); // opening "
      let value = "";
      let terminated = false;

      while (pos < len) {
        const c = peek();
        if (c === '"') {
          advance();
          terminated = true;
          break;
        }
        if (c === "\n" || c === "\r") {
          // Stop before newline to recover cleanly on unterminated single-line strings
          break;
        }
        if (c === "\\") {
          const escStartLine = line;
          const escStartCol = col;
          const escStartOffset = pos;
          advance(); // consume \
          if (pos >= len) {
            break;
          }
          const esc = advance();
          switch (esc) {
            case "n":
              value += "\n";
              break;
            case "t":
              value += "\t";
              break;
            case "r":
              value += "\r";
              break;
            case "\\":
              value += "\\";
              break;
            case '"':
              value += '"';
              break;
            case "'":
              value += "'";
              break;
            case "0":
              value += "\0";
              break;
            case "x": {
              if (isHexDigit(peek()) && isHexDigit(peek(1))) {
                const hex = advance() + advance();
                value += String.fromCharCode(parseInt(hex, 16));
              } else {
                const escSpan = createSpan(
                  filename,
                  escStartLine,
                  escStartCol,
                  line,
                  col,
                  escStartOffset,
                  pos
                );
                addDiag(
                  ErrorCodes.LEX_INVALID_ESCAPE,
                  "invalid hex escape sequence in string literal",
                  escSpan,
                  "Use two hexadecimal digits after `\\x`, e.g. `\\x41`"
                );
              }
              break;
            }
            case "u": {
              if (peek() === "{") {
                advance(); // {
                let hex = "";
                while (pos < len && isHexDigit(peek())) {
                  hex += advance();
                }
                if (peek() === "}" && hex.length > 0 && hex.length <= 6) {
                  advance(); // }
                  value += String.fromCodePoint(parseInt(hex, 16));
                } else {
                  const escSpan = createSpan(
                    filename,
                    escStartLine,
                    escStartCol,
                    line,
                    col,
                    escStartOffset,
                    pos
                  );
                  addDiag(
                    ErrorCodes.LEX_INVALID_ESCAPE,
                    "invalid unicode escape sequence in string literal",
                    escSpan,
                    "Use `\\u{XXXX}` with 1 to 6 hex digits"
                  );
                }
              } else {
                const escSpan = createSpan(
                  filename,
                  escStartLine,
                  escStartCol,
                  line,
                  col,
                  escStartOffset,
                  pos
                );
                addDiag(
                  ErrorCodes.LEX_INVALID_ESCAPE,
                  `invalid escape sequence \`\\u\` in string literal`,
                  escSpan,
                  "Use `\\u{XXXX}` for unicode escapes"
                );
              }
              break;
            }
            default: {
              const escSpan = createSpan(
                filename,
                escStartLine,
                escStartCol,
                line,
                col,
                escStartOffset,
                pos
              );
              addDiag(
                ErrorCodes.LEX_INVALID_ESCAPE,
                `unknown character escape \`\\${esc}\` in string literal`,
                escSpan,
                "Valid escapes are `\\n`, `\\t`, `\\r`, `\\\\`, `\\\"`, and `\\0`"
              );
              value += esc;
              break;
            }
          }
        } else {
          value += advance();
        }
      }

      const span = createSpan(
        filename,
        startLine,
        startCol,
        line,
        col,
        startOffset,
        pos
      );

      if (!terminated) {
        addDiag(
          ErrorCodes.LEX_UNTERMINATED_STRING,
          "unterminated string literal",
          span,
          'Add a closing double quote `"` to terminate the string literal'
        );
      }

      tokens.push(
        createToken(
          TokenKind.STRING_LIT,
          src.slice(startOffset, pos),
          value,
          span
        )
      );
      continue;
    }

    // 4. Number Literals (Integer, i64, Float, Hex, Binary, Octal)
    if (isAsciiDigit(ch)) {
      let isFloat = false;
      let base = 10;
      let rawDigits = "";
      let invalidNumber = false;

      if (ch === "0" && (peek(1) === "x" || peek(1) === "X")) {
        advance(); // 0
        advance(); // x
        base = 16;
        while (pos < len && (isHexDigit(peek()) || peek() === "_")) {
          const c = advance();
          if (c !== "_") rawDigits += c;
        }
        if (rawDigits.length === 0) {
          invalidNumber = true;
        }
      } else if (ch === "0" && (peek(1) === "b" || peek(1) === "B")) {
        advance(); // 0
        advance(); // b
        base = 2;
        while (pos < len && (peek() === "0" || peek() === "1" || peek() === "_")) {
          const c = advance();
          if (c !== "_") rawDigits += c;
        }
        if (rawDigits.length === 0) {
          invalidNumber = true;
        }
      } else if (ch === "0" && (peek(1) === "o" || peek(1) === "O")) {
        advance(); // 0
        advance(); // o
        base = 8;
        while (pos < len && ((peek() >= "0" && peek() <= "7") || peek() === "_")) {
          const c = advance();
          if (c !== "_") rawDigits += c;
        }
        if (rawDigits.length === 0) {
          invalidNumber = true;
        }
      } else {
        while (pos < len && (isAsciiDigit(peek()) || peek() === "_")) {
          const c = advance();
          if (c !== "_") rawDigits += c;
        }

        // Fractional part `.digits` (careful not to consume `..` range operator)
        if (peek() === "." && peek(1) !== "." && isAsciiDigit(peek(1))) {
          isFloat = true;
          rawDigits += advance(); // .
          while (pos < len && (isAsciiDigit(peek()) || peek() === "_")) {
            const c = advance();
            if (c !== "_") rawDigits += c;
          }
        }

        // Exponent part `e+10` / `E-5`
        if (peek() === "e" || peek() === "E") {
          isFloat = true;
          rawDigits += advance(); // e/E
          if (peek() === "+" || peek() === "-") {
            rawDigits += advance();
          }
          let expDigits = 0;
          while (pos < len && (isAsciiDigit(peek()) || peek() === "_")) {
            const c = advance();
            if (c !== "_") {
              rawDigits += c;
              expDigits++;
            }
          }
          if (expDigits === 0) {
            invalidNumber = true;
          }
        }
      }

      // Check optional type suffix (`i64`, `L`, `i32`, `f64`, or invalid suffix)
      let suffix = "";
      if (isIdentStart(peek())) {
        while (pos < len && isIdentContinue(peek())) {
          suffix += advance();
        }
      }

      const lexeme = src.slice(startOffset, pos);
      const span = createSpan(
        filename,
        startLine,
        startCol,
        line,
        col,
        startOffset,
        pos
      );

      if (invalidNumber) {
        addDiag(
          ErrorCodes.LEX_INVALID_NUMBER,
          `malformed numeric literal \`${lexeme}\``,
          span,
          "Ensure numeric literals contain valid digits after base or exponent prefixes"
        );
        tokens.push(createToken(TokenKind.INT_LIT, lexeme, 0, span));
        continue;
      }

      if (suffix !== "") {
        if ((suffix === "i64" || suffix === "L") && !isFloat) {
          const bigText =
            base === 16
              ? `0x${rawDigits}`
              : base === 2
              ? `0b${rawDigits}`
              : base === 8
              ? `0o${rawDigits}`
              : rawDigits;
          let val = 0n;
          try {
            val = BigInt(bigText);
          } catch {
            addDiag(
              ErrorCodes.LEX_INVALID_NUMBER,
              `invalid 64-bit integer literal \`${lexeme}\``,
              span,
              "Use a valid integer before `i64` or `L`"
            );
          }
          tokens.push(createToken(TokenKind.INT64_LIT, lexeme, val, span));
          continue;
        } else if (suffix === "i32" && !isFloat) {
          const val = parseInt(rawDigits, base);
          tokens.push(createToken(TokenKind.INT_LIT, lexeme, val, span));
          continue;
        } else if (suffix === "f64" && base === 10) {
          const val = parseFloat(rawDigits);
          tokens.push(createToken(TokenKind.FLOAT_LIT, lexeme, val, span));
          continue;
        } else {
          addDiag(
            ErrorCodes.LEX_INVALID_NUMBER,
            `invalid numeric suffix \`${suffix}\` on literal \`${lexeme}\``,
            span,
            "Valid numeric suffixes are `i32`, `i64`, `L`, or `f64`"
          );
          tokens.push(
            createToken(
              isFloat ? TokenKind.FLOAT_LIT : TokenKind.INT_LIT,
              lexeme,
              isFloat ? parseFloat(rawDigits) || 0 : parseInt(rawDigits, base) || 0,
              span
            )
          );
          continue;
        }
      }

      if (isFloat) {
        const val = parseFloat(rawDigits);
        tokens.push(createToken(TokenKind.FLOAT_LIT, lexeme, val, span));
      } else {
        const val = parseInt(rawDigits, base);
        tokens.push(createToken(TokenKind.INT_LIT, lexeme, val, span));
      }
      continue;
    }

    // 5. Identifiers and Keywords
    if (isIdentStart(ch)) {
      while (pos < len && isIdentContinue(peek())) {
        advance();
      }
      const lexeme = src.slice(startOffset, pos);
      const span = createSpan(
        filename,
        startLine,
        startCol,
        line,
        col,
        startOffset,
        pos
      );
      if (Object.prototype.hasOwnProperty.call(KEYWORDS, lexeme)) {
        const kind = KEYWORDS[lexeme];
        const value =
          kind === TokenKind.TRUE
            ? true
            : kind === TokenKind.FALSE
            ? false
            : lexeme;
        tokens.push(createToken(kind, lexeme, value, span));
      } else {
        tokens.push(createToken(TokenKind.IDENT, lexeme, lexeme, span));
      }
      continue;
    }

    // 6. Operators & Punctuation
    advance(); // consume ch
    const next = peek();
    let kind = null;

    switch (ch) {
      case "+":
        if (next === "=") {
          advance();
          kind = TokenKind.PLUS_EQ;
        } else {
          kind = TokenKind.PLUS;
        }
        break;
      case "-":
        if (next === "=") {
          advance();
          kind = TokenKind.MINUS_EQ;
        } else if (next === ">") {
          advance();
          kind = TokenKind.ARROW;
        } else {
          kind = TokenKind.MINUS;
        }
        break;
      case "*":
        if (next === "=") {
          advance();
          kind = TokenKind.STAR_EQ;
        } else {
          kind = TokenKind.STAR;
        }
        break;
      case "/":
        if (next === "=") {
          advance();
          kind = TokenKind.SLASH_EQ;
        } else {
          kind = TokenKind.SLASH;
        }
        break;
      case "%":
        kind = TokenKind.PERCENT;
        break;
      case "=":
        if (next === "=") {
          advance();
          kind = TokenKind.EQ_EQ;
        } else if (next === ">") {
          advance();
          kind = TokenKind.FAT_ARROW;
        } else {
          kind = TokenKind.EQ;
        }
        break;
      case "!":
        if (next === "=") {
          advance();
          kind = TokenKind.BANG_EQ;
        } else {
          kind = TokenKind.BANG;
        }
        break;
      case "<":
        if (next === "=") {
          advance();
          kind = TokenKind.LT_EQ;
        } else if (next === "<") {
          advance();
          kind = TokenKind.LT_LT;
        } else {
          kind = TokenKind.LT;
        }
        break;
      case ">":
        if (next === "=") {
          advance();
          kind = TokenKind.GT_EQ;
        } else if (next === ">") {
          advance();
          kind = TokenKind.GT_GT;
        } else {
          kind = TokenKind.GT;
        }
        break;
      case "&":
        if (next === "&") {
          advance();
          kind = TokenKind.AMP_AMP;
        } else {
          kind = TokenKind.AMP;
        }
        break;
      case "|":
        if (next === "|") {
          advance();
          kind = TokenKind.PIPE_PIPE;
        } else {
          kind = TokenKind.PIPE;
        }
        break;
      case "^":
        kind = TokenKind.CARET;
        break;
      case "~":
        kind = TokenKind.TILDE;
        break;
      case ":":
        if (next === ":") {
          advance();
          kind = TokenKind.COLON_COLON;
        } else {
          kind = TokenKind.COLON;
        }
        break;
      case ".":
        if (next === ".") {
          advance();
          kind = TokenKind.DOT_DOT;
        } else {
          kind = TokenKind.DOT;
        }
        break;
      case "(":
        kind = TokenKind.LPAREN;
        break;
      case ")":
        kind = TokenKind.RPAREN;
        break;
      case "{":
        kind = TokenKind.LBRACE;
        break;
      case "}":
        kind = TokenKind.RBRACE;
        break;
      case "[":
        kind = TokenKind.LBRACKET;
        break;
      case "]":
        kind = TokenKind.RBRACKET;
        break;
      case ",":
        kind = TokenKind.COMMA;
        break;
      case ";":
        kind = TokenKind.SEMI;
        break;
      default: {
        const span = createSpan(
          filename,
          startLine,
          startCol,
          line,
          col,
          startOffset,
          pos
        );
        addDiag(
          ErrorCodes.LEX_UNEXPECTED_CHAR,
          `unexpected character \`${ch}\``,
          span,
          `Remove or replace the unsupported character \`${ch}\``
        );
        break;
      }
    }

    if (kind !== null) {
      const lexeme = src.slice(startOffset, pos);
      const span = createSpan(
        filename,
        startLine,
        startCol,
        line,
        col,
        startOffset,
        pos
      );
      tokens.push(createToken(kind, lexeme, lexeme, span));
    }
  }

  const eofSpan = createSpan(filename, line, col, line, col, pos, pos);
  tokens.push(createToken(TokenKind.EOF, "", null, eofSpan));

  return { tokens, diagnostics };
}
