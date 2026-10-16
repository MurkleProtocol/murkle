// Node module-loader hooks that resolve the Vite virtual module "virtual:murkle-lab" the way a default
// (non-lab) build does: to the stub `export const labGpu = null;` (web/lab-plugin.mjs). Tests that import
// web/src/views/app-mine.js outside Vite register it through ./lab-virtual-register.mjs.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "virtual:murkle-lab") return { url: "data:text/javascript,export%20const%20labGpu%20%3D%20null%3B", shortCircuit: true };
  return nextResolve(specifier, context);
}
