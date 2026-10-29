/**
 * Lumen Milestone 3 — Negative Tests Suite (`tests/m3_negative_tests.js`)
 * Owned exclusively by Agent G.
 *
 * Covers M3 ErrorCodes and Safety Checks:
 * - Parser: E0105 (PARSE_EXPECTED_PATTERN)
 * - Type Checker:
 *   - E0207 (TYPE_UNKNOWN_FIELD)
 *   - E0208 (TYPE_MISSING_FIELD)
 *   - E0209 (TYPE_DUPLICATE_FIELD)
 *   - E0210 (TYPE_UNKNOWN_VARIANT)
 *   - E0211 (TYPE_NOT_INDEXABLE)
 *   - E0212 (TYPE_INDEX_NOT_INT)
 * - Pattern Matching & Exhaustiveness:
 *   - E0301 (MATCH_NON_EXHAUSTIVE) - missing enum variant
 *   - E0301 (MATCH_NON_EXHAUSTIVE) - guarded arm with no fallback arm
 *   - E0302 (MATCH_REDUNDANT_ARM) - unreachable arm after wildcard
 *   - E0302 (MATCH_REDUNDANT_ARM) - duplicate pattern arm
 *   - E0303 (MATCH_PATTERN_ARITY) - wrong number of pattern arguments
 */

export const M3_NEGATIVE_TESTS = [
  // ==========================================================================
  // 1. Parser Error: E0105 (PARSE_EXPECTED_PATTERN)
  // ==========================================================================
  {
    name: "parse_expected_pattern_e0105",
    expectedCode: "E0105",
    source: `
fn main() {
    let x = 1;
    match x {
        => println(0),
        _ => println(1),
    }
}
`,
  },

  // ==========================================================================
  // 2. Struct Negative Errors (E0207, E0208, E0209)
  // ==========================================================================
  {
    name: "type_unknown_field_access_e0207",
    expectedCode: "E0207",
    source: `
struct Point {
    x: i32,
    y: i32,
}

fn main() {
    let p = Point { x: 10, y: 20 };
    let z = p.z;
}
`,
  },
  {
    name: "type_unknown_field_literal_e0207",
    expectedCode: "E0207",
    source: `
struct Point {
    x: i32,
    y: i32,
}

fn main() {
    let p = Point { x: 10, y: 20, z: 30 };
}
`,
  },
  {
    name: "type_missing_field_literal_e0208",
    expectedCode: "E0208",
    source: `
struct Point {
    x: i32,
    y: i32,
}

fn main() {
    let p = Point { x: 10 };
}
`,
  },
  {
    name: "type_duplicate_field_literal_e0209",
    expectedCode: "E0209",
    source: `
struct Point {
    x: i32,
    y: i32,
}

fn main() {
    let p = Point { x: 10, y: 20, x: 30 };
}
`,
  },

  // ==========================================================================
  // 3. Enum Negative Errors (E0210)
  // ==========================================================================
  {
    name: "type_unknown_variant_e0210",
    expectedCode: "E0210",
    source: `
enum Color {
    Red,
    Green,
    Blue,
}

fn main() {
    let c = Color::Yellow;
}
`,
  },

  // ==========================================================================
  // 4. Array Negative Errors (E0211, E0212)
  // ==========================================================================
  {
    name: "type_not_indexable_e0211",
    expectedCode: "E0211",
    source: `
fn main() {
    let num = 42;
    let elem = num[0];
}
`,
  },
  {
    name: "type_index_not_int_e0212",
    expectedCode: "E0212",
    source: `
fn main() {
    let arr = [1, 2, 3];
    let elem = arr[true];
}
`,
  },

  // ==========================================================================
  // 5. Pattern Matching & Maranget Exhaustiveness Errors (E0301, E0302, E0303)
  // ==========================================================================
  {
    name: "match_non_exhaustive_missing_variant_e0301",
    expectedCode: "E0301",
    source: `
enum Status {
    Open,
    InProgress,
    Closed,
}

fn main() {
    let s = Status::Open;
    match s {
        Status::Open => println(1),
        Status::Closed => println(2),
    }
}
`,
  },
  {
    name: "match_guarded_arm_without_fallback_e0301",
    expectedCode: "E0301",
    source: `
enum OptionI32 {
    Some(i32),
    None,
}

fn main() {
    let opt = OptionI32::Some(42);
    match opt {
        OptionI32::Some(x) if x > 0 => println(x),
        OptionI32::None => println(0),
    }
}
`,
  },
  {
    name: "match_redundant_arm_after_wildcard_e0302",
    expectedCode: "E0302",
    source: `
enum Status {
    Open,
    Closed,
}

fn main() {
    let s = Status::Open;
    match s {
        _ => println(1),
        Status::Closed => println(2),
    }
}
`,
  },
  {
    name: "match_redundant_arm_duplicate_variant_e0302",
    expectedCode: "E0302",
    source: `
enum Status {
    Open,
    Closed,
}

fn main() {
    let s = Status::Open;
    match s {
        Status::Open => println(1),
        Status::Closed => println(2),
        Status::Open => println(3),
    }
}
`,
  },
  {
    name: "match_pattern_arity_mismatch_e0303",
    expectedCode: "E0303",
    source: `
enum OptionI32 {
    Some(i32),
    None,
}

fn main() {
    let opt = OptionI32::Some(42);
    match opt {
        OptionI32::Some(a, b) => println(a),
        OptionI32::None => println(0),
    }
}
`,
  },
];
