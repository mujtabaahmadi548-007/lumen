/**
 * Lumen Milestone 2 — Positive & Runtime Trap Test Suite (`tests/m2_positive_tests.js`)
 * Owned exclusively by Agent G.
 *
 * Covers >= 55 M2 programs verified for 100% Wasm <-> Reference Interpreter parity:
 * 1. i32 overflow wrap (2147483647 + 1, -2147483648 - 1, 100000 * 100000, -(-2147483648))
 * 2. i64 overflow wrap (9223372036854775807i64 + 1i64, -9223372036854775808i64 - 1i64, mul wrap)
 * 3. f64 NaN and +-Inf to i32 / i64 saturating casts
 * 4. Divide by zero & modulo by zero traps (i32 and i64)
 * 5. INT_MIN / -1 overflow traps (i32 and i64) & INT_MIN % -1 == 0 non-traps
 * 6. Masked bit shifts (shift by 33 for i32, shift by 65 for i64)
 * 7. Operator precedence, associativity, and short-circuit logical && / ||
 * 8. Control flow (if/else if/else, while, for i in a..b, break, continue, let mut, shadowing)
 * 9. Deep recursion (fib(20), mutual recursion to 50, Ackermann(3, 4), gcd, factorial)
 * 10. `lumen fmt` round-trip formatting & execution equivalence
 */

