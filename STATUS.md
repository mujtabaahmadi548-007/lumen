# Lumen Project Status (`STATUS.md`)

**Current Milestone**: M3 Complete (Project wrapped up at M3)  
**Last Updated**: 2026-10-29

---

## Milestone Progress

| Milestone | Description | Status | Gate Evidence |
| :--- | :--- | :--- | :--- |
| **Step 1** | Architecture, AST/IR Specs & Contracts | **COMPLETE** | `implementation_plan.md` & contract specifications recorded |
| **M1** | Hello World compiled & running in CLI and Browser | **COMPLETE** | `node bin/lumen.js run examples/hello.lm` (`Hello, World!`, 555B `.wasm`) + Browser Playground verified (`m1_playground_hello.png`) |
| **M2** | Ints, floats, control flow, functions, 50+ tests | **COMPLETE** | Full test suite passed: **92/92 tests (0 failed)** across Interpreter and Wasm |
| **M3** | Structs, enums, pattern matching, arrays, strings | **COMPLETE** | Full test suite passed: **167/167 tests (0 failed)** across Interpreter and Wasm (`node bin/lumen.js test`) |
| **M4** | Generics, bidirectional type inference, closures | **NOT BUILT** | Out of scope for M1–M3 wrap-up |
| **M5** | In-Wasm Garbage Collector, modules & standard library | **NOT BUILT** | Out of scope for M1–M3 wrap-up |
| **M6** | IR Optimizer (`-O2`) & benchmarks | **NOT BUILT** | Out of scope for M1–M3 wrap-up |
| **M7** | Playground Step Debugger & Live GC Visualizer | **NOT BUILT** | Out of scope for M1–M3 wrap-up |
| **M8** | 400+ tests, fuzzer, reference docs | **NOT BUILT** | Out of scope for M1–M3 wrap-up |

---

## What Works (Complete in M1 – M3)

- **Primitive Types & Operations**:
  - `i32`, `i64`, `f64`, `bool`.
  - Arithmetic wraparound on overflow, masked shifts (`% 32` / `% 64`), saturating `f64` to `i32`/`i64` casts.
  - Relational and short-circuit logical operators (`&&`, `||`).
- **Control Flow & Functions**:
  - `let`, `let mut`, compound assignments (`+=`, `-=`, `*=`, `/=`, `%=`).
  - `if`/`else` statements and expressions, `while` loops, `for` loops over ranges `a..b`, `break`, `continue`, `return`.
  - Mutual recursion, Ackermann function, Fibonacci, and deeply nested calls.
- **Data Structures**:
  - **Structs**: Field reading, in-place field mutation, aliasing with reference semantics, nested structs, structs containing arrays of structs.
  - **Enums with Data**: Unit variants, single-payload variants, and multi-payload variants with fixed memory layout (tag at offset `+8`, payload at `16 + 8*i`).
  - **Option & Result**: Built-in prelude ADTs `Option<T>` (`Some`, `None`) and `Result<T, E>` (`Ok`, `Err`).
- **Dynamic Arrays & Strings**:
  - Dynamic arrays with bounds checking, `array_len`, `array_push` (dynamic growth), `array_pop`.
  - UTF-8 byte strings with byte-level length (`str_len`), slicing (`str_slice`), indexing (`str_char_at`), character conversion (`str_from_char_code`), concatenation (`+`), and equality (`==`).
- **Pattern Matching & Exhaustiveness**:
  - Nested pattern destructuring with Maranget's usefulness algorithm for exhaustiveness (`E0301`) and redundancy analysis (`E0302`).
  - Match arm guards (`pat if cond`) do not count toward exhaustiveness.
- **Diagnostics & Error Handling**:
  - Standardized error formatting with filename, line, column, caret pointer snippet, and actionable fix suggestions (`= help:`).
  - 100% coverage of defined contract error codes (`E0001`–`E0005`, `E0101`–`E0107`, `E0201`–`E0214`, `E0217`–`E0223`, `E0301`–`E0303`).
  - Standardized runtime trap messages (`"runtime error: <msg>"`) exiting with code 1 across both Wasm and Reference Interpreter.

---

## Status and Known Limitations (What Is Not Built)

- **Generics**: Generic functions, structs, and enums (`<T, U>`) and monomorphization are **not built**.
- **Closures**: Closures (`|x| ...`), lambda expressions, variable capturing, and first-class function values are **not built**.
- **Garbage Collector**: The mark-and-sweep garbage collector is **not built**. Heap allocation uses a bump allocator inside WebAssembly linear memory; **memory is never freed**.
- **Optimizer**: The IR optimization pipeline (`-O2`, constant folding, dead code elimination, function inlining) is **not built**.
- **Debugger**: Interactive step debugging (breakpoints, step in/out, variable inspection) and live GC visualizer in the playground are **not built**.
- **Modules & Imports**: Module system and standard library written in Lumen are **not built**.

---

## Test Verification

The full test suite (`node bin/lumen.js test`) executes 167 tests with **100% pass rate** and **zero failures**, verifying identical stdout, stderr, and exit codes between compiled WebAssembly and the Reference Interpreter:
- Positive & Runtime Trap Tests: 120
- CLI Verification Tests: 2
- Negative Error Diagnostic Tests: 40
- LIR GC Safety & Invariant Tests: 4
- Total: **167/167 passed (0 failed)**
