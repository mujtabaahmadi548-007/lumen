/**
 * Lumen Maranget Pattern Exhaustiveness & Redundancy Checker (`src/typechecker/exhaustiveness.js`)
 * Owned exclusively by Agent B.
 *
 * Implements Maranget's usefulness algorithm for exhaustiveness and redundancy:
 * - Scrutinee types: bool, enums (Option, Result, custom enums), structs, and primitives
 * - Nested patterns: EnumPattern, StructPattern, LiteralPattern, VarPattern, WildcardPattern
 * - Guarded arms (`if guard`) do NOT contribute to exhaustiveness guarantees!
 * - Emits `E0301` (MATCH_NON_EXHAUSTIVE) with concrete missing pattern witness
 * - Emits `E0302` (MATCH_REDUNDANT_ARM) for unreachable patterns
 */

import { ErrorCodes, createDiagnostic, unwrapType, typeToString } from "../contracts/index.js";

/**
 * Check exhaustiveness and redundancy of arms in a `match` expression.
 * Returns an array of `Diagnostic` objects.
 */
export function checkMatchExhaustiveness(scrutineeType, arms, env, matchSpan, sourceMap) {
  const diagnostics = [];
  const baseType = unwrapType(scrutineeType);

  if (!arms || arms.length === 0) {
    diagnostics.push(
      createDiagnostic({
        code: ErrorCodes.MATCH_NON_EXHAUSTIVE,
        severity: "error",
        message: `non-exhaustive \`match\` expression: pattern \`_\` not covered`,
        span: matchSpan,
        suggestion: `Add a wildcard arm \`_ => ...\` or match all variants of \`${typeToString(baseType)}\``,
      })
    );
    return diagnostics;
  }

  // 1. Redundancy & Exhaustiveness Matrix Algorithm
  // Rows: matrix of [Pattern]
  // An arm is redundant if its pattern is not useful with respect to previous unguarded rows.

  const matrix = []; // matrix of previous unguarded rows: Pattern[][]
  let isExhaustive = false;

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const pat = arm.pattern;
    const hasGuard = arm.guard !== null && arm.guard !== undefined;

    // Check if arm is redundant (only against previous unguarded patterns)
    if (matrix.length > 0 && isPatternRedundant(pat, matrix, [baseType], env)) {
      diagnostics.push(
        createDiagnostic({
          code: ErrorCodes.MATCH_REDUNDANT_ARM,
          severity: "error",
          message: `unreachable match arm: pattern is already covered by previous arms`,
          span: arm.span || pat.span || matchSpan,
          suggestion: `Remove this unreachable match arm or adjust previous patterns`,
        })
      );
    }

    // Only unguarded arms contribute to the exhaustiveness matrix
    if (!hasGuard) {
      matrix.push([pat]);
    }
  }

  // 2. Check overall exhaustiveness using the unguarded matrix
  const missingWitness = findMissingPattern(matrix, [baseType], env);
  if (missingWitness) {
    const witnessStr = patternWitnessToString(missingWitness);
    diagnostics.push(
      createDiagnostic({
        code: ErrorCodes.MATCH_NON_EXHAUSTIVE,
        severity: "error",
        message: `non-exhaustive \`match\` expression: pattern \`${witnessStr}\` not covered`,
        span: matchSpan,
        suggestion: `Ensure all cases are covered or add a fallback arm \`${witnessStr} => ...\``,
      })
    );
  }

  return diagnostics;
}

/**
 * Checks if a pattern vector is redundant (not useful) given the existing matrix.
 */
function isPatternRedundant(pattern, matrix, typeVec, env) {
  return !isUseful(matrix, [pattern], typeVec, env);
}

/**
 * Maranget's `isUseful(P, q, typeVec)`:
 * Checks whether pattern vector `q` matches any value that is not matched by matrix `P`.
 */
