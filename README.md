# Lumen

Lumen is a statically typed programming language designed and implemented entirely from scratch that compiles directly to raw WebAssembly binary (`.wasm`) bytes. It runs 100% offline with zero external parser generators, zero runtime npm dependencies, and no LLVM, Binaryen, or wabt.

The toolchain includes a command-line interface (`build`, `run`, `test`, `fmt`), an independent reference interpreter verifying runtime semantics against compiled WebAssembly, and a standalone browser playground.

---

## Code Example

```lumen
struct Point {
    x: i32,
    y: i32
}

enum Shape {
    Circle(i32),
    Rectangle(Point, Point)
}

fn area_metric(s: Shape) -> i32 {
    match s {
        Shape::Circle(r) => 3 * r * r,
        Shape::Rectangle(p1, p2) => {
            let width = p2.x - p1.x;
            let height = p2.y - p1.y;
            width * height
        }
    }
}

fn main() {
    let origin = Point { x: 0, y: 0 };
    let corner = Point { x: 10, y: 20 };
    let rect = Shape::Rectangle(origin, corner);

    println(area_metric(rect)); // 200

    let mut numbers = [10, 20, 30];
    array_push(numbers, 40);
    println(numbers[3]); // 40

    let msg = "Hello from Lumen!";
    println(msg);
}
```

---

## How to Build, Run, Test, and Format

All commands run via the root CLI (`bin/lumen.js`):

### 1. Run a Program
Compiles source code to WebAssembly in memory and executes it immediately via the V8 Wasm runtime:
```bash
node bin/lumen.js run examples/hello.lm
```

To run with the independent Reference Interpreter instead:
```bash
node bin/lumen.js run examples/hello.lm --interp
```

### 2. Build WebAssembly Binary (`.wasm`)
Compiles source directly to a standalone `.wasm` file:
```bash
node bin/lumen.js build examples/hello.lm -o hello.wasm
```

### 3. Run the Test Suite
Executes the comprehensive parity test runner comparing Wasm execution vs. the Reference Interpreter:
```bash
node bin/lumen.js test
```

### 4. Format Source Code (`lumen fmt`)
Formats Lumen source files according to language canonical style:
```bash
node bin/lumen.js fmt examples/hello.lm
```

### 5. Browser Playground
A browser playground is available in `playground/`:
```bash
# Serve locally using any static web server, or open playground/index.html in a browser
npx serve playground
```

---

## Architecture

Lumen's compiler pipeline processes source code through six distinct phases without external dependencies:
1. **Lexer** (`src/frontend/lexer.js`): Tokenizes UTF-8 source into a lossless token stream, tracking source spans (line, column, byte offsets).
2. **Parser** (`src/frontend/parser.js`): A Pratt-parsing recursive descent parser with error recovery that produces an Abstract Syntax Tree (AST) even in the presence of syntax errors.
3. **Type Checker & Exhaustiveness** (`src/typechecker/`): Scopes symbols, verifies type compatibility, infers local bindings, and executes Maranget's usefulness algorithm on `match` expressions to ensure exhaustiveness and detect unreachable arms.
4. **LIR Lowering** (`src/ir/lower.js`): Lowers typed AST into a Linear Intermediate Representation (LIR). Enforces GC stack safety invariants (no unrooted references on the operand stack across calls or allocations) and validates LIR via `validateLir()`.
5. **Raw Wasm Emitter** (`src/wasm/emitter.js`): Emits valid WebAssembly binary modules byte-by-byte (type, import, function, table, memory, global, export, element, code, and data sections) adhering to the WebAssembly Core Specification.
6. **Execution & Dual-Engine Parity**: Executes compiled `.wasm` modules with host runtime imports (`print`, `println`, `float_to_string`, panic traps) while verifying exact parity against an independent AST Reference Interpreter (`src/interp/interpreter.js`).

---

## Status and Known Limitations

The Lumen toolchain is currently complete through **Milestone 3 (M3)**.

### What Is Built and Complete (M1 – M3)
- **Primitive Types**: `i32`, `i64`, `f64`, `bool`.
- **Operators & Precedence**: Full arithmetic, relational, bitwise, and short-circuit logical operators. Wraparound semantics on arithmetic overflow, masked bit shifts, and saturating float-to-int casts.
- **Runtime Traps & Error Handling**: Explicit runtime error messages (`"runtime error: <message>"`) with exit code 1 for division by zero, remainder by zero, integer min division overflow, array out-of-bounds, pop from empty array, and assertion failures across both Wasm and interpreter.
- **Control Flow**: `let`, `let mut`, compound assignments, `if`/`else` expressions and statements, `while`, `for` ranges (`a..b`), `break`, `continue`, `return`, and deep recursion.
- **Data Structures**:
  - **Structs**: Instantiation, field access, field mutation, aliasing with reference semantics, nested structs, and structs containing arrays of structs.
  - **Enums with Data**: Unit variants, single-payload, and multi-payload variants with fixed memory layout (tag at offset `+8`, payload fields starting at `+16`).
  - **Option & Result**: Built-in algebraic data types `Option<T>` (`Some`, `None`) and `Result<T, E>` (`Ok`, `Err`).
  - **Dynamic Arrays**: Array literals, indexing read/write, explicit bounds checks, in-place reference mutation, `array_len`, `array_push`, and `array_pop`.
  - **UTF-8 Strings**: String concatenation (`+`), equality (`==`), length in UTF-8 bytes (`str_len`), byte-level slicing (`str_slice`), `str_char_at`, and `str_from_char_code`.
- **Pattern Matching**: Nested pattern destructuring with Maranget exhaustiveness checking (`E0301`) and redundancy analysis (`E0302`). Guarded match arms (`pat if cond`) do not count toward exhaustiveness.
- **Diagnostics**: Rich error reporting with line, column, source code caret snippets, and actionable fix suggestions covering 100% of defined error codes.

### What Is Not Built
The following components are beyond the scope of Milestones 1–3 and are not built:
- **Generics**: Generic functions, structs, and enums (`<T, U>`) and monomorphization are not built.
- **Closures**: Closures (`|x| ...`), lambda expressions, variable capturing, and first-class function values are not built.
- **Garbage Collector**: The mark-and-sweep garbage collector is not built. Heap allocations use a bump allocator in WebAssembly linear memory; **allocated memory is never freed**.
- **Optimizer**: IR optimizations (`-O2`, constant folding, dead code elimination, function inlining) are not built.
- **Debugger**: Interactive step debugging (breakpoints, variable inspection) and live GC visualizer in the playground are not built.
- **Modules & Imports**: Multi-file module resolution and standard library packages written in Lumen are not built.
