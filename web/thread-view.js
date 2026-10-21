// Draws a chat thread (R-016) into a list: one row per message cloned from the page's templates, everything set as text. Shared by the
// Home chat and the circle screens so they cannot drift. Returns a function that draws a state and skips a redraw when nothing changed.

import { messageClass } from './chat-view.js';

export function createThreadDrawer({ thread, msgTemplate, lineTemplate, onShowSource }) {
  const clone = (template) => template.content.firstElementChild.cloneNode(true);
  const slot = (row, name) => {
    const found = row.querySelector(`[data-slot="${name}"]`);
    if (!found) throw new Error(`a row template has no slot "${name}"`);
    return found;
  };
  let drawn = '';
  let drawnRows = [];
  return {
    /** Draws the messages; the same last message, count and busy state draws nothing again. `busy` disables the Show the source buttons. */
    draw(messages, busy = false) {
      const last = messages.at(-1);
      const key = `${messages.length}:${last ? last.id : 0}:${busy ? 'b' : ''}`;
      if (key === drawn) return;
      drawn = key;
      const rows = messages.map((message) => {
        const row = clone(msgTemplate);
        row.setAttribute('class', messageClass(message));
        if (message.kind === 'source') row.setAttribute('tabindex', '-1');
        slot(row, 'text').textContent = message.text;
        const lines = slot(row, 'lines');
        lines.replaceChildren(
          ...message.lines.map((line, index) => {
            const item = clone(lineTemplate);
            slot(item, 'text').textContent = line;
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
