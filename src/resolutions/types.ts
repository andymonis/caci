/** Where a fact lives: the person's own brain, or a circle's (R-025 D12). */
export type ResolutionScope = { readonly kind: 'personal' } | { readonly kind: 'circle'; readonly circleId: string };

/**
 * One person's record that they have dealt with one fact (R-025 definitions). There is no field that could hold text from the
 * fact: only ids, the verb and the time (VR-NFR-01). One record per person per fact.
 */
export interface Resolution {
  /** The person (a user id). */
  readonly userId: string;
  readonly scope: ResolutionScope;
  /** The fact's graph id in that scope. */
  readonly factId: string;
  /** The verb's name, as in `controls/verbs.json`. */
  readonly verb: string;
  /** When it was recorded, in milliseconds since 1970. */
  readonly at: number;
}

/** A fact a resolution points at (no person). */
export interface ResolvedFact {
  readonly scope: ResolutionScope;
  readonly factId: string;
}

/** The most resolutions one person may hold (R-025 D16). */
export const MAX_RESOLUTIONS_PER_USER = 2_000;
/** The longest fact id: the same as the longest id the graph accepts. */
export const FACT_ID_MAX = 256;
/** The most a page may hold. */
export const MAX_RESOLUTION_PAGE = 100;
/** The most ids one `listFor` call may ask about. */
export const MAX_LIST_FOR = 500;

/** A page position: the last fact of the previous page. Pages run in a fixed order (scope, then fact id, in UTF-16 order). */
export interface ResolutionPageInput {
  readonly limit: number;
  readonly after?: ResolvedFact;
}

export interface ResolutionPage {
  readonly items: readonly Resolution[];
  readonly hasMore: boolean;
}
