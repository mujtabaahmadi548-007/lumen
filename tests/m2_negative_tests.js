/**
 * Lumen Milestone 2 — Negative Tests Suite (`tests/m2_negative_tests.js`)
 * Owned exclusively by Agent G.
 *
 * Covers EVERY single error code in `src/contracts/index.js` ErrorCodes:
 * - Lexer: E0001 - E0005
 * - Parser: E0101, E0102, E0103, E0104, E0106, E0107
 * - Type Checker: E0201 - E0206, E0213, E0214, E0217 - E0223
 * Plus the combined test: syntax error + type error reported together.
 */

export const M2_NEGATIVE_TESTS = [
  // ==========================================================================
  // Lexer Error Codes (E0001 - E0005)
  // ==========================================================================
  {
    name: "lex_unexpected_char_e0001",
    expectedCode: "E0001",
    source: `
fn main() {
    let x = 1 @ 2;
}
`,
  },
  {
    name: "lex_unterminated_string_e0002",
    expectedCode: "E0002",
    source: `
fn main() {
    let s = "hello world
}
`,
  },
  {
    name: "lex_invalid_escape_e0003",
    expectedCode: "E0003",
    source: `
fn main() {
    let s = "invalid \\q escape";
}
`,
  },
  {
    name: "lex_invalid_number_e0004",
    expectedCode: "E0004",
    source: `
fn main() {
    let x = 123.456.789;
}
`,
  },
  {
    name: "lex_unterminated_comment_e0005",
    expectedCode: "E0005",
    source: `
/* This comment is never closed
fn main() {
}
`,
  },

  // ==========================================================================
  // Parser Error Codes (E0101 - E0107)
  // ==========================================================================
  {
    name: "parse_unexpected_token_e0101",
    expectedCode: "E0101",
    source: `
fn main() {
    let x = 1;
    )
}
`,
  },
  {
    name: "parse_expected_token_e0102",
    expectedCode: "E0102",
    source: `
fn main() {
    let x = 10
    println(x);
}
`,
  },
  {
    name: "parse_expected_expr_e0103",
    expectedCode: "E0103",
    source: `
fn main() {
    let x = ;
}
`,
  },
  {
    name: "parse_expected_type_e0104",
    expectedCode: "E0104",
    source: `
fn main() {
    let x: = 10;
}
`,
  },
  {
    name: "parse_invalid_assign_target_e0106",
    expectedCode: "E0106",
    source: `
fn main() {
    1 + 2 = 3;
}
`,
  },
  {
    name: "parse_expected_decl_e0107",
    expectedCode: "E0107",
    source: `
let top_level_stmt = 42;
fn main() {
}
`,
  },

  // ==========================================================================
  // Type Checker Error Codes (E0201 - E0206, E0213, E0214, E0217 - E0223)
  // ==========================================================================
  {
    name: "type_mismatch_e0201",
    expectedCode: "E0201",
    source: `
fn main() {
    let x: i32 = true;
}
`,
  },
  {
    name: "type_undefined_var_e0202",
    expectedCode: "E0202",
    source: `
fn main() {
    let x = undefined_var + 1;
}
`,
  },
  {
    name: "type_undefined_type_e0203",
    expectedCode: "E0203",
    source: `
fn main() {
    let x: NonExistentType = 1;
}
`,
  },
  {
    name: "type_undefined_fn_e0204",
    expectedCode: "E0204",
    source: `
fn main() {
    non_existent_function(42);
}
`,
  },
  {
    name: "type_arity_mismatch_e0205",
    expectedCode: "E0205",
    source: `
fn add(a: i32, b: i32) -> i32 {
    a + b
}
fn main() {
    add(1, 2, 3);
}
`,
  },
  {
    name: "type_immutable_assign_e0206",
    expectedCode: "E0206",
    source: `
fn main() {
    let x = 10;
    x = 20;
}
`,
  },
  {
    name: "type_not_callable_e0213",
    expectedCode: "E0213",
    source: `
fn main() {
    let x = 42;
    x(10);
}
`,
  },
  {
    name: "type_invalid_cast_e0214",
    expectedCode: "E0214",
    source: `
fn main() {
    let s = "hello";
    let x = s as i32;
}
`,
  },
  {
    name: "type_return_mismatch_e0217",
    expectedCode: "E0217",
    source: `
fn compute() -> i32 {
    return true;
}
fn main() {
    compute();
}
`,
  },
  {
    name: "type_missing_return_e0218",
    expectedCode: "E0218",
    source: `
fn calculate(cond: bool) -> i32 {
    if cond {
        return 42;
    }
}
fn main() {
    calculate(true);
}
`,
  },
  {
    name: "type_break_outside_loop_e0219",
    expectedCode: "E0219",
    source: `
fn main() {
    break;
}
`,
  },
  {
    name: "type_duplicate_symbol_e0220",
    expectedCode: "E0220",
    source: `
fn foo() {}
fn foo() {}
fn main() {}
`,
  },
  {
    name: "type_condition_not_bool_e0221",
    expectedCode: "E0221",
    source: `
fn main() {
    if 42 {
        println(1);
    }
}
`,
  },
  {
    name: "type_binary_op_mismatch_e0222",
    expectedCode: "E0222",
    source: `
fn main() {
    let x = true + 42;
}
`,
  },
  {
    name: "type_unary_op_mismatch_e0223",
    expectedCode: "E0223",
    source: `
fn main() {
    let x = !42;
}
`,
  },

  // ==========================================================================
  // Edge Case 3: Combined Syntax Error + Type Error in a single compilation
  // ==========================================================================
  {
    name: "syntax_and_type_error_both_reported",
    expectedCodes: ["E0103", "E0201"],
    source: `
fn main() {
    let a = ;
    let b: i32 = true;
}
`,
  },
];
