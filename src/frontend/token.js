/**
 * Lumen Token Definitions (`src/frontend/token.js`)
 * Zero-dependency ES module defining all lexical token kinds and helpers.
 */

export const TokenKind = Object.freeze({
  // Keywords
  FN: "FN",
  PUB: "PUB",
  LET: "LET",
  MUT: "MUT",
  STRUCT: "STRUCT",
  ENUM: "ENUM",
  MATCH: "MATCH",
  IF: "IF",
  ELSE: "ELSE",
  WHILE: "WHILE",
  FOR: "FOR",
  IN: "IN",
  RETURN: "RETURN",
  BREAK: "BREAK",
  CONTINUE: "CONTINUE",
  IMPORT: "IMPORT",
  CONST: "CONST",
  AS: "AS",
  TRUE: "TRUE",
  FALSE: "FALSE",
  I32: "I32",
  I64: "I64",
  F64: "F64",
  BOOL: "BOOL",
  STRING: "STRING",
  VOID: "VOID",

  // Literals
  INT_LIT: "INT_LIT",
  INT64_LIT: "INT64_LIT",
  FLOAT_LIT: "FLOAT_LIT",
  STRING_LIT: "STRING_LIT",

  // Identifiers
  IDENT: "IDENT",

  // Operators
  PLUS: "PLUS",               // +
  MINUS: "MINUS",             // -
  STAR: "STAR",               // *
  SLASH: "SLASH",             // /
  PERCENT: "PERCENT",         // %
  EQ_EQ: "EQ_EQ",             // ==
  BANG_EQ: "BANG_EQ",         // !=
  LT: "LT",                   // <
  LT_EQ: "LT_EQ",             // <=
  GT: "GT",                   // >
  GT_EQ: "GT_EQ",             // >=
  AMP_AMP: "AMP_AMP",         // &&
  PIPE_PIPE: "PIPE_PIPE",     // ||
  BANG: "BANG",               // !
  AMP: "AMP",                 // &
  PIPE: "PIPE",               // |
  CARET: "CARET",             // ^
  TILDE: "TILDE",             // ~
  LT_LT: "LT_LT",             // <<
  GT_GT: "GT_GT",             // >>
  EQ: "EQ",                   // =
  PLUS_EQ: "PLUS_EQ",         // +=
  MINUS_EQ: "MINUS_EQ",       // -=
  STAR_EQ: "STAR_EQ",         // *=
  SLASH_EQ: "SLASH_EQ",       // /=
  ARROW: "ARROW",             // ->
  FAT_ARROW: "FAT_ARROW",     // =>
  COLON_COLON: "COLON_COLON", // ::
  DOT_DOT: "DOT_DOT",         // ..

  // Punctuation
  LPAREN: "LPAREN",           // (
  RPAREN: "RPAREN",           // )
  LBRACE: "LBRACE",           // {
  RBRACE: "RBRACE",           // }
  LBRACKET: "LBRACKET",       // [
  RBRACKET: "RBRACKET",       // ]
  COMMA: "COMMA",             // ,
  COLON: "COLON",             // :
  SEMI: "SEMI",               // ;
  DOT: "DOT",                 // .

  // Comments & End of File
  DOC_COMMENT: "DOC_COMMENT", // /// ...
  EOF: "EOF",
});

export const KEYWORDS = Object.freeze({
  fn: TokenKind.FN,
  pub: TokenKind.PUB,
  let: TokenKind.LET,
  mut: TokenKind.MUT,
  struct: TokenKind.STRUCT,
  enum: TokenKind.ENUM,
  match: TokenKind.MATCH,
  if: TokenKind.IF,
  else: TokenKind.ELSE,
  while: TokenKind.WHILE,
  for: TokenKind.FOR,
  in: TokenKind.IN,
  return: TokenKind.RETURN,
  break: TokenKind.BREAK,
  continue: TokenKind.CONTINUE,
  import: TokenKind.IMPORT,
  const: TokenKind.CONST,
  as: TokenKind.AS,
  true: TokenKind.TRUE,
  false: TokenKind.FALSE,
  i32: TokenKind.I32,
  i64: TokenKind.I64,
  f64: TokenKind.F64,
  bool: TokenKind.BOOL,
  string: TokenKind.STRING,
  void: TokenKind.VOID,
});

