import { launchWorker } from './runtime.mjs';
await launchWorker(...process.argv.slice(2));