export const M2_POSITIVE_TESTS = [
  // ==========================================================================
  // 1. i32 Overflow Wraparound (Two's Complement 32-bit Signed Math)
  // ==========================================================================
  {
    name: "i32_overflow_add_max_plus_one",
    category: "m2_overflow_i32",
    source: `
fn main() {
    let max_i32: i32 = 2147483647;
    let wrapped: i32 = max_i32 + 1;
    println(wrapped);
}
`,
    expectedStdout: "-2147483648\n",
    expectedExitCode: 0,
  },
  {
    name: "i32_overflow_sub_min_minus_one",
    category: "m2_overflow_i32",
    source: `
fn main() {
    let min_i32: i32 = -2147483647 - 1;
    let wrapped1: i32 = min_i32 - 1;
    let wrapped2: i32 = -2147483648 - 1;
    println(wrapped1);
    println(wrapped2);
}
`,
    expectedStdout: "2147483647\n2147483647\n",
    expectedExitCode: 0,
  },
  {
    name: "i32_overflow_mul_wrap",
    category: "m2_overflow_i32",
    source: `
fn main() {
    let a: i32 = 100000;
    let b: i32 = 100000;
    println(a * b);
    let c: i32 = 65536;
    println(c * c);
}
`,
    expectedStdout: "1410065408\n0\n",
    expectedExitCode: 0,
  },
  {
    name: "i32_overflow_unary_neg_min",
    category: "m2_overflow_i32",
    source: `
fn main() {
    let min_i32: i32 = -2147483648;
    let neg_min: i32 = -min_i32;
    println(neg_min);
    println(-(-2147483648));
}
`,
    expectedStdout: "-2147483648\n-2147483648\n",
    expectedExitCode: 0,
  },
  {
    name: "i32_compound_assign_overflow_wrap",
    category: "m2_overflow_i32",
    source: `
fn main() {
    let mut x: i32 = 2147483647;
    x += 2;
    println(x);
    x -= 2;
    println(x);
}
`,
    expectedStdout: "-2147483647\n2147483647\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 2. i64 Overflow Wraparound (Two's Complement 64-bit Signed Math)
  // ==========================================================================
  {
    name: "i64_overflow_add_max_plus_one",
    category: "m2_overflow_i64",
    source: `
fn main() {
    let max_i64: i64 = 9223372036854775807i64;
    let wrapped: i64 = max_i64 + 1i64;
    println(wrapped);
}
`,
    expectedStdout: "-9223372036854775808\n",
    expectedExitCode: 0,
  },
  {
    name: "i64_overflow_sub_min_minus_one",
    category: "m2_overflow_i64",
    source: `
fn main() {
    let min_i64: i64 = -9223372036854775807i64 - 1i64;
    let wrapped1: i64 = min_i64 - 1i64;
    let wrapped2: i64 = -9223372036854775808i64 - 1i64;
    println(wrapped1);
    println(wrapped2);
}
`,
    expectedStdout: "9223372036854775807\n9223372036854775807\n",
    expectedExitCode: 0,
  },
  {
    name: "i64_overflow_mul_wrap",
    category: "m2_overflow_i64",
    source: `
fn main() {
    let a: i64 = 3037000500i64;
    let b: i64 = 3037000500i64;
    println(a * b);
}
`,
    expectedStdout: "-9223372036709301616\n",
    expectedExitCode: 0,
  },
  {
    name: "i64_overflow_unary_neg_min",
    category: "m2_overflow_i64",
    source: `
fn main() {
    let min_i64: i64 = -9223372036854775807i64 - 1i64;
    println(-min_i64);
}
`,
    expectedStdout: "-9223372036854775808\n",
    expectedExitCode: 0,
  },
  {
    name: "i64_arithmetic_and_comparisons",
    category: "m2_overflow_i64",
    source: `
fn main() {
    let a: i64 = 100L;
    let b: i64 = 25i64;
    println(a + b);
    println(a - b);
    println(a * b);
    println(a / b);
    println(a % b);
    println(bool_to_string(a > b));
    println(bool_to_string(a == 100i64));
}
`,
    expectedStdout: "125\n75\n2500\n4\n0\ntrue\ntrue\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 3. f64 NaN & Infinity to i32 / i64 Saturating Casts (`as`)
  // ==========================================================================
  {
    name: "cast_f64_nan_to_i32",
    category: "m2_saturating_casts",
    source: `
fn main() {
    let z: f64 = 0.0;
    let nan: f64 = z / z;
    let x: i32 = nan as i32;
    println(x);
}
`,
    expectedStdout: "0\n",
    expectedExitCode: 0,
  },
  {
    name: "cast_f64_pos_inf_to_i32",
    category: "m2_saturating_casts",
    source: `
fn main() {
    let z: f64 = 0.0;
    let pos_inf: f64 = 1.0 / z;
    let x: i32 = pos_inf as i32;
    println(x);
}
`,
    expectedStdout: "2147483647\n",
    expectedExitCode: 0,
  },
  {
    name: "cast_f64_neg_inf_to_i32",
    category: "m2_saturating_casts",
    source: `
fn main() {
    let z: f64 = 0.0;
    let neg_inf: f64 = -1.0 / z;
    let x: i32 = neg_inf as i32;
    println(x);
}
`,
    expectedStdout: "-2147483648\n",
    expectedExitCode: 0,
  },
  {
    name: "cast_f64_huge_to_i32_saturates",
    category: "m2_saturating_casts",
    source: `
fn main() {
    let big_pos: i32 = 1e30 as i32;
    let big_neg: i32 = (-1e30) as i32;
    println(big_pos);
    println(big_neg);
}
`,
    expectedStdout: "2147483647\n-2147483648\n",
    expectedExitCode: 0,
  },
  {
    name: "cast_f64_nan_and_inf_to_i64",
    category: "m2_saturating_casts",
    source: `
fn main() {
    let z: f64 = 0.0;
    let nan: f64 = z / z;
    let pos_inf: f64 = 1.0 / z;
    let neg_inf: f64 = -1.0 / z;
    println(nan as i64);
    println(pos_inf as i64);
    println(neg_inf as i64);
}
`,
    expectedStdout: "0\n9223372036854775807\n-9223372036854775808\n",
    expectedExitCode: 0,
  },
  {
    name: "cast_numeric_and_bool_conversions",
    category: "m2_saturating_casts",
    source: `
fn main() {
    println((-42.9) as i32);
    println(42 as f64);
    println((-7) as i64);
    println(4294967297i64 as i32);
    println(true as i32);
    println(false as i32);
    println(true as i64);
}
`,
    expectedStdout: "-42\n42\n-7\n1\n1\n0\n1\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 4. Divide by Zero & Modulo by Zero Traps (i32 and i64)
  // ==========================================================================
  {
    name: "trap_i32_div_by_zero",
    category: "m2_traps",
    cliTrapTest: true,
    source: `
fn main() {
    let a: i32 = 10;
    let b: i32 = 0;
    println(a / b);
}
`,
    expectedExitCode: 1,
    expectedErrorText: "runtime error: division by zero",
  },
  {
    name: "trap_i32_rem_by_zero",
    category: "m2_traps",
    source: `
fn main() {
    let a: i32 = 10;
    let b: i32 = 0;
    println(a % b);
}
`,
    expectedExitCode: 1,
    expectedErrorText: "runtime error: division by zero",
  },
  {
    name: "trap_i64_div_by_zero",
    category: "m2_traps",
    source: `
fn main() {
    let a: i64 = 10i64;
    let b: i64 = 0i64;
    println(a / b);
}
`,
    expectedExitCode: 1,
    expectedErrorText: "runtime error: division by zero",
  },
  {
    name: "trap_i64_rem_by_zero",
    category: "m2_traps",
    source: `
fn main() {
    let a: i64 = 10i64;
    let b: i64 = 0i64;
    println(a % b);
}
`,
    expectedExitCode: 1,
    expectedErrorText: "runtime error: division by zero",
  },

  // ==========================================================================
  // 5. INT_MIN / -1 Traps & INT_MIN % -1 Non-Traps (i32 and i64)
  // ==========================================================================
  {
    name: "trap_i32_int_min_div_neg_one",
    category: "m2_traps",
    source: `
fn main() {
    let min_val: i32 = -2147483647 - 1;
    let neg_one: i32 = -1;
    println(min_val / neg_one);
}
`,
    expectedExitCode: 1,
    expectedErrorText: "runtime error: integer overflow",
  },
  {
    name: "trap_i64_int_min_div_neg_one",
    category: "m2_traps",
    source: `
fn main() {
    let min_val: i64 = -9223372036854775807i64 - 1i64;
    let neg_one: i64 = -1i64;
    println(min_val / neg_one);
}
`,
    expectedExitCode: 1,
    expectedErrorText: "runtime error: integer overflow",
  },
  {
    name: "nontrap_i32_int_min_rem_neg_one",
    category: "m2_traps",
    source: `
fn main() {
    let min_val: i32 = -2147483647 - 1;
    let neg_one: i32 = -1;
    println(min_val % neg_one);
}
`,
    expectedStdout: "0\n",
    expectedExitCode: 0,
  },
  {
    name: "nontrap_i64_int_min_rem_neg_one",
    category: "m2_traps",
    source: `
fn main() {
    let min_val: i64 = -9223372036854775807i64 - 1i64;
    let neg_one: i64 = -1i64;
    println(min_val % neg_one);
}
`,
    expectedStdout: "0\n",
    expectedExitCode: 0,
  },
  {
    name: "trap_assert_failure",
    category: "m2_traps",
    source: `
fn main() {
    assert(2 + 2 == 4);
    assert(10 < 5);
}
`,
    expectedExitCode: 1,
    expectedErrorText: "runtime error: assertion failed",
  },
  {
    name: "trap_panic_explicit",
    category: "m2_traps",
    source: `
fn main() {
    panic("unreachable state reached");
}
`,
    expectedExitCode: 1,
    expectedErrorText: "runtime error: unreachable state reached",
  },

  // ==========================================================================
  // 6. Masked Shifts (Shift by 33 for i32, Shift by 65 for i64) & Bitwise Ops
  // ==========================================================================
  {
    name: "i32_masked_shifts_by_33",
    category: "m2_shifts",
    source: `
fn main() {
    println(1 << 33);
    println(16 >> 33);
    println((-16) >> 33);
    println(1 << 32);
}
`,
    expectedStdout: "2\n8\n-8\n1\n",
    expectedExitCode: 0,
  },
  {
    name: "i64_masked_shifts_by_65",
    category: "m2_shifts",
    source: `
fn main() {
    println(1i64 << 65i64);
    println(32i64 >> 65i64);
    println((-32i64) >> 65i64);
    println(1i64 << 64i64);
}
`,
    expectedStdout: "2\n16\n-16\n1\n",
    expectedExitCode: 0,
  },
  {
    name: "i32_bitwise_and_or_xor_not",
    category: "m2_shifts",
    source: `
fn main() {
    println(0b1100 & 0b1010);
    println(0b1100 | 0b1010);
    println(0b1100 ^ 0b1010);
    println(~0);
    println(~(-1));
}
`,
    expectedStdout: "8\n14\n6\n-1\n0\n",
    expectedExitCode: 0,
  },
  {
    name: "i64_bitwise_and_or_xor_not",
    category: "m2_shifts",
    source: `
fn main() {
    println(0xFF00i64 & 0x0FF0i64);
    println(0xFF00i64 | 0x00FFi64);
    println(0xFF00i64 ^ 0xFFFFi64);
    println(~0i64);
}
`,
    expectedStdout: "3840\n65535\n255\n-1\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 7. Operator Precedence, Associativity & Short-Circuit Evaluation
  // ==========================================================================
  {
    name: "precedence_arithmetic_mul_div_mod_add_sub",
    category: "m2_precedence",
    source: `
fn main() {
    println(1 + 2 * 3 - 4 / 2);
    println((1 + 2) * (3 - 4));
    println(17 % 5 + 2 * 3);
}
`,
    expectedStdout: "5\n-3\n8\n",
    expectedExitCode: 0,
  },
  {
    name: "associativity_left_sub_div_mod",
    category: "m2_precedence",
    source: `
fn main() {
    println(20 - 5 - 3);
    println(100 / 10 / 2);
    println(25 % 7 % 3);
}
`,
    expectedStdout: "12\n5\n1\n",
    expectedExitCode: 0,
  },
  {
    name: "precedence_unary_vs_binary",
    category: "m2_precedence",
    source: `
fn main() {
    println(-3 + 5);
    println(10 + -4 * 2);
    println(-2 * -3 + -1);
    println(~0 + 5);
}
`,
    expectedStdout: "2\n2\n5\n4\n",
    expectedExitCode: 0,
  },
  {
    name: "precedence_bitwise_shifts_and_comparisons",
    category: "m2_precedence",
    source: `
fn main() {
    println(1 << 2 + 1);
    println(6 | 1 ^ 3 & 7);
    println(bool_to_string(5 & 3 == 1));
    println(bool_to_string(1 + 2 < 2 * 2));
}
`,
    expectedStdout: "8\n6\ntrue\ntrue\n",
    expectedExitCode: 0,
  },
  {
    name: "short_circuit_logical_and_or",
    category: "m2_precedence",
    source: `
fn loud_true() -> bool {
    println("evaluated_rhs");
    return true;
}

fn main() {
    let z: i32 = 0;
    let a: bool = false && loud_true();
    println(bool_to_string(a));
    let b: bool = true || loud_true();
    println(bool_to_string(b));
    let safe_and: bool = false && (10 / z == 1);
    let safe_or: bool = true || (10 / z == 1);
    println(bool_to_string(safe_and));
    println(bool_to_string(safe_or));
    let c: bool = true && loud_true();
    println(bool_to_string(c));
    let d: bool = false || loud_true();
    println(bool_to_string(d));
    let prec: bool = true || false && false;
    println(bool_to_string(prec));
}
`,
    expectedStdout:
      "false\ntrue\nfalse\ntrue\nevaluated_rhs\ntrue\nevaluated_rhs\ntrue\ntrue\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 8. Control Flow (if/else, while, for..in, break, continue, mut, shadowing)
  // ==========================================================================
  {
    name: "control_if_else_if_else_stmt",
    category: "m2_control_flow",
    source: `
fn classify(n: i32) {
    if n < 0 {
        println("neg");
    } else if n == 0 {
        println("zero");
    } else if n < 10 {
        println("small");
    } else {
        println("large");
    }
}

fn main() {
    classify(-5);
    classify(0);
    classify(7);
    classify(42);
}
`,
    expectedStdout: "neg\nzero\nsmall\nlarge\n",
    expectedExitCode: 0,
  },
  {
    name: "control_if_else_expr_value",
    category: "m2_control_flow",
    source: `
fn pick(code: i32) -> i32 {
    if code == 1 {
        10
    } else if code == 2 {
        20
    } else {
        30
    }
}

fn main() {
    let x: i32 = if true { 100 } else { 200 };
    println(x);
    println(pick(1));
    println(pick(2));
    println(pick(99));
}
`,
    expectedStdout: "100\n10\n20\n30\n",
    expectedExitCode: 0,
  },
  {
    name: "control_while_sum_and_countdown",
    category: "m2_control_flow",
    source: `
fn main() {
    let mut i: i32 = 1;
    let mut sum: i32 = 0;
    while i <= 10 {
        sum += i;
        i += 1;
    }
    println(sum);

    let mut c: i32 = 3;
    while c > 0 {
        c -= 1;
    }
    println(c);
}
`,
    expectedStdout: "55\n0\n",
    expectedExitCode: 0,
  },
  {
    name: "control_while_break_and_continue",
    category: "m2_control_flow",
    source: `
fn main() {
    let mut i: i32 = 0;
    while i < 20 {
        i += 1;
        if i % 2 == 1 {
            continue;
        }
        if i > 8 {
            break;
        }
        println(i);
    }
    println("done");
}
`,
    expectedStdout: "2\n4\n6\n8\ndone\n",
    expectedExitCode: 0,
  },
  {
    name: "control_for_range_basic",
    category: "m2_control_flow",
    source: `
fn main() {
    let mut sum: i32 = 0;
    for i in 0..5 {
        println(i);
        sum += i;
    }
    println(sum);
}
`,
    expectedStdout: "0\n1\n2\n3\n4\n10\n",
    expectedExitCode: 0,
  },
  {
    name: "control_for_range_empty_single_and_negative",
    category: "m2_control_flow",
    source: `
fn main() {
    let mut empty_count: i32 = 0;
    for i in 5..2 {
        empty_count += 1;
    }
    for i in 3..3 {
        empty_count += 1;
    }
    println(empty_count);

    for j in 7..8 {
        println(j);
    }

    for k in -2..2 {
        println(k);
    }
}
`,
    expectedStdout: "0\n7\n-2\n-1\n0\n1\n",
    expectedExitCode: 0,
  },
  {
    name: "control_for_range_break_and_continue",
    category: "m2_control_flow",
    source: `
fn main() {
    for i in 0..10 {
        if i % 2 == 1 {
            continue;
        }
        if i == 6 {
            break;
        }
        println(i);
    }
}
`,
    expectedStdout: "0\n2\n4\n",
    expectedExitCode: 0,
  },
  {
    name: "control_nested_loops_break_continue",
    category: "m2_control_flow",
    source: `
fn main() {
    let mut row: i32 = 1;
    while row <= 3 {
        for col in 0..5 {
            if col == 1 {
                continue;
            }
            if col >= 3 {
                break;
            }
            println(row * 10 + col);
        }
        row += 1;
    }
}
`,
    expectedStdout: "10\n12\n20\n22\n30\n32\n",
    expectedExitCode: 0,
  },
  {
    name: "control_let_mut_and_compound_assignments",
    category: "m2_control_flow",
    source: `
fn main() {
    let base: i32 = 10;
    let mut x: i32 = base;
    x += 5;
    println(x);
    x -= 3;
    println(x);
    x *= 4;
    println(x);
    x /= 6;
    println(x);
}
`,
    expectedStdout: "15\n12\n48\n8\n",
    expectedExitCode: 0,
  },
  {
    name: "control_variable_shadowing_in_blocks",
    category: "m2_control_flow",
    source: `
fn main() {
    let x: i32 = 1;
    println(x);
    {
        let x: i32 = x + 10;
        println(x);
        if true {
            let x: string = "inner_shadow";
            println(x);
        }
        println(x);
    }
    println(x);
}
`,
    expectedStdout: "1\n11\ninner_shadow\n11\n1\n",
    expectedExitCode: 0,
  },
  {
    name: "control_early_return_from_loop",
    category: "m2_control_flow",
    source: `
fn find_first_multiple(limit: i32) -> i32 {
    for i in 1..limit {
        if i % 3 == 0 && i % 5 == 0 {
            return i;
        }
    }
    return -1;
}

fn main() {
    println(find_first_multiple(50));
    println(find_first_multiple(10));
}
`,
    expectedStdout: "15\n-1\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 9. Deep Recursion (Fibonacci, Mutual Recursion, Ackermann, GCD, Factorial)
  // ==========================================================================
  {
    name: "recursion_fib_20",
    category: "m2_recursion",
    source: `
fn fib(n: i32) -> i32 {
    if n <= 0 {
        return 0;
    }
    if n == 1 {
        return 1;
    }
    return fib(n - 1) + fib(n - 2);
}

fn main() {
    println(fib(0));
    println(fib(1));
    println(fib(10));
    println(fib(20));
}
`,
    expectedStdout: "0\n1\n55\n6765\n",
    expectedExitCode: 0,
  },
  {
    name: "recursion_mutual_even_odd_50",
    category: "m2_recursion",
    source: `
fn is_even(n: i32) -> bool {
    if n == 0 {
        return true;
    }
    return is_odd(n - 1);
}

fn is_odd(n: i32) -> bool {
    if n == 0 {
        return false;
    }
    return is_even(n - 1);
}

fn main() {
    println(bool_to_string(is_even(50)));
    println(bool_to_string(is_odd(50)));
    println(bool_to_string(is_odd(49)));
}
`,
    expectedStdout: "true\nfalse\ntrue\n",
    expectedExitCode: 0,
  },
  {
    name: "recursion_ackermann_3_4",
    category: "m2_recursion",
    source: `
fn ack(m: i32, n: i32) -> i32 {
    if m == 0 {
        return n + 1;
    }
    if n == 0 {
        return ack(m - 1, 1);
    }
    return ack(m - 1, ack(m, n - 1));
}

fn main() {
    println(ack(3, 4));
}
`,
    expectedStdout: "125\n",
    expectedExitCode: 0,
  },
  {
    name: "recursion_gcd_euclid",
    category: "m2_recursion",
    source: `
fn gcd(a: i32, b: i32) -> i32 {
    if b == 0 {
        return a;
    }
    return gcd(b, a % b);
}

fn main() {
    println(gcd(1071, 462));
    println(gcd(270, 192));
    println(gcd(17, 13));
}
`,
    expectedStdout: "21\n6\n1\n",
    expectedExitCode: 0,
  },
  {
    name: "recursion_factorial_i32_and_i64",
    category: "m2_recursion",
    source: `
fn fact32(n: i32) -> i32 {
    if n <= 1 {
        return 1;
    }
    return n * fact32(n - 1);
}

fn fact64(n: i64) -> i64 {
    if n <= 1i64 {
        return 1i64;
    }
    return n * fact64(n - 1i64);
}

fn main() {
    println(fact32(10));
    println(fact64(20i64));
}
`,
    expectedStdout: "3628800\n2432902008176640000\n",
    expectedExitCode: 0,
  },
  {
    name: "recursion_linear_sum_depth_200",
    category: "m2_recursion",
    source: `
fn sum_down(n: i32) -> i32 {
    if n <= 0 {
        return 0;
    }
    return n + sum_down(n - 1);
}

fn main() {
    println(sum_down(200));
}
`,
    expectedStdout: "20100\n",
    expectedExitCode: 0,
  },
  {
    name: "recursion_fast_power",
    category: "m2_recursion",
    source: `
fn fast_pow(base: i32, exp: i32) -> i32 {
    if exp == 0 {
        return 1;
    }
    let half: i32 = fast_pow(base, exp / 2);
    if exp % 2 == 0 {
        return half * half;
    }
    return base * half * half;
}

fn main() {
    println(fast_pow(2, 15));
    println(fast_pow(3, 9));
}
`,
    expectedStdout: "32768\n19683\n",
    expectedExitCode: 0,
  },

  // ==========================================================================
  // 10. Floats, Strings, Built-in Intrinsics, Literals, Constants & Formatter
  // ==========================================================================
  {
    name: "f64_arithmetic_and_comparisons",
    category: "m2_floats_strings_builtins",
    source: `
fn main() {
    let a: f64 = 3.5;
    let b: f64 = 2.25;
    println(a + b);
    println(a - b);
    println(a * b);
    println(-a);
    println(bool_to_string(a > b));
    println(bool_to_string(a <= 3.5));
    println(bool_to_string(a != b));
}
`,
    expectedStdout: "5.75\n1.25\n7.875\n-3.5\ntrue\ntrue\ntrue\n",
    expectedExitCode: 0,
  },
  {
    name: "f64_nan_and_infinity_formatting_and_eq",
    category: "m2_floats_strings_builtins",
    source: `
fn main() {
    let z: f64 = 0.0;
    let nan: f64 = z / z;
    let pinf: f64 = 1.0 / z;
    let ninf: f64 = -1.0 / z;
    println(nan);
    println(pinf);
    println(ninf);
    println(bool_to_string(nan == nan));
    println(bool_to_string(nan != nan));
}
`,
    expectedStdout: "NaN\ninf\n-inf\nfalse\ntrue\n",
    expectedExitCode: 0,
  },
  {
    name: "math_builtins_sqrt_abs_floor_ceil",
    category: "m2_floats_strings_builtins",
    source: `
fn main() {
    println(sqrt(16.0));
    println(abs_f64(-42.5));
    println(floor(3.9));
    println(ceil(3.1));
}
`,
    expectedStdout: "4\n42.5\n3\n4\n",
    expectedExitCode: 0,
  },
  {
    name: "string_concat_eq_len_and_escapes",
    category: "m2_floats_strings_builtins",
    source: `
fn main() {
    let a: string = "Hello, ";
    let b: string = "Lumen!";
    let c: string = a + b;
    println(c);
    println(str_len(c));
    println(bool_to_string(c == "Hello, Lumen!"));
    println(bool_to_string(a != b));
    let esc: string = "\x41\u{42}";
    println(esc);
}
`,
    expectedStdout: "Hello, Lumen!\n13\ntrue\ntrue\nAB\n",
    expectedExitCode: 0,
  },
  {
    name: "conversion_builtins_and_formatting",
    category: "m2_floats_strings_builtins",
    source: `
fn main() {
    println("val=" + int_to_string(-123));
    println("i64=" + i64_to_string(9000000000i64));
    println("f64=" + float_to_string(2.5));
    println("bool=" + bool_to_string(true));
    println(int_to_float(42));
    println(float_to_int(99.9));
    println(i32_to_i64(77));
    println(i64_to_i32(88i64));
}
`,
    expectedStdout: "val=-123\ni64=9000000000\nf64=2.5\nbool=true\n42\n99\n77\n88\n",
    expectedExitCode: 0,
  },
  {
    name: "numeric_literal_bases_and_underscores",
    category: "m2_floats_strings_builtins",
    source: `
fn main() {
    println(0xFF);
    println(0x10_00);
    println(0b1010_0101);
    println(0o755);
    println(1_000_000);
    println(0xFFi64);
}
`,
    expectedStdout: "255\n4096\n165\n493\n1000000\n255\n",
    expectedExitCode: 0,
  },
  {
    name: "top_level_consts_and_block_expressions",
    category: "m2_floats_strings_builtins",
    source: `
const BASE: i32 = 100;
const SCALE: i32 = 3;

fn main() {
    let computed: i32 = {
        let step1: i32 = BASE * SCALE;
        let step2: i32 = 10;
        step1 + step2
    };
    println(computed);
}
`,
    expectedStdout: "310\n",
    expectedExitCode: 0,
  },
  {
    name: "mutable_params_and_print_newline",
    category: "m2_floats_strings_builtins",
    source: `
fn accumulate(mut acc: i32, delta: i32) -> i32 {
    acc += delta * 2;
    acc
}

fn main() {
    let orig: i32 = 15;
    let res: i32 = accumulate(orig, 10);
    print(res);
    println();
    println(orig);
}
`,
    expectedStdout: "35\n15\n",
    expectedExitCode: 0,
  },
  {
    name: "fmt_round_trip_m2",
    category: "m2_formatter",
    checkFmtRoundTrip: true,
    source: `const   LIMIT : i32=5;
fn   compute_val( mut x:i32,y:i32 )->i32{
if x<y{x+=y*2;}else if x==y{x=x-1;}else{x/=2;}
let mut acc:i64=0i64;
for i in 0..LIMIT{
if i==3{continue;}
acc = acc + (i as i64);
}
return x + (acc as i32);
}
fn main( ){
let mut n:i32=2;
while n<4{n+=1;}
println( compute_val(n, 4) );
}`,
    expectedStdout: "10\n",
    expectedExitCode: 0,
  },
];
