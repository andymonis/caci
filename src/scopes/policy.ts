// Who may read and who may capture in a circle brain (R-009's authorisation matrix), as one pure table. It
// answers only these two questions: circle administration (renaming, inviting, roles) is R-004's, and nobody
// has a right to edit or delete graph data in this release.

export type BrainAction = 'read' | 'capture';

const READ = ['owner', 'manager', 'member', 'observer'] as const;
const CAPTURE = ['owner', 'manager', 'member'] as const;

/** Whether a member in `role` may `action` in the circle's brain. Anything not in the table (an unknown role or action, a non-text value) is refused. */
export function authoriseBrain(role: unknown, action: unknown): boolean {
  if (action === 'read') return (READ as readonly unknown[]).includes(role);
  if (action === 'capture') return (CAPTURE as readonly unknown[]).includes(role);
  return false;
}
