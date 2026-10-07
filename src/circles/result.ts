// The circles component's own result type. It is structurally the same as the graph store's, so the
// two mix freely, but it is defined here so the component imports nothing that can read a graph
// (R-004 CR-NFR-06).
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });
