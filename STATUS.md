# Lumen Project Status (`STATUS.md`)

**Current Milestone**: M2 Complete (Stopped at M2 Gate awaiting user confirmation to start M3)  
**Last Updated**: 2026-10-29

---

## Milestone Progress

| Milestone | Description | Status | Gate Evidence |
| :--- | :--- | :--- | :--- |
| **Step 1** | Architecture, AST/IR Specs & Task Plan | **COMPLETE** | `implementation_plan.md` & 18 contract/GC/debugger fixes recorded |
| **M1** | Hello World compiled & running in CLI and Browser | **COMPLETE** | `node bin/lumen.js run examples/hello.lm` (`Hello, World!`, 555B `.wasm`) + Browser Playground verified (`m1_playground_hello.png`) |
| **M2** | Ints, floats, control flow, functions, 50+ tests | **COMPLETE** | Full test suite passed: **92/92 tests (0 failed)** across Interpreter and Wasm (`tests/run_tests.js`) |
| **M3** | Structs, enums, pattern matching, arrays, strings | PENDING | Waiting for user approval to begin M3 |
| **M4** | Generics, bidirectional type inference, closures | PENDING | Pending |
| **M5** | In-Wasm Garbage Collector, modules & standard library | PENDING | Pending |
| **M6** | IR Optimizer (`-O2`) & 5 benchmarks vs. JS | PENDING | Pending |
| **M7** | Playground Step Debugger & Live GC Visualizer | PENDING | Pending |
| **M8** | 400+ tests, 10-min fuzzer, reference docs, hostile review | PENDING | Pending |

---

## What Works (M2)
- **Numeric & Primitive Types**: `i32`, `i64`, `f64`, `bool`, `string`, `void`.
- **Operators**:
  - Arithmetic: `+`, `-`, `*`, `/`, `%`, unary `-` (with two's complement wraparound for `+`, `-`, `*`, and traps on `/ 0`, `% 0`, `INT_MIN / -1`).
  - Bitwise: `&`, `|`, `^`, `~`, `<<`, `>>` (shifts masked by `& 31` for `i32`, `& 63n` for `i64`).
  - Comparison: `==`, `!=`, `<`, `<=`, `>`, `>=`.
  - Logical: `&&`, `||` (with short-circuit evaluation), `!`.
- **Type Casts**: `as` (`i32`, `i64`, `f64`, `bool` with saturating `f64` to int casts where `NaN -> 0`).
- **Variables & Control Flow**:
  - `let` and `let mut` (immutability enforcement).
  - Assignments: `=`, `+=`, `-=`, `*=`, `/=`.
  - `if`/`else if`/`else` statements and `if`/`else` expressions (producing values).
  - `while` loops with `break` and `continue`.
  - `for i in a..b` loops with range bounds and proper loop-counter increment on `continue`.
  - Recursive functions (tested with `fib(20)`, mutual recursion, Ackermann, factorial, gcd).
- **Diagnostics & Error Recovery**:
  - Precise line, column, caret underline `^`, and `= help:` suggestions.
  - Parser error recovery: programs with a syntax error and a type error report **both** errors in one pass.
  - 100% negative test coverage across all 26 `ErrorCodes`.
- **CLI**:
  - `lumen build <file.lm> -o <out.wasm>`: `-o` controls output path and creates parent directories if needed.
  - `lumen run <file.lm>` / `lumen run <file.lm> --interp`: prints `"runtime error: <message>"` and exits with code `1` on traps.
  - `lumen fmt <file.lm>`: formats source code canonically.
  - `lumen test`: runs full test suite.

## What Is Broken / Incomplete
- M3–M8 features (structs, enums, pattern matching, arrays, generics, closures, GC, optimizer, and fuzzer) are scheduled for Milestones M3–M8 and have not been built yet per strict milestone gating.

## Known Limitations & Uncertainties
- None for M2.
