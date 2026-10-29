# Lumen Project Status (`STATUS.md`)

**Current Milestone**: M3 Complete (Stopped at M3 Gate awaiting user confirmation to start M4)  
**Last Updated**: 2026-10-29

---

## Milestone Progress

| Milestone | Description | Status | Gate Evidence |
| :--- | :--- | :--- | :--- |
| **Step 1** | Architecture, AST/IR Specs & Task Plan | **COMPLETE** | `implementation_plan.md` & 18 contract/GC/debugger fixes recorded |
| **M1** | Hello World compiled & running in CLI and Browser | **COMPLETE** | `node bin/lumen.js run examples/hello.lm` (`Hello, World!`, 555B `.wasm`) + Browser Playground verified (`m1_playground_hello.png`) |
| **M2** | Ints, floats, control flow, functions, 50+ tests | **COMPLETE** | Full test suite passed: **92/92 tests (0 failed)** across Interpreter and Wasm |
| **M3** | Structs, enums, pattern matching, arrays, strings | **COMPLETE** | Full test suite passed: **167/167 tests (0 failed)** across Interpreter and Wasm (`node bin/lumen.js test`) |
| **M4** | Generics, bidirectional type inference, closures | PENDING | Waiting for user approval to begin M4 |
| **M5** | In-Wasm Garbage Collector, modules & standard library | PENDING | Pending |
| **M6** | IR Optimizer (`-O2`) & 5 benchmarks vs. JS | PENDING | Pending |
| **M7** | Playground Step Debugger & Live GC Visualizer | PENDING | Pending |
| **M8** | 400+ tests, 10-min fuzzer, reference docs, hostile review | PENDING | Pending |

---

## What Works (M3)
- **Data Structures**:
  - Structs: Field access, field mutation, aliasing with reference semantics, nested structs, structs containing arrays of structs.
  - Enums with Data: Unit variants, single-payload, and multi-payload variants. Tag at `+8`, payload at `16 + 8*i`.
  - Built-in Prelude ADTs: `Option<T>` (`Some(T)`, `None`), `Result<T, E>` (`Ok(T)`, `Err(E)`).
- **Pattern Matching & Exhaustiveness**:
  - Maranget's usefulness algorithm for exhaustiveness (`E0301`) and redundancy/unreachable arm checking (`E0302`).
  - Guarded arms (`pat if cond`) never count toward exhaustiveness.
  - Pattern arity verification (`E0303`).
  - Nested patterns, wildcards `_`, literal patterns (integers, booleans, strings).
- **Dynamic Arrays**:
  - Literal syntax `[...]`, indexing read and in-place write `arr[i] = val`.
  - Explicit bounds checks (`0 <= i < len`) trapping with `"runtime error: index out of bounds"` (exit code 1).
  - Array aliasing with in-place reference mutation.
  - Built-ins: `array_len(arr)`, `array_push(arr, val)` with dynamic growth, `array_pop(arr)` trapping on empty array with `"runtime error: pop from empty array"`, `array_new()`.
- **Strings**:
  - Raw UTF-8 byte semantics: `str_len("é") === 2`, `str_slice("é", 0, 1)` yields byte length 1 and first byte 195 (`0xC3`).
  - Escaped characters, quotes, string concatenation (`+`), `str_eq`, `str_char_at`, `str_from_char_code`.
- **GC Safety Invariants**:
  - Bump allocator with zero-filled payloads and GC object headers (`OBJ_KIND`).
  - Allocate-then-fill lowering (temporaries evaluated into locals before allocation).
  - Stack safety: no `gc_ref` sits on the Wasm operand stack across function calls or allocations.
  - `validateLir` rejects any LIR with unrooted `gc_ref` across calls or offsets `< 8`.
- **Diagnostics & Testing**:
  - 100% test coverage across all 36 contract `ErrorCodes` (including `E0105`, `E0207-E0212`, `E0301-E0303`).
  - 167 total tests with hardcoded expected outputs, verified for 100% Interpreter vs. Wasm parity.

---

## What Is Broken / Incomplete
- M4–M8 features (generics, bidirectional type inference, closures, full mark-and-sweep GC collector, optimizer, playground debugger, and fuzzer) are strictly scheduled for Milestones M4–M8.
