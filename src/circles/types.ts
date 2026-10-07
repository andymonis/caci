/** The four roles a person can have in a circle (R-004 D4). Names say nothing about any setting. */
export const CIRCLE_ROLES = ['owner', 'manager', 'member', 'observer'] as const;
export type CircleRole = (typeof CIRCLE_ROLES)[number];

export const isCircleRole = (value: unknown): value is CircleRole => typeof value === 'string' && (CIRCLE_ROLES as readonly string[]).includes(value);

export const CIRCLE_NAME_MAX = 80;
export const CIRCLE_DESCRIPTION_MAX = 500;

/** A circle as the rest of the system sees it. */
export interface Circle {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Milliseconds since 1970. */
  readonly createdAt: number;
  readonly updatedAt: number;
}
