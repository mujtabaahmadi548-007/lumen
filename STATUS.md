# Lumen Project Status (`STATUS.md`)

**Current Milestone**: M1 Complete (Stopped at M1 Gate awaiting user confirmation to start M2)  
**Last Updated**: 2026-10-29

---

## Milestone Progress

| Milestone | Description | Status | Gate Evidence |
| :--- | :--- | :--- | :--- |
| **Step 1** | Architecture, AST/IR Specs & Task Plan | **COMPLETE** | `implementation_plan.md` & 18 contract/GC/debugger fixes recorded |
| **M1** | Hello World compiled & running in CLI and Browser | **COMPLETE** | `node bin/lumen.js run examples/hello.lm` (`Hello, World!`, 555B `.wasm`) + Browser Playground verified (`m1_playground_hello.png`) |
| **M2** | Ints, floats, control flow, functions, 50+ tests | PENDING | Waiting for user approval to begin M2 |
| **M3** | Structs, enums, pattern matching, arrays, strings | PENDING | Pending |
| **M4** | Generics, bidirectional type inference, closures | PENDING | Pending |
| **M5** | In-Wasm Garbage Collector, modules & standard library | PENDING | Pending |
| **M6** | IR Optimizer (`-O2`) & 5 benchmarks vs. JS | PENDING | Pending |
| **M7** | Playground Step Debugger & Live GC Visualizer | PENDING | Pending |
| **M8** | 400+ tests, 10-min fuzzer, reference docs, hostile review | PENDING | Pending |

---

## What Works (M1)
- **Shared Contracts (`src/contracts/index.js`)**:
  - Enforces `validateLir(lirModule)` (rejecting unknown `op` names, verifying object-start-relative offsets $\ge 8$, and checking that no unrooted `gc_ref` value sits on the Wasm operand stack across a call or allocation).
  - Exports shared runtime helpers (`LumenRuntimeError`, `formatFloat64`, `truncSatF64ToI32`, `truncSatF64ToI64`, `checkedDivI32`, `checkedRemI32`, `checkedDivI64`, `checkedRemI64`, `fnv1aHashBytes`, `computeMemoryLayout`).
- **Frontend (`src/frontend/*` — Agent A)**:
  - Lexer, Parser (with `RangeExpr` `a..b` and error recovery), Formatter (`lumen fmt`), and Diagnostic Renderer with `line:col`, source snippet, caret underline, and fix suggestions.
- **Type Checker (`src/typechecker/*` — Agent B)**:
  - M1 type checking for `fn main()`, primitive types, string literals, and built-ins (`print`, `println`, etc.).
- **IR Lowering (`src/ir/lower.js` — Agent C)**:
  - Lowers Typed AST to `LirModule`, interns static strings, enforces GC operand stack safety, emits `debug_loc` statements when `debug: true`, and validates via `validateLir()`.
- **Wasm Binary Emitter & Runner (`src/wasm/*` — Agent D)**:
  - Emits raw `.wasm` binary bytes (`555` bytes for `examples/hello.lm`) with dynamic memory layout (`computeMemoryLayout`), UTF-8 pinned string literals (`8B` header at `+0`, `byte_len` at `+8`, UTF-8 bytes at `+12`), and M1 debugger hook support (`env.__lumen_debug_step`).
  - Executes `.wasm` synchronously and asynchronously (`runWasmSync`, `runWasm`) with uniform `"runtime error: <message>"` reporting (`exitCode: 1`).
- **Reference Interpreter (`src/interp/*` — Agent E)**:
  - Executes the AST directly with reference semantics for structs/arrays/strings, UTF-8 byte string operations, shared `formatFloat64`, wraparound/trap integer semantics, and uniform `"runtime error: <message>"` reporting.
- **Browser Playground (`playground/*` — Agent F)**:
  - Zero-dependency HTTP server (`playground/server.js`) with `COOP`/`COEP` headers for `SharedArrayBuffer` + `Atomics.wait`.
  - Compiles and executes `examples/hello.lm` directly in the browser via `WebAssembly.instantiate`, displaying `stdout`, `.wasm` section/hex breakdown, lowered LIR, and Wasm vs. Interpreter parity status.

## What Is Broken / Incomplete
- M2–M8 features (full numeric/control-flow test suite, structs/enums/exhaustiveness, generics/closures, in-Wasm mark-sweep-coalesce GC, optimizer passes, step debugger UI, and fuzzer) are scheduled for Milestones M2–M8 and have not been started yet per strict milestone gating.

## Known Limitations & Uncertainties
- None for M1.
