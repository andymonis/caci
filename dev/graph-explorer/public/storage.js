// What the page says about where the data lives. Pure, so it is tested without a browser.

/** The short label shown in the header. */
export function storageLabel(storage) {
  return storage?.kind === 'sqlite' ? `saved to ${storage.path}` : 'in memory';
}

/** The text of the reset button, and of its second click. */
export function resetLabels(storage) {
  return storage?.kind === 'sqlite'
    ? { idle: 'Delete all graphs in the file', armed: 'Click again to DELETE every graph in the file' }
    : { idle: 'Reset everything', armed: 'Click again to confirm' };
}

/** The tooltip that says exactly what a reset does. */
export function resetTitle(storage) {
  return storage?.kind === 'sqlite'
    ? `Deletes every graph stored in ${storage.path}. This cannot be undone.`
    : 'Forget every graph and start again';
}
