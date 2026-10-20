// Draws a chat thread (R-016) into a list: one row per message cloned from the page's templates, everything set as text. Shared by the
// Home chat and the circle screens so they cannot drift. Returns a function that draws a state and skips a redraw when nothing changed.

import { messageClass } from './chat-view.js';

export function createThreadDrawer({ thread, msgTemplate, lineTemplate }) {
  const clone = (template) => template.content.firstElementChild.cloneNode(true);
  const slot = (row, name) => {
    const found = row.querySelector(`[data-slot="${name}"]`);
    if (!found) throw new Error(`a row template has no slot "${name}"`);
    return found;
  };
  let drawn = '';
  return {
    /** Draws the messages; the same last message and count draws nothing again. */
    draw(messages) {
      const last = messages.at(-1);
      const key = `${messages.length}:${last ? last.id : 0}`;
      if (key === drawn) return;
      drawn = key;
      const rows = messages.map((message) => {
        const row = clone(msgTemplate);
        row.setAttribute('class', messageClass(message));
        slot(row, 'text').textContent = message.text;
        const lines = slot(row, 'lines');
        lines.replaceChildren(
          ...message.lines.map((line) => {
            const item = clone(lineTemplate);
            slot(item, 'text').textContent = line;
            return item;
          }),
        );
        lines.hidden = message.lines.length === 0;
        return row;
      });
      thread.replaceChildren(...rows);
      thread.scrollTop = thread.scrollHeight;
    },
    /** Forget what was drawn (the thread is being emptied). */
    clear() {
      drawn = '';
      thread.replaceChildren();
    },
  };
}
