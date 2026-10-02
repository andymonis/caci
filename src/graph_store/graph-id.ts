/**
 * Graph ids become file names and keys in storage backends, so they use a deliberately small
 * character set that is safe everywhere: no path separators, dots, spaces, non-ASCII text, or
 * upper case (so case-insensitive file systems cannot make two graphs collide).
 * Node ids, which live inside a graph's data, stay opaque.
 */
export const MAX_GRAPH_ID_LENGTH = 128;

/** Lowercase letters, digits, `_` and `-`, starting with a letter or digit. */
export const GRAPH_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const GRAPH_ID_RULE = `1 to ${MAX_GRAPH_ID_LENGTH} characters: lowercase letters, digits, "_" or "-", starting with a letter or digit`;
