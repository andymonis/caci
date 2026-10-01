export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'GRAPH_NOT_FOUND',
  'NODE_NOT_FOUND',
  'CONFLICT',
  'UNSUPPORTED_VERSION',
  'STORAGE_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface GraphError {
  readonly code: ErrorCode;
  readonly message: string;
  /** Location of the problem in the input, e.g. `["ops", 2, "category"]`. */
  readonly path?: readonly (string | number)[];
}

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = GraphError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E = GraphError>(error: E): Err<E> {
  return { ok: false, error };
}

export function graphError(
  code: ErrorCode,
  message: string,
  path?: readonly (string | number)[],
): GraphError {
  return path === undefined ? { code, message } : { code, message, path };
}
