// The LLM controls (R-012) for the dev tools. The tools get the loader module from their caller (the built `dist` when
// they run for real, the sources in tests), so this file imports nothing from either.

/** Loads and checks a controls folder, or throws an error that lists every problem. */
export function loadControlsOrThrow(loader, dir) {
  const folder = dir ?? loader.defaultControlsDir();
  const result = loader.loadControlsFolder(folder);
  if (!result.ok) throw new Error(`the LLM controls in ${folder} are not valid:\n${result.error.map((p) => `  - ${p}`).join('\n')}`);
  return result.value;
}

/** `createLlm` with the controls filled in, so the tools can keep calling it with just a client. */
export const withControls = (createLlm, controls) => (init) => createLlm({ controls, ...init });
