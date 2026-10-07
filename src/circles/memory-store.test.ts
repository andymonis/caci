import { describe, it } from 'vitest';
import { createMemoryCircleStore } from './memory-store.js';
import { runCircleStoreConformance } from './testing/index.js';

// the shared suite, through Vitest itself
runCircleStoreConformance(() => createMemoryCircleStore(), { describe, it });
