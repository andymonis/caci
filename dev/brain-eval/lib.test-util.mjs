// The real pieces the brain-eval arms need, built from the sources, for the tests.
import { createController, createItemIdGenerator } from '../../src/app/index.ts';
import { createCaciController } from '../../src/caci/index.ts';
import { createMemoryAdapter } from '../../src/graph_store/adapters/memory/index.ts';
import { query } from '../../src/graph_store/index.ts';
import * as llm from '../../src/llm/index.ts';
import * as testing from '../../src/llm/testing/index.ts';
import * as controlsFiles from '../../src/service/controls-files.ts';
import { createLoginThrottle, createMemorySessionStore, createMemoryUserStore, createPasswordHasher, createRegistrationThrottle, createUserController } from '../../src/users/index.ts';
import { loadControlsOrThrow } from '../shared/controls.mjs';

export const controls = loadControlsOrThrow(controlsFiles);
export const lib = {
  createMemoryAdapter, createUserController, createMemoryUserStore, createMemorySessionStore, createPasswordHasher, createLoginThrottle,
  createRegistrationThrottle, createController, createItemIdGenerator, createCaciController, createLlm: llm.createLlm, createLlmConfig: llm.createLlmConfig,
  createDemoModelClient: llm.createDemoModelClient, createScriptedModelClient: testing.createScriptedModelClient, query,
};
export const demoClient = () => llm.createDemoModelClient();
