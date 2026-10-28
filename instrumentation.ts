// Runs once when the server starts (Node runtime only; the Node-specific code lives in its own file so the
// edge bundle never tries to load fs/path).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
