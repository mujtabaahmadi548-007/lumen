/**
 * Lumen Milestone 3 — Positive & Runtime Trap Test Suite (`tests/m3_positive_tests.js`)
 * Owned exclusively by Agent G.
 *
 * Covers M3 scope with 100% Wasm <-> Reference Interpreter parity:
 * - Structs: creation, field read/write, aliasing & mutation, nested structs, structs containing array of structs
 * - Enums: unit variants, single payload, multi payload, nested enums, Option (Some/None), Result (Ok/Err)
 * - Pattern Matching: wildcard, literals, boolean guards, guard fallthrough, nested patterns, exhaustiveness
 * - Arrays: empty, single/multi literals, indexing, aliasing & mutation, nested arrays, array_len, array_push, array_pop
 * - Strings: UTF-8 byte semantics, len("é") == 2, slicing mid-character, embedded quotes/escapes, concat, equality
 * - Runtime Traps: OOB array read/write, pop empty array, OOB string slice/char_at
 * - Complex Integration: recursive linked list, binary search tree, multi-level data structures
 * - Formatter: round-trip format & execution equivalence for M3 syntax
 */

export const M3_POSITIVE_TESTS = [
  // ==========================================================================
  // 1. Structs: Creation, Field Access & Mutation
  // ==========================================================================
  {
    name: "struct_basic_instantiation_and_field_reads",
    category: "m3_structs",
    source: `
struct Point {
    x: i32,
    y: i32,
    name: string,
    active: bool,
}

fn main() {
    let p = Point {
        x: 10,
        y: 20,
        name: "origin",
        active: true,
    };
    println(p.x);
    println(p.y);
    println(p.name);
    println(p.active);
}
`,
    expectedStdout: "10\n20\norigin\ntrue\n",
    expectedExitCode: 0,
  },
  {
    name: "struct_field_mutation",
    category: "m3_structs",
    source: `
struct Counter {
    val: i32,
}

fn main() {
    let mut c = Counter { val: 0 };
    println(c.val);
    c.val = 42;
    println(c.val);
    c.val = c.val + 8;
    println(c.val);
}
`,
    expectedStdout: "0\n42\n50\n",
    expectedExitCode: 0,
  },
  {
    name: "struct_aliasing_and_mutation",
    category: "m3_structs",
    source: `
struct BoxVal {
    val: i32,
}

fn main() {
    let a = BoxVal { val: 100 };
    let b = a;
    b.val = 999;
    println(a.val);
    println(b.val);
}
`,
    expectedStdout: "999\n999\n",
    expectedExitCode: 0,
  },
  {
    name: "struct_pass_by_reference_to_function",
    category: "m3_structs",
    source: `
struct Accumulator {
    sum: i32,
}

fn add_to(acc: Accumulator, delta: i32) {
    acc.sum = acc.sum + delta;
}

fn main() {
    let acc = Accumulator { sum: 10 };
    add_to(acc, 25);
    add_to(acc, 15);
    println(acc.sum);
}
`,
    expectedStdout: "50\n",
    expectedExitCode: 0,
  },
  {
    name: "struct_return_from_function",
    category: "m3_structs",
    source: `
struct Vec2 {
    x: i32,
    y: i32,
}

fn make_vec(x: i32, y: i32) -> Vec2 {
    Vec2 { x: x, y: y }
}

fn main() {
    let v = make_vec(7, 14);
    println(v.x);
    println(v.y);
}
`,
    expectedStdout: "7\n14\n",
    expectedExitCode: 0,
  },
  {
    name: "struct_nested_structs",
    category: "m3_structs",
    source: `
struct Inner {
    score: i32,
}

struct Outer {
    id: i32,
    inner: Inner,
}

fn main() {
    let in_obj = Inner { score: 95 };
    let out_obj = Outer { id: 1, inner: in_obj };
    println(out_obj.id);
    println(out_obj.inner.score);
    out_obj.inner.score = 100;
    println(in_obj.score);
}
`,
    expectedStdout: "1\n95\n100\n",
    expectedExitCode: 0,
  },
  {
    name: "struct_containing_array_of_structs",
    category: "m3_structs",
    source: `
struct Item {
    id: i32,
    price: i32,
}

struct Cart {
    items: [Item],
}

fn main() {
    let it1 = Item { id: 1, price: 100 };
    let it2 = Item { id: 2, price: 250 };
    let cart = Cart { items: [it1, it2] };
    println(cart.items[0].price);
    println(cart.items[1].price);
    cart.items[0].price = 120;
    println(it1.price);
}
`,
    expectedStdout: "100\n250\n120\n",
    expectedExitCode: 0,
  },
  {
    name: "struct_with_strings",
    category: "m3_structs",
    source: `
struct User {
    first_name: string,
    last_name: string,
}

fn main() {
    let u = User {
        first_name: "Ada",
        last_name: "Lovelace",
    };
    let full = u.first_name + " " + u.last_name;
    println(full);
}
`,
    expectedStdout: "Ada Lovelace\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 2. Enums: Unit, Single-Payload, Multi-Payload & Nested
  // ==========================================================================
  {
    name: "enum_unit_variants_creation_and_matching",
    category: "m3_enums",
    source: `
enum Color {
    Red,
    Green,
    Blue,
}

fn color_code(c: Color) -> i32 {
    match c {
        Color::Red => 1,
        Color::Green => 2,
        Color::Blue => 3,
    }
}

fn main() {
    println(color_code(Color::Red));
    println(color_code(Color::Green));
    println(color_code(Color::Blue));
}
`,
    expectedStdout: "1\n2\n3\n",
    expectedExitCode: 0,
  },
  {
    name: "enum_single_payload_variants",
    category: "m3_enums",
    source: `
enum Number {
    Int(i32),
    Float(f64),
}

fn print_num(n: Number) {
    match n {
        Number::Int(i) => println(i),
        Number::Float(f) => println(f),
    }
}

fn main() {
    print_num(Number::Int(42));
    print_num(Number::Float(3.14));
}
`,
    expectedStdout: "42\n3.14\n",
    expectedExitCode: 0,
  },
  {
    name: "enum_multi_payload_variants",
    category: "m3_enums",
    source: `
enum Shape {
    Circle(f64),
    Rect(i32, i32),
}

fn area_approx(s: Shape) -> i32 {
    match s {
        Shape::Circle(r) => 314,
        Shape::Rect(w, h) => w * h,
    }
}

fn main() {
    println(area_approx(Shape::Circle(10.0)));
    println(area_approx(Shape::Rect(5, 8)));
}
`,
    expectedStdout: "314\n40\n",
    expectedExitCode: 0,
  },
  {
    name: "enum_nested_enums",
    category: "m3_enums",
    source: `
enum InnerStatus {
    Ready,
    Waiting(i32),
}

enum OuterStatus {
    Active(InnerStatus),
    Inactive,
}

fn inspect(s: OuterStatus) {
    match s {
        OuterStatus::Active(inner) => match inner {
            InnerStatus::Ready => println("active ready"),
            InnerStatus::Waiting(secs) => println(secs),
        },
        OuterStatus::Inactive => println("inactive"),
    }
}

fn main() {
    inspect(OuterStatus::Active(InnerStatus::Ready));
    inspect(OuterStatus::Active(InnerStatus::Waiting(15)));
    inspect(OuterStatus::Inactive);
}
`,
    expectedStdout: "active ready\n15\ninactive\n",
    expectedExitCode: 0,
  },
  {
    name: "enum_option_basic_some_and_none",
    category: "m3_enums",
    source: `
fn describe_opt(opt: Option<i32>) {
    match opt {
        Some(v) => println(v),
        None => println("none"),
    }
}

fn main() {
    describe_opt(Some(42));
    describe_opt(None);
}
`,
    expectedStdout: "42\nnone\n",
    expectedExitCode: 0,
  },
  {
    name: "enum_result_basic_ok_and_err",
    category: "m3_enums",
    source: `
fn safe_div(a: i32, b: i32) -> Result<i32, string> {
    if b == 0 {
        Err("division by zero")
    } else {
        Ok(a / b)
    }
}

fn main() {
    match safe_div(10, 2) {
        Ok(val) => println(val),
        Err(e) => println(e),
    }
    match safe_div(10, 0) {
        Ok(val) => println(val),
        Err(e) => println(e),
    }
}
`,
    expectedStdout: "5\ndivision by zero\n",
    expectedExitCode: 0,
  },
  {
    name: "enum_option_nested",
    category: "m3_enums",
    source: `
fn check_nested(opt: Option<Option<i32>>) {
    match opt {
        Some(inner) => match inner {
            Some(v) => println(v),
            None => println("inner none"),
        },
        None => println("outer none"),
    }
}

fn main() {
    check_nested(Some(Some(99)));
    check_nested(Some(None));
    check_nested(None);
}
`,
    expectedStdout: "99\ninner none\nouter none\n",
    expectedExitCode: 0,
  },
  {
    name: "enum_in_struct_field",
    category: "m3_enums",
    source: `
struct Task {
    id: i32,
    result: Option<i32>,
}

fn main() {
    let t1 = Task { id: 1, result: None };
    let t2 = Task { id: 2, result: Some(100) };
    match t1.result {
        Some(r) => println(r),
        None => println("not finished"),
    }
    match t2.result {
        Some(r) => println(r),
        None => println("not finished"),
    }
}
`,
    expectedStdout: "not finished\n100\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 3. Pattern Matching: Literals, Wildcard, Guards, Expressions
  // ==========================================================================
  {
    name: "match_wildcard_fallback",
    category: "m3_match",
    source: `
fn classify(x: i32) {
    match x {
        1 => println("one"),
        2 => println("two"),
        _ => println("other"),
    }
}

fn main() {
    classify(1);
    classify(2);
    classify(99);
}
`,
    expectedStdout: "one\ntwo\nother\n",
    expectedExitCode: 0,
  },
  {
    name: "match_multiple_literal_patterns",
    category: "m3_match",
    source: `
fn day_name(day: i32) -> string {
    match day {
        1 => "Monday",
        2 => "Tuesday",
        3 => "Wednesday",
        4 => "Thursday",
        5 => "Friday",
        _ => "Weekend",
    }
}

fn main() {
    println(day_name(1));
    println(day_name(3));
    println(day_name(5));
    println(day_name(7));
}
`,
    expectedStdout: "Monday\nWednesday\nFriday\nWeekend\n",
    expectedExitCode: 0,
  },
  {
    name: "match_string_patterns",
    category: "m3_match",
    source: `
fn route(cmd: string) -> i32 {
    match cmd {
        "start" => 1,
        "stop" => 2,
        "pause" => 3,
        _ => 0,
    }
}

fn main() {
    println(route("start"));
    println(route("stop"));
    println(route("pause"));
    println(route("unknown"));
}
`,
    expectedStdout: "1\n2\n3\n0\n",
    expectedExitCode: 0,
  },
  {
    name: "match_bool_patterns",
    category: "m3_match",
    source: `
fn bool_word(b: bool) -> string {
    match b {
        true => "yes",
        false => "no",
    }
}

fn main() {
    println(bool_word(true));
    println(bool_word(false));
}
`,
    expectedStdout: "yes\nno\n",
    expectedExitCode: 0,
  },
  {
    name: "match_with_boolean_guards",
    category: "m3_match",
    source: `
fn sign_check(x: i32) {
    match x {
        n if n > 0 => println("positive"),
        n if n < 0 => println("negative"),
        _ => println("zero"),
    }
}

fn main() {
    sign_check(42);
    sign_check(-10);
    sign_check(0);
}
`,
    expectedStdout: "positive\nnegative\nzero\n",
    expectedExitCode: 0,
  },
  {
    name: "match_guard_falls_through_to_next_arm",
    category: "m3_match",
    source: `
enum Num {
    Val(i32),
}

fn main() {
    let n = Num::Val(5);
    match n {
        Num::Val(x) if x > 10 => println("greater than 10"),
        Num::Val(x) if x == 5 => println("exactly 5"),
        Num::Val(x) => println("other val"),
    }
}
`,
    expectedStdout: "exactly 5\n",
    expectedExitCode: 0,
  },
  {
    name: "match_as_expression_returning_value",
    category: "m3_match",
    source: `
fn main() {
    let x = 3;
    let res = match x {
        1 => 10,
        2 => 20,
        3 => 30,
        _ => 0,
    };
    println(res + 5);
}
`,
    expectedStdout: "35\n",
    expectedExitCode: 0,
  },
  {
    name: "match_nested_pattern_destructuring",
    category: "m3_match",
    source: `
enum PairOpt {
    Pair(Option<i32>, Option<i32>),
}

fn sum_pair(p: PairOpt) -> i32 {
    match p {
        PairOpt::Pair(Some(a), Some(b)) => a + b,
        PairOpt::Pair(Some(a), None) => a,
        PairOpt::Pair(None, Some(b)) => b,
        PairOpt::Pair(None, None) => 0,
    }
}

fn main() {
    println(sum_pair(PairOpt::Pair(Some(10), Some(20))));
    println(sum_pair(PairOpt::Pair(Some(15), None)));
    println(sum_pair(PairOpt::Pair(None, Some(25))));
    println(sum_pair(PairOpt::Pair(None, None)));
}
`,
    expectedStdout: "30\n15\n25\n0\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 4. Dynamic Arrays: Indexing, Aliasing, Growth, Stack Operations
  // ==========================================================================
  {
    name: "array_empty_literal",
    category: "m3_arrays",
    source: `
fn main() {
    let arr: [i32] = [];
    println(array_len(arr));
}
`,
    expectedStdout: "0\n",
    expectedExitCode: 0,
  },
  {
    name: "array_single_and_multi_element_literals",
    category: "m3_arrays",
    source: `
fn main() {
    let single = [42];
    println(single[0]);
    println(array_len(single));

    let triple = [10, 20, 30];
    println(triple[0]);
    println(triple[1]);
    println(triple[2]);
    println(array_len(triple));
}
`,
    expectedStdout: "42\n1\n10\n20\n30\n3\n",
    expectedExitCode: 0,
  },
  {
    name: "array_index_write",
    category: "m3_arrays",
    source: `
fn main() {
    let arr = [1, 2, 3];
    arr[0] = 100;
    arr[2] = 300;
    println(arr[0]);
    println(arr[1]);
    println(arr[2]);
}
`,
    expectedStdout: "100\n2\n300\n",
    expectedExitCode: 0,
  },
  {
    name: "array_aliasing_and_mutation",
    category: "m3_arrays",
    source: `
fn main() {
    let a = [10, 20, 30];
    let b = a;
    b[1] = 999;
    println(a[1]);
    println(b[1]);
}
`,
    expectedStdout: "999\n999\n",
    expectedExitCode: 0,
  },
  {
    name: "array_pass_by_reference_to_function",
    category: "m3_arrays",
    source: `
fn set_first(arr: [i32], val: i32) {
    arr[0] = val;
}

fn main() {
    let data = [5, 6, 7];
    set_first(data, 42);
    println(data[0]);
}
`,
    expectedStdout: "42\n",
    expectedExitCode: 0,
  },
  {
    name: "array_nested_matrix",
    category: "m3_arrays",
    source: `
fn main() {
    let row1 = [1, 2];
    let row2 = [3, 4];
    let matrix = [row1, row2];

    println(matrix[0][0]);
    println(matrix[0][1]);
    println(matrix[1][0]);
    println(matrix[1][1]);

    matrix[0][1] = 99;
    println(row1[1]);
}
`,
    expectedStdout: "1\n2\n3\n4\n99\n",
    expectedExitCode: 0,
  },
  {
    name: "array_builtin_len",
    category: "m3_arrays",
    source: `
fn main() {
    let a: [i32] = [];
    println(array_len(a));
    let b = [1];
    println(array_len(b));
    let c = [1, 2, 3, 4, 5];
    println(array_len(c));
}
`,
    expectedStdout: "0\n1\n5\n",
    expectedExitCode: 0,
  },
  {
    name: "array_builtin_push_and_grow",
    category: "m3_arrays",
    source: `
fn main() {
    let arr: [i32] = [];
    for i in 0..20 {
        array_push(arr, i * 2);
    }
    println(array_len(arr));
    println(arr[0]);
    println(arr[10]);
    println(arr[19]);
}
`,
    expectedStdout: "20\n0\n20\n38\n",
    expectedExitCode: 0,
  },
  {
    name: "array_builtin_pop_elements",
    category: "m3_arrays",
    source: `
fn main() {
    let arr = [10, 20, 30];
    let p3 = array_pop(arr);
    println(p3);
    println(array_len(arr));
    let p2 = array_pop(arr);
    println(p2);
    println(array_len(arr));
    let p1 = array_pop(arr);
    println(p1);
    println(array_len(arr));
}
`,
    expectedStdout: "30\n2\n20\n1\n10\n0\n",
    expectedExitCode: 0,
  },
  {
    name: "array_push_and_pop_interleaved",
    category: "m3_arrays",
    source: `
fn main() {
    let stack: [i32] = [];
    array_push(stack, 1);
    array_push(stack, 2);
    println(array_pop(stack));
    array_push(stack, 3);
    println(array_pop(stack));
    println(array_pop(stack));
    println(array_len(stack));
}
`,
    expectedStdout: "2\n3\n1\n0\n",
    expectedExitCode: 0,
  },
  {
    name: "array_of_strings",
    category: "m3_arrays",
    source: `
fn main() {
    let words = ["hello", "lumen", "wasm"];
    println(words[0]);
    println(words[1]);
    println(words[2]);
    words[1] = "world";
    println(words[1]);
}
`,
    expectedStdout: "hello\nlumen\nwasm\nworld\n",
    expectedExitCode: 0,
  },
  {
    name: "array_of_options",
    category: "m3_arrays",
    source: `
fn main() {
    let opts = [Some(10), None, Some(30)];
    for i in 0..array_len(opts) {
        match opts[i] {
            Some(v) => println(v),
            None => println("none"),
        }
    }
}
`,
    expectedStdout: "10\nnone\n30\n",
    expectedExitCode: 0,
  },
  {
    name: "array_iteration_with_for_loop",
    category: "m3_arrays",
    source: `
fn main() {
    let nums = [3, 7, 12, 18];
    let mut sum = 0;
    for i in 0..array_len(nums) {
        sum = sum + nums[i];
    }
    println(sum);
}
`,
    expectedStdout: "40\n",
    expectedExitCode: 0,
  },
  {
    name: "array_swap_elements",
    category: "m3_arrays",
    source: `
fn swap(arr: [i32], i: i32, j: i32) {
    let tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
}

fn main() {
    let arr = [10, 20];
    swap(arr, 0, 1);
    println(arr[0]);
    println(arr[1]);
}
`,
    expectedStdout: "20\n10\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 5. Strings: UTF-8 Byte Semantics, Mid-Char Slicing, Escapes & Equality
  // ==========================================================================
  {
    name: "string_utf8_multibyte_len",
    category: "m3_strings",
    source: `
fn main() {
    println(str_len("A"));
    println(str_len("é"));
    println(str_len("你好"));
}
`,
    expectedStdout: "1\n2\n6\n",
    expectedExitCode: 0,
  },
  {
    name: "string_utf8_slicing_mid_char",
    category: "m3_strings",
    source: `
fn main() {
    let s = "é";
    let slice = str_slice(s, 0, 1);
    println(str_len(slice));
    println(str_char_at(slice, 0));
}
`,
    expectedStdout: "1\n195\n",
    expectedExitCode: 0,
  },
  {
    name: "string_slicing_normal",
    category: "m3_strings",
    source: `
fn main() {
    let s = "Hello World";
    println(str_slice(s, 0, 5));
    println(str_slice(s, 6, 11));
}
`,
    expectedStdout: "Hello\nWorld\n",
    expectedExitCode: 0,
  },
  {
    name: "string_embedded_quotes_and_escapes",
    category: "m3_strings",
    source: `
fn main() {
    let s = "quote: \\\" hello\\nworld \\\\";
    println(str_len(s));
    println(str_char_at(s, 7));
}
`,
    expectedStdout: "22\n34\n",
    expectedExitCode: 0,
  },
  {
    name: "string_concat_and_chaining",
    category: "m3_strings",
    source: `
fn main() {
    let a = "foo";
    let b = "bar";
    let c = "baz";
    let res = a + "-" + b + "-" + c;
    println(res);
}
`,
    expectedStdout: "foo-bar-baz\n",
    expectedExitCode: 0,
  },
  {
    name: "string_equality_checks",
    category: "m3_strings",
    source: `
fn main() {
    let s1 = "lumen";
    let s2 = "lu" + "men";
    let s3 = "other";
    println(str_eq(s1, s2));
    println(str_eq(s1, s3));
}
`,
    expectedStdout: "true\nfalse\n",
    expectedExitCode: 0,
  },
  {
    name: "string_char_at_byte_access",
    category: "m3_strings",
    source: `
fn main() {
    let s = "ABC";
    println(str_char_at(s, 0));
    println(str_char_at(s, 1));
    println(str_char_at(s, 2));
}
`,
    expectedStdout: "65\n66\n67\n",
    expectedExitCode: 0,
  },
  {
    name: "string_from_char_code",
    category: "m3_strings",
    source: `
fn main() {
    let a = str_from_char_code(65);
    let b = str_from_char_code(66);
    println(a + b);
}
`,
    expectedStdout: "AB\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 6. Runtime Traps: Arrays & Strings Bounds & Pop
  // ==========================================================================
  {
    name: "trap_array_oob_read_past_length",
    category: "m3_traps",
    source: `
fn main() {
    let arr = [1, 2, 3];
    let x = arr[3];
}
`,
    expectedErrorText: "runtime error: index out of bounds",
    expectedExitCode: 1,
  },
  {
    name: "trap_array_oob_read_negative",
    category: "m3_traps",
    source: `
fn main() {
    let arr = [1, 2, 3];
    let x = arr[-1];
}
`,
    expectedErrorText: "runtime error: index out of bounds",
    expectedExitCode: 1,
  },
  {
    name: "trap_array_oob_write_past_length",
    category: "m3_traps",
    source: `
fn main() {
    let arr = [1, 2, 3];
    arr[5] = 99;
}
`,
    expectedErrorText: "runtime error: index out of bounds",
    expectedExitCode: 1,
  },
  {
    name: "trap_array_oob_write_negative",
    category: "m3_traps",
    source: `
fn main() {
    let arr = [1, 2, 3];
    arr[-2] = 99;
}
`,
    expectedErrorText: "runtime error: index out of bounds",
    expectedExitCode: 1,
  },
  {
    name: "trap_array_pop_empty",
    category: "m3_traps",
    source: `
fn main() {
    let arr: [i32] = [];
    let x = array_pop(arr);
}
`,
    expectedErrorText: "runtime error: pop from empty array",
    expectedExitCode: 1,
  },
  {
    name: "trap_string_slice_oob_end",
    category: "m3_traps",
    source: `
fn main() {
    let s = "hello";
    let sub = str_slice(s, 0, 10);
}
`,
    expectedErrorText: "runtime error: index out of bounds",
    expectedExitCode: 1,
  },
  {
    name: "trap_string_slice_negative_start",
    category: "m3_traps",
    source: `
fn main() {
    let s = "hello";
    let sub = str_slice(s, -1, 3);
}
`,
    expectedErrorText: "runtime error: index out of bounds",
    expectedExitCode: 1,
  },
  {
    name: "trap_string_char_at_oob",
    category: "m3_traps",
    source: `
fn main() {
    let s = "hi";
    let c = str_char_at(s, 5);
}
`,
    expectedErrorText: "runtime error: index out of bounds",
    expectedExitCode: 1,
  },

  // ==========================================================================
  // 7. Comprehensive Integration: Data Structures & Algorithms
  // ==========================================================================
  {
    name: "integration_linked_list_via_enum",
    category: "m3_integration",
    source: `
enum List {
    Nil,
    Cons(i32, List),
}

fn sum_list(list: List) -> i32 {
    match list {
        List::Nil => 0,
        List::Cons(head, tail) => head + sum_list(tail),
    }
}

fn main() {
    let list = List::Cons(10, List::Cons(20, List::Cons(30, List::Nil)));
    println(sum_list(list));
}
`,
    expectedStdout: "60\n",
    expectedExitCode: 0,
  },
  {
    name: "integration_binary_search_tree_via_enum",
    category: "m3_integration",
    source: `
enum Tree {
    Leaf,
    Node(i32, Tree, Tree),
}

fn contains(t: Tree, val: i32) -> bool {
    match t {
        Tree::Leaf => false,
        Tree::Node(v, left, right) => {
            if v == val {
                true
            } else if val < v {
                contains(left, val)
            } else {
                contains(right, val)
            }
        },
    }
}

fn main() {
    let bst = Tree::Node(
        10,
        Tree::Node(5, Tree::Leaf, Tree::Leaf),
        Tree::Node(15, Tree::Leaf, Tree::Leaf),
    );
    println(contains(bst, 5));
    println(contains(bst, 10));
    println(contains(bst, 15));
    println(contains(bst, 7));
}
`,
    expectedStdout: "true\ntrue\ntrue\nfalse\n",
    expectedExitCode: 0,
  },
  {
    name: "integration_struct_containing_array_of_structs_complex",
    category: "m3_integration",
    source: `
struct InventoryItem {
    id: i32,
    quantity: i32,
    unit_price: i32,
}

struct Warehouse {
    items: [InventoryItem],
}

fn total_value(wh: Warehouse) -> i32 {
    let mut total = 0;
    for i in 0..array_len(wh.items) {
        total = total + wh.items[i].quantity * wh.items[i].unit_price;
    }
    total
}

fn main() {
    let it1 = InventoryItem { id: 1, quantity: 10, unit_price: 5 };
    let it2 = InventoryItem { id: 2, quantity: 4, unit_price: 25 };
    let it3 = InventoryItem { id: 3, quantity: 2, unit_price: 100 };
    let wh = Warehouse { items: [it1, it2, it3] };
    println(total_value(wh));
}
`,
    expectedStdout: "350\n",
    expectedExitCode: 0,
  },
  {
    name: "integration_lumen_fmt_m3",
    category: "m3_integration",
    source: `
struct Point {
    x: i32,
    y: i32,
}

enum State {
    On(i32),
    Off,
}

fn eval(st: State) -> i32 {
    match st {
        State::On(v) => v * 2,
        State::Off => 0,
    }
}

fn main() {
    let p = Point { x: 3, y: 7 };
    let st = State::On(p.x + p.y);
    println(eval(st));
}
`,
    expectedStdout: "20\n",
    expectedExitCode: 0,
    checkFmtRoundTrip: true,
  },
];
