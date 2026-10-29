# Lumen Architectural & Engineering Decisions (`DECISIONS.md`)

This document records all major technical and architectural decisions made during the construction of the Lumen programming language toolchain.

---

## Decision 1: Host Implementation Language — Zero-Dependency ES Modules (Node.js v24 + Browser)
- **Context**: The toolchain must emit raw `.wasm` binaries from scratch with no LLVM, no wabt, no Binaryen, no parser generators, and no runtime npm dependencies, while also running live inside a browser playground.
- **Decision**: Implement the entire compiler, reference interpreter, optimizer, Wasm emitter, and CLI in standard ES Modules (`.js`) with `"type": "module"` in `package.json`.
- **Test Runner Ownership**: `tests/run_tests.js` and the test suite are owned exclusively by **Agent G**.

---

## Decision 2: Type Inference — Bidirectional Type Checking with Local Unification
- **Context**: Choose between Bidirectional Type Checking and Hindley-Milner (HM) and justify why.
- **Decision**: **Bidirectional Type Checking (`synth` $\Rightarrow$ and `check` $\Leftarrow$) combined with local type-variable unification**.
- **Why**:
  1. **Nominal Structs & Enums**: Supports field access (`point.x`) and constructors without requiring global row polymorphism.
  2. **Higher-Order Closures**: Propagates expected parameter types top-down ($\Leftarrow$) into unannotated closures (`map(xs, |x| x + 1)`).
  3. **Pinpoint Error Diagnostics**: Reports type mismatches at the exact expression span with actionable fix suggestions rather than distant unification failures.

---

## Decision 3: Generics & Compiler-Generated `eq<T>` and `hash<T>` Intrinsics
- **Context**: `HashMap<K, V>` in the standard library must be written in Lumen and work across generic key types.
- **Decision**:
  1. Compile generic functions, structs, and enums via **compile-time monomorphization** in M4.
  2. Provide built-in generic intrinsics `eq<T>(a: T, b: T) -> bool` and `hash<T>(val: T) -> i32`. During monomorphization, the compiler synthesizes specialized `eq$T` and `hash$T` functions for each concrete type `T` (`i32`, `i64`, `f64`, `bool`, `string`, `struct`, `enum`) using structural field comparison and 32-bit FNV-1a hashing.

---

## Decision 4: Identical Runtime Semantics in Interpreter and Compiled Wasm
- **Decision**:
  1. **Reference Types**: Structs, arrays, and strings are **reference types** (`gc_ref`). Assignment and argument passing copy references; in-place mutations to struct fields and array elements are visible across all aliases in both Interpreter and Wasm.
  2. **Strings are UTF-8 Bytes**: Strings are stored as UTF-8 byte sequences in both Wasm linear memory and the Interpreter (`Uint8Array` / `Buffer.from(s, "utf8")`). `str_len`, `str_char_at`, and `str_slice` operate on UTF-8 byte indices and byte lengths.
  3. **Wraparound & Trap Arithmetic**:
     - `+`, `-`, `*`, and unary `-` wrap around in 32-bit (`i32`) and 64-bit (`i64`) two's complement.
     - Integer division/modulo by zero (`a / 0`, `a % 0`) traps with `"runtime error: division by zero"`.
     - Signed division overflow (`INT_MIN / -1`) traps with `"runtime error: integer overflow"`.
     - Shift counts are masked (`b & 31` for `i32`, `b & 63n` for `i64`).
  4. **Float-to-Int Casts**: Use **saturating truncation** (`i32.trunc_sat_f64_s` / `i64.trunc_sat_f64_s` in Wasm; `truncSatF64ToI32` / `truncSatF64ToI64` in Interpreter).
  5. **Float-to-String Formatting**: Both the Interpreter and Wasm call the **same host helper** (`formatFloat64` from `src/contracts/index.js`, imported into Wasm as `env.__lumen_f64_to_str`).
  6. **Array Bounds Checks**: Every array index operation checks `0 <= idx < len` and traps with `"runtime error: index out of bounds"` on failure.
  7. **Uniform Runtime Error Reporting**: Every runtime trap prints `"runtime error: <message>"` and exits with code `1` in both Interpreter and Wasm. The test runner compares `stdout`, `errorText`, and `exitCode`.

---