function isUseful(matrix, qVec, typeVec, env) {
  if (qVec.length === 0) {
    return matrix.length === 0;
  }

  const [q, ...qRest] = qVec;
  const [ty, ...typeRest] = typeVec;
  const t = unwrapType(ty);

  // If q is a wildcard or var pattern
  if (isWildcard(q)) {
    const constructors = getConstructorsForType(t, env);

    if (constructors && constructors.length > 0) {
      // Complete signature check
      const usedCtors = getUsedConstructorsInColumn(matrix, 0);
      const isComplete = constructors.every((c) => usedCtors.has(ctorKey(c)));

      if (isComplete) {
        // Must check specialized matrices for all constructors
        return constructors.some((ctor) => {
          const specMatrix = specializeMatrix(matrix, ctor, t, env);
          const specQ = [...getCtorDefaultSubpatterns(ctor), ...qRest];
          const specTypes = [...getCtorFieldTypes(ctor, t, env), ...typeRest];
          return isUseful(specMatrix, specQ, specTypes, env);
        });
      } else {
        // Missing constructor: default matrix check
        const defMatrix = defaultMatrix(matrix);
        return isUseful(defMatrix, qRest, typeRest, env);
      }
    } else {
      // Primitive types (integers, strings, etc.) have infinite constructors
      const defMatrix = defaultMatrix(matrix);
      return isUseful(defMatrix, qRest, typeRest, env);
    }
  }

  // q is a constructor (Enum, Struct, Literal, etc.)
  const ctor = getPatternConstructor(q, t, env);
  if (ctor) {
    const specMatrix = specializeMatrix(matrix, ctor, t, env);
    const subPats = getPatternSubpatterns(q);
    const specQ = [...subPats, ...qRest];
    const specTypes = [...getCtorFieldTypes(ctor, t, env), ...typeRest];
    return isUseful(specMatrix, specQ, specTypes, env);
  }

  return true;
}

/**
 * Finds a witness value (counterexample) not covered by the matrix.
 * Returns null if exhaustive.
 */
function findMissingPattern(matrix, typeVec, env) {
  if (typeVec.length === 0) {
    return matrix.length === 0 ? [] : null;
  }

  const [ty, ...typeRest] = typeVec;
  const t = unwrapType(ty);
  const constructors = getConstructorsForType(t, env);

  if (constructors && constructors.length > 0) {
    const usedCtors = getUsedConstructorsInColumn(matrix, 0);

    // Look for an unused constructor first
    for (const ctor of constructors) {
      if (!usedCtors.has(ctorKey(ctor))) {
        const defMatrix = defaultMatrix(matrix);
        const restWitness = findMissingPattern(defMatrix, typeRest, env);
        if (restWitness) {
          return {
            ctor,
            fields: getCtorFieldTypes(ctor, t, env).map(() => ({ kind: "WildcardPattern" })),
            rest: restWitness,
          };
        }
      }
    }

    // All constructors used: specialize on each constructor
    for (const ctor of constructors) {
      const specMatrix = specializeMatrix(matrix, ctor, t, env);
      const specTypes = [...getCtorFieldTypes(ctor, t, env), ...typeRest];
      const subWitness = findMissingPattern(specMatrix, specTypes, env);
      if (subWitness) {
        const fieldCount = getCtorFieldTypes(ctor, t, env).length;
        const fields = subWitness.slice(0, fieldCount);
        const rest = subWitness.slice(fieldCount);
        return {
          ctor,
          fields,
          rest,
        };
      }
    }

    return null;
  } else {
    // Primitive type: integers, floats, strings, etc.
    const defMatrix = defaultMatrix(matrix);
    const restWitness = findMissingPattern(defMatrix, typeRest, env);
    if (restWitness) {
      return {
        ctor: { kind: "wildcard" },
        fields: [],
        rest: restWitness,
      };
    }
    return null;
  }
}

// ----------------------------------------------------------------------------
// Helpers for Constructors, Specialization, and Default Matrices
// ----------------------------------------------------------------------------

function isWildcard(pat) {
  return !pat || pat.kind === "WildcardPattern" || pat.kind === "VarPattern";
}

function ctorKey(ctor) {
  if (ctor.kind === "bool") return `bool:${ctor.value}`;
  if (ctor.kind === "enum") return `enum:${ctor.variantName}`;
  if (ctor.kind === "struct") return `struct:${ctor.name}`;
  if (ctor.kind === "literal") return `lit:${ctor.value}`;
  return "wildcard";
}

function getConstructorsForType(t, env) {
  if (!t) return null;
  if (t.tag === "prim" && t.name === "bool") {
    return [
      { kind: "bool", value: true },
      { kind: "bool", value: false },
    ];
  }

  if (t.tag === "enum") {
    const enumDef = env.lookupEnum ? env.lookupEnum(t.name) : null;
    const variants = enumDef ? enumDef.variants : t.variants || [];
    return variants.map((v) => ({
      kind: "enum",
      enumName: t.name,
      variantName: v.name,
      tagIndex: v.tagIndex !== undefined ? v.tagIndex : 0,
      fieldTypes: v.fields || [],
    }));
  }

  if (t.tag === "struct") {
    const structDef = env.lookupStruct ? env.lookupStruct(t.name) : null;
    const fields = structDef ? structDef.fields : t.fields || [];
    return [
      {
        kind: "struct",
        name: t.name,
        fields,
      },
    ];
  }

  return null; // primitives have infinite constructors
}

