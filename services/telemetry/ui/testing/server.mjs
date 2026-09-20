import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export function dashboardDiagnostics(page, test) {
  const errors = [];
  const events = [];
  function record(event) {
    events.push(event);
    if (events.length > 80) events.shift();
  }
  page.on("pageerror", (error) => {
    errors.push(error.message);
    record(`pageerror: ${error.stack ?? error.message}`);
  });
  page.on("console", (message) => record(`console ${message.type()}: ${message.text()}`));
  page.on("requestfailed", (request) =>
    record(`requestfailed: ${request.url()} ${request.failure()?.errorText}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) record(`response ${response.status()}: ${response.url()}`);
  });
  test.onTestFailed(() =>
    console.error(`Dashboard failure at ${page.url()}:\n${events.join("\n")}`),
  );
  return errors;
}

export async function startDashboard(test) {
  const child = fork(new URL("./vite-server.mjs", import.meta.url), [], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-12000);
    });
  test.onTestFailed(() => console.error(`Kit server output:\n${output}`));
  test.onTestFinished(async () => {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => child.kill(), 5000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      if (child.connected) child.send("stop");
      else child.kill();
    });
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Kit server startup timed out: ${output}`));
    }, 30000);
    child.once("message", (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error));
      else resolve(message.origin);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Kit server exited (${code}): ${output}`));
    });
  });
}
