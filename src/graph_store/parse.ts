import type { ZodType } from 'zod';
import {
  checkMutationLimits,
  checkOpCount,
  checkQueryLimits,
  resolveLimits,
  type ParseOptions,
} from './limits.js';
import { err, graphError, ok, type GraphError, type Result } from './result.js';
import { mutationSchema } from './schema/mutation.js';
import { querySchema } from './schema/query.js';
import type { Mutation, Query } from './types.js';

const SUPPORTED_VERSION = 1;

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function checkVersion(input: Record<string, unknown>): GraphError | undefined {
  if (!('version' in input) || input.version === SUPPORTED_VERSION) return undefined;
  return graphError(
    'UNSUPPORTED_VERSION',
    `Unsupported version ${JSON.stringify(input.version)}; supported: ${SUPPORTED_VERSION}`,
    ['version'],
  );
}

function validate<T>(schema: ZodType<T>, input: Record<string, unknown>): Result<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const issue = parsed.error.issues[0];
  const path = issue ? issue.path.map((p) => (typeof p === 'number' ? p : String(p))) : [];
  return err(graphError('VALIDATION_ERROR', issue?.message ?? 'Invalid input', path));
}

/** Runs a parser body so that nothing, including hostile input, can make it throw. */
function guarded<T>(body: () => Result<T>): Result<T> {
  try {
    return body();
  } catch {
    return err(graphError('VALIDATION_ERROR', 'Input could not be read'));
  }
}

/** Validates a mutation instruction. Pure; never throws. */
export function parseMutation(input: unknown, options?: ParseOptions): Result<Mutation> {
  return guarded(() => {
    const limits = resolveLimits(options);
    if (!isObject(input)) {
      return err(graphError('VALIDATION_ERROR', 'Expected a mutation object'));
    }
    if (input.kind !== 'mutation' && ('from' in input || 'return' in input)) {
      return err(graphError('VALIDATION_ERROR', 'This looks like a query; send it to query()', ['kind']));
    }
    const versionError = checkVersion(input);
    if (versionError) return err(versionError);
    const tooManyOps = checkOpCount(input.ops, limits);
    if (tooManyOps) return err(tooManyOps);
    const parsed = validate(mutationSchema, input);
    if (!parsed.ok) return parsed;
    const overLimit = checkMutationLimits(parsed.value, limits);
    return overLimit ? err(overLimit) : parsed;
  });
}

/** Validates a read query. Pure; never throws. */
export function parseQuery(input: unknown, options?: ParseOptions): Result<Query> {
  return guarded(() => {
    const limits = resolveLimits(options);
    if (!isObject(input)) {
      return err(graphError('VALIDATION_ERROR', 'Expected a query object'));
    }
    if (input.kind === 'mutation' || 'ops' in input) {
      return err(graphError('VALIDATION_ERROR', 'This looks like a mutation; send it to write()', ['kind']));
    }
    const versionError = checkVersion(input);
    if (versionError) return err(versionError);
    const parsed = validate(querySchema, input);
    if (!parsed.ok) return parsed;
    const overLimit = checkQueryLimits(parsed.value, limits);
    return overLimit ? err(overLimit) : parsed;
  });
}
