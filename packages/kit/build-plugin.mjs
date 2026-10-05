import { createBuilder } from "vite-plus";

// Kit captures cwd at import time. Run in a child rooted at the plugin package.
// Node loads our TypeScript configs directly, without a config-bundling pass
// that would resolve the host app's (possibly not yet generated) tsconfig.
//
// SvelteKit 3 owns Vite's multi-environment buildApp lifecycle. Calling the
// legacy `build()` API only builds one environment and leaves the generated
// client-optimized modules unavailable to the server build.
const builder = await createBuilder({ configFile: process.argv[2], configLoader: "native" });
await builder.buildApp();