export const PRIMITIVE_TYPE_TOKENS = new Set([
  TokenKind.I32,
  TokenKind.I64,
  TokenKind.F64,
  TokenKind.BOOL,
  TokenKind.STRING,
  TokenKind.VOID,
]);

export const ASSIGN_OP_TOKENS = new Map([
  [TokenKind.EQ, "="],
  [TokenKind.PLUS_EQ, "+="],
  [TokenKind.MINUS_EQ, "-="],
  [TokenKind.STAR_EQ, "*="],
  [TokenKind.SLASH_EQ, "/="],
]);

export const TOKEN_SYMBOLS = Object.freeze({
  [TokenKind.FN]: "fn",
  [TokenKind.PUB]: "pub",
  [TokenKind.LET]: "let",
  [TokenKind.MUT]: "mut",
  [TokenKind.STRUCT]: "struct",
  [TokenKind.ENUM]: "enum",
  [TokenKind.MATCH]: "match",
  [TokenKind.IF]: "if",
  [TokenKind.ELSE]: "else",
  [TokenKind.WHILE]: "while",
  [TokenKind.FOR]: "for",
  [TokenKind.IN]: "in",
  [TokenKind.RETURN]: "return",
  [TokenKind.BREAK]: "break",
  [TokenKind.CONTINUE]: "continue",
  [TokenKind.IMPORT]: "import",
  [TokenKind.CONST]: "const",
  [TokenKind.AS]: "as",
  [TokenKind.TRUE]: "true",
  [TokenKind.FALSE]: "false",
  [TokenKind.I32]: "i32",
  [TokenKind.I64]: "i64",
  [TokenKind.F64]: "f64",
  [TokenKind.BOOL]: "bool",
  [TokenKind.STRING]: "string",
  [TokenKind.VOID]: "void",
  [TokenKind.INT_LIT]: "integer literal",
  [TokenKind.INT64_LIT]: "64-bit integer literal",
  [TokenKind.FLOAT_LIT]: "float literal",
  [TokenKind.STRING_LIT]: "string literal",
  [TokenKind.IDENT]: "identifier",
  [TokenKind.PLUS]: "+",
  [TokenKind.MINUS]: "-",
  [TokenKind.STAR]: "*",
  [TokenKind.SLASH]: "/",
  [TokenKind.PERCENT]: "%",
  [TokenKind.EQ_EQ]: "==",
  [TokenKind.BANG_EQ]: "!=",
  [TokenKind.LT]: "<",
  [TokenKind.LT_EQ]: "<=",
  [TokenKind.GT]: ">",
  [TokenKind.GT_EQ]: ">=",
  [TokenKind.AMP_AMP]: "&&",
  [TokenKind.PIPE_PIPE]: "||",
  [TokenKind.BANG]: "!",
  [TokenKind.AMP]: "&",
  [TokenKind.PIPE]: "|",
  [TokenKind.CARET]: "^",
  [TokenKind.TILDE]: "~",
  [TokenKind.LT_LT]: "<<",
  [TokenKind.GT_GT]: ">>",
  [TokenKind.EQ]: "=",
  [TokenKind.PLUS_EQ]: "+=",
  [TokenKind.MINUS_EQ]: "-=",
  [TokenKind.STAR_EQ]: "*=",
  [TokenKind.SLASH_EQ]: "/=",
  [TokenKind.ARROW]: "->",
  [TokenKind.FAT_ARROW]: "=>",
  [TokenKind.COLON_COLON]: "::",
  [TokenKind.DOT_DOT]: "..",
  [TokenKind.LPAREN]: "(",
  [TokenKind.RPAREN]: ")",
  [TokenKind.LBRACE]: "{",
  [TokenKind.RBRACE]: "}",
  [TokenKind.LBRACKET]: "[",
  [TokenKind.RBRACKET]: "]",
  [TokenKind.COMMA]: ",",
  [TokenKind.COLON]: ":",
  [TokenKind.SEMI]: ";",
  [TokenKind.DOT]: ".",
  [TokenKind.DOC_COMMENT]: "doc comment",
  [TokenKind.EOF]: "end of file",
});

export function createToken(kind, lexeme, value, span) {
  return {
    kind,
    lexeme,
    value,
    span,
  };
}

export function isPrimitiveTypeToken(kind) {
  return PRIMITIVE_TYPE_TOKENS.has(kind);
}

export function formatTokenKind(kind) {
  return TOKEN_SYMBOLS[kind] || String(kind);
}