## Decision 5: Canonical Object Layout (All Offsets Measured from `header = offset 0`)
- **Decision**:
  - Every heap object begins with an 8-byte GC header at offset `0..7` (`[gc_flags: u8, obj_kind: u8, type_desc_id: u16, payload_size: u32]`).
  - All `mem_load`, `mem_store`, and `LirTypeDescriptor.pointerOffsets` offsets are measured from the **object start (`header = offset 0`)**:
    - **Struct**: Field `i` at `8 + 8 * i`.
    - **Enum (Single Layout)**: `variant_tag : i32` at `+8` (padding at `+12..+15`), payload field `i` at `16 + 8 * i`.
    - **Closure**: `fn_table_idx : i32` at `+8`, `env_ptr : gc_ref` at `+12`.
    - **Closure Env**: Captured variable `i` at `8 + 8 * i`.
    - **Box**: Boxed value at `+8`.
    - **String**: UTF-8 `byte_len : u32` at `+8`, UTF-8 bytes at `+12`.

---

## Decision 6: In-Wasm GC Safety Rules, Dynamic Memory Layout & `--gc-stress`
- **Decision**:
  1. **No `gc_ref` on Wasm Operand Stack Across Calls/Allocations**: Lowering binds all `gc_ref` temporaries to local variables (mirrored in the Shadow Stack) before any call or `gc_alloc`. Enforced by `validateLir()`.
  2. **Allocate-Then-Fill**: Field/element values are computed into rooted locals first, followed by `gc_alloc` (which zero-fills the payload), followed immediately by `mem_store` writes with no calls or allocations in between.
  3. **Global Roots Table**: Global `gc_ref` variables are registered in a Global Roots Table scanned by the marker. The marker skips `0` (`null`) and addresses outside `[heapStart, $heap_top)`.
  4. **Dynamic Memory Layout & Separate Worklist with Overflow Rescan**: Memory regions (`staticStrings`, `typeTable`, `globalRoots`, `64 KB markWorklist`, `256 KB shadowStack`, `heapStart`) are computed dynamically from the actual static data size rather than hardcoded `0x3FFF`. Because the 64 KB mark worklist holds ~16,384 pointers, if pushing a marked object overflows the worklist, the marker sets an overflow flag (`$worklist_overflow = 1`); after the worklist empties, the marker rescans the heap (`heapStart .. $heap_top`) for marked objects whose children are still unmarked, repeating until no overflow occurs. Verified in M5 with a 1,000,000-element array test.
  5. **Shadow Stack Overflow Check**: Function prologues check `$shadow_sp > shadowStackEnd` and trap with `"runtime error: stack overflow"`.
  6. **Free-List Rebuild & Post-GC Grow**: Sweep rebuilds free lists from empty each cycle. If allocation still fails after GC, `memory.grow` is invoked.
  7. **`--gc-stress` Mode**: Triggers a full GC cycle on every single allocation. Mandatory for the full test suite from M5 onward.

---

## Decision 7: Step Debugger Pause Mechanism & M1 Emitter Support
- **Context**: The Playground Step Debugger must pause execution at breakpoints and single-step through code while inspecting live variables and the Wasm heap.
- **Decision**: Use a **Web Worker + `SharedArrayBuffer` + `Atomics.wait` / `Atomics.notify`** pause mechanism (with automatic step-trace fallback when `SharedArrayBuffer` is unavailable).
  - **M1 Emitter Support**: Starting in M1, when `debug: true` is passed to `emitWasm`, the emitter imports `env.__lumen_debug_step(line: i32, col: i32, fn_id: i32, shadow_fp: i32)` and emits a call to it for every `{ op: "debug_loc", line, col }` LIR statement, plus exports `debugInfo` mapping function IDs and local variable slots.

---

## Decision 8: M6 Optimizer & Shadow-Stack Root Elision Pass
- **Decision**: In M6, in addition to Function Inlining, Constant Folding, and Dead Code Elimination, add a **Shadow-Stack Root Elision Pass** (`src/ir/opt_roots.js`) that skips shadow-stack frame slots and stores for `gc_ref` locals whose live range does not cross any call or allocation.
- **M6 Gate**: At least 1 benchmark improves by $\ge 15\%$ with `-O2`, no benchmark regresses, and all outputs remain identical.