function getPatternConstructor(pat, expectedType, env) {
  if (!pat) return null;
  if (isWildcard(pat)) return null;

  if (pat.kind === "LiteralPattern") {
    const lit = pat.literal;
    if (lit && lit.literalType === "bool") {
      return { kind: "bool", value: Boolean(lit.value) };
    }
    return { kind: "literal", value: lit ? lit.value : null };
  }

  if (pat.kind === "EnumPattern") {
    return {
      kind: "enum",
      enumName: pat.enumName,
      variantName: pat.variantName,
      args: pat.args || [],
    };
  }

  if (pat.kind === "StructPattern") {
    return {
      kind: "struct",
      name: pat.structName,
      fields: pat.fields || [],
    };
  }

  return null;
}

function getPatternSubpatterns(pat) {
  if (!pat) return [];
  if (pat.kind === "EnumPattern") {
    return pat.args || [];
  }
  if (pat.kind === "StructPattern") {
    return (pat.fields || []).map((f) => f.pattern);
  }
  return [];
}

function getCtorDefaultSubpatterns(ctor) {
  if (ctor.kind === "bool" || ctor.kind === "literal") return [];
  if (ctor.kind === "enum") {
    const count = ctor.fieldTypes ? ctor.fieldTypes.length : ctor.args ? ctor.args.length : 0;
    return Array(count).fill({ kind: "WildcardPattern" });
  }
  if (ctor.kind === "struct") {
    const count = ctor.fields ? ctor.fields.length : 0;
    return Array(count).fill({ kind: "WildcardPattern" });
  }
  return [];
}

function getCtorFieldTypes(ctor, expectedType, env) {
  if (!ctor) return [];
  if (ctor.kind === "bool" || ctor.kind === "literal") return [];

  if (ctor.kind === "enum") {
    if (ctor.fieldTypes) return ctor.fieldTypes;
    const enumDef = env.lookupEnum ? env.lookupEnum(ctor.enumName || (expectedType && expectedType.name)) : null;
    if (enumDef) {
      const v = enumDef.variants.find((x) => x.name === ctor.variantName);
      if (v && v.fields) return v.fields;
    }
    return [];
  }

  if (ctor.kind === "struct") {
    if (ctor.fields) return ctor.fields.map((f) => f.type);
    const structDef = env.lookupStruct ? env.lookupStruct(ctor.name) : null;
    if (structDef && structDef.fields) {
      return structDef.fields.map((f) => f.type);
    }
    return [];
  }

  return [];
}

function getUsedConstructorsInColumn(matrix, colIndex) {
  const set = new Set();
  for (const row of matrix) {
    const pat = row[colIndex];
    if (pat && !isWildcard(pat)) {
      if (pat.kind === "LiteralPattern" && pat.literal && pat.literal.literalType === "bool") {
        set.add(`bool:${Boolean(pat.literal.value)}`);
      } else if (pat.kind === "EnumPattern") {
        set.add(`enum:${pat.variantName}`);
      } else if (pat.kind === "StructPattern") {
        set.add(`struct:${pat.structName}`);
      } else if (pat.kind === "LiteralPattern") {
        set.add(`lit:${pat.literal ? pat.literal.value : ""}`);
      }
    }
  }
  return set;
}

function specializeMatrix(matrix, ctor, expectedType, env) {
  const result = [];
  const targetKey = ctorKey(ctor);
  const arity = getCtorFieldTypes(ctor, expectedType, env).length;

  for (const row of matrix) {
    if (row.length === 0) continue;
    const [first, ...rest] = row;

    if (isWildcard(first)) {
      const wildFields = Array(arity).fill({ kind: "WildcardPattern" });
      result.push([...wildFields, ...rest]);
    } else {
      const patCtor = getPatternConstructor(first, expectedType, env);
      if (patCtor && ctorKey(patCtor) === targetKey) {
        const subPats = getPatternSubpatterns(first);
        result.push([...subPats, ...rest]);
      }
    }
  }

  return result;
}

function defaultMatrix(matrix) {
  const result = [];
  for (const row of matrix) {
    if (row.length === 0) continue;
    const [first, ...rest] = row;
    if (isWildcard(first)) {
      result.push(rest);
    }
  }
  return result;
}

function patternWitnessToString(witness) {
  if (!witness) return "_";
  if (Array.isArray(witness)) {
    return witness.length === 0 ? "_" : witness.map(patternWitnessToString).join(", ");
  }

  if (witness.ctor) {
    const { ctor, fields } = witness;
    if (ctor.kind === "bool") {
      return String(ctor.value);
    }
    if (ctor.kind === "enum") {
      if (!fields || fields.length === 0) {
        return ctor.variantName;
      }
      return `${ctor.variantName}(${fields.map(patternWitnessToString).join(", ")})`;
    }
    if (ctor.kind === "struct") {
      return `${ctor.name} { ... }`;
    }
    if (ctor.kind === "literal") {
      return String(ctor.value);
    }
  }

  return "_";
}
