// The screen's tests run in Node, where Vite is not there to load a component's CSS: a stylesheet imports as an empty
// module, so components can be rendered to text in the tests (react-dom/server).
import { register } from 'node:module';

const hooks = `export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
