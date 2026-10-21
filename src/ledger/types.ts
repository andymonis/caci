/** Where a change happened: a person's own brain, or one circle's brain. */
export type LedgerScope = { readonly kind: 'personal'; readonly userId: string } | { readonly kind: 'circle'; readonly circleId: string };

export const LEDGER_ACTIONS = ['added', 'updated', 'removed'] as const;
export type LedgerAction = (typeof LEDGER_ACTIONS)[number];

export const LEDGER_KINDS = ['item', 'category', 'input'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** The most characters kept of a removed item's title and summary (R-014 D12). */
export const TITLE_MAX = 200;
export const SUMMARY_MAX = 400;
/** The most characters kept of an update's text as sent: the same as a note may have (R-017 D5). */
export const TEXT_MAX = 8000;
/** Node ids are opaque text; this is the longest the graph store allows. */
export const SUBJECT_MAX = 256;

/** One change to a brain, as it is recorded for review (R-014 D12). */
export interface LedgerEntry {
  /** Unique across the whole ledger. */
  readonly id: string;
  /** When it happened, in milliseconds since 1970. */
  readonly at: number;
  readonly scope: LedgerScope;
  /** The user who made the change. */
  readonly actor: string;
  readonly action: LedgerAction;
  readonly kind: LedgerKind;
  /** The id of the item or category that changed. */
  readonly subject: string;
  /** For a removal: what the item or category was called. */
  readonly title?: string;
  readonly summary?: string;
  /** For an `input` entry (R-017): the update as sent, 1 to 8,000 characters. Absent on every other kind. */
  readonly text?: string;
  /** The proposal whose approval made the change. */
  readonly proposalId: string;
}

export interface LedgerPage {
  readonly items: readonly LedgerEntry[];
  readonly nextCursor: string | null;
}
