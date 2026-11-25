// Draws a chat thread (R-016) into a list: one row per message cloned from the page's templates, everything set as text. Shared by the
// Home chat and the circle screens so they cannot drift. Returns a function that draws a state and skips a redraw when nothing changed.

import { messageClass } from './chat-view.js';

export function createThreadDrawer({ thread, msgTemplate, lineTemplate, onShowSource, verbTemplate, onVerb }) {
  const clone = (template) => template.content.firstElementChild.cloneNode(true);
  const slot = (row, name) => {
    const found = row.querySelector(`[data-slot="${name}"]`);
    if (!found) throw new Error(`a row template has no slot "${name}"`);
    return found;
  };
  let drawn = '';
  let drawnRows = [];
  return {
    /**
     * Draws the messages; the same last message, count and busy state draws nothing again. `busy` disables the Show the source buttons and
     * the verb buttons. `verbs` (R-025) is what to offer on a point of an answer: `{ items, canRemove(fact), isResolved(messageId, line, fact) }`,
     * where `items` are the service's `{ name, effect, help }` and a resolved fact shows as done instead of buttons.
     */
    draw(messages, busy = false, verbs = undefined) {
      const last = messages.at(-1);
      const offered = verbs?.items ?? [];
      const doneCount = verbs?.doneCount ?? 0;
      const key = `${messages.length}:${last ? last.id : 0}:${busy ? 'b' : ''}:${offered.length}:${doneCount}`;
      if (key === drawn) return;
      drawn = key;
      const rows = messages.map((message) => {
        const row = clone(msgTemplate);
        row.setAttribute('class', messageClass(message));
        if (message.kind === 'source') row.setAttribute('tabindex', '-1');
        slot(row, 'text').textContent = message.text;
        const lines = slot(row, 'lines');
        // an answer's points are numbered when any of them has a fact behind it, so `/pay 2` and the buttons name the same point
        const numbered = message.kind === 'answer' && (message.lineFacts ?? []).some((facts) => facts.length > 0);
        lines.replaceChildren(
          ...message.lines.map((line, index) => {
            const item = clone(lineTemplate);
            slot(item, 'text').textContent = line;
            const number = item.querySelector('[data-slot="number"]');
            if (number) {
              number.hidden = !numbered;
              number.textContent = numbered ? `${index + 1}.` : '';
            }
            const verbSlot = item.querySelector('[data-slot="verbs"]');
            const facts = message.kind === 'answer' ? (message.lineFacts?.[index] ?? []) : [];
            if (verbSlot && verbTemplate && typeof onVerb === 'function' && offered.length > 0 && facts.length > 0) {
              const buttons = [];
              let allDone = true;
              facts.forEach((fact, factIndex) => {
                if (verbs.isResolved?.(message.id, index, factIndex)) return;
                allDone = false;
                const label = facts.length > 1 ? `${index + 1}.${factIndex + 1}` : String(index + 1);
                for (const verb of offered) {
                  if (verb.effect === 'remove' && verbs.canRemove?.(fact) !== true) continue; // only an owner may remove a fact for everyone
                  const button = clone(verbTemplate);
                  button.textContent = facts.length > 1 ? `${verb.name} ${label}` : verb.name;
                  button.disabled = busy;
                  button.setAttribute('aria-label', `${verb.help.replace(/\.$/, '')}: point ${label}`);
                  button.addEventListener('click', () => onVerb(verb.name, message.id, index, factIndex));
                  buttons.push(button);
                }
              });
              if (allDone) verbSlot.textContent = 'Done';
              else verbSlot.replaceChildren(...buttons);
              verbSlot.hidden = !allDone && buttons.length === 0;
            }
            const button = item.querySelector('[data-slot="source"]');
            if (button) {
              const traceable = typeof onShowSource === 'function' && message.kind === 'answer' && (message.lineFacts?.[index]?.length ?? 0) > 0;
              button.hidden = !traceable;
              if (traceable) {
                button.disabled = busy;
                button.setAttribute('aria-label', `Show the source of: ${[...line].slice(0, 80).join('')}`);
                button.addEventListener('click', () => onShowSource(message.id, index));
              }
            }
            return item;
          }),
        );
        lines.hidden = message.lines.length === 0;
        return row;
      });
      drawnRows = rows;
      thread.replaceChildren(...rows);
      thread.scrollTop = thread.scrollHeight;
    },
    /** Puts the focus on the newest message that has a source in it (so a person who asked for the source is taken to it). */
    focusLast() {
      const row = drawnRows[drawnRows.length - 1];
      if (row && typeof row.focus === 'function') row.focus();
    },
    /** Forget what was drawn (the thread is being emptied). */
    clear() {
      drawn = '';
      drawnRows = [];
      thread.replaceChildren();
    },
  };
}
