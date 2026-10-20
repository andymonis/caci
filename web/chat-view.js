// The words on the chat screen (R-016). Pure: no page access. Everything shown is text.

export const CHAT_MODE_WORDS = Object.freeze({
  demo: 'Updates and questions are handled by the free demo model: nothing leaves this machine.',
  anthropic: "Updates and questions are handled by Anthropic's model: what you type, and the notes you can read (yours and your circles'), are sent to Anthropic and are not anonymised.",
});
export const CHAT_MODE_UNKNOWN = 'Could not tell which model handles your updates.';
export const CHAT_MODE_LOADING = 'Checking which model handles your updates…';
export const CHAT_EMPTY_HINT = 'Type an update to record it, or a question to ask CaCi.';

/** The notice about which model is used, from the chat session's mode state. */
export function chatModeNotice(mode) {
  if (mode && mode.status === 'known' && Object.hasOwn(CHAT_MODE_WORDS, mode.value)) return CHAT_MODE_WORDS[mode.value];
  if (mode && mode.status === 'loading') return CHAT_MODE_LOADING;
  return CHAT_MODE_UNKNOWN;
}

/** The class of a message in the thread: the person's on one side, CaCi's on the other. */
export const messageClass = (message) => (message && message.from === 'me' ? 'msg me' : message && message.kind === 'error' ? 'msg cacci problem' : 'msg cacci');
