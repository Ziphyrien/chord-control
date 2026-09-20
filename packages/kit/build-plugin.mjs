import { build } from "vite-plus";

// Kit captures cwd at import time. Run in a child rooted at the plugin package.
await build({ configFile: process.argv[2] });
