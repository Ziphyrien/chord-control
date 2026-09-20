import { build } from "vite-plus";

// Kit captures cwd at import time. Run in a child rooted at the plugin package.
// Node loads our TypeScript configs directly, without a config-bundling pass
// that would resolve the host app's (possibly not yet generated) tsconfig.
await build({ configFile: process.argv[2], configLoader: "native" });
