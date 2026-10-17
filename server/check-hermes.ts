import { readiness, runBridge } from './hermes-adapter';
console.log(readiness());
try {
  console.log(await runBridge({ action: 'check' }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Falló la verificación.');
  process.exitCode = 1;
}
