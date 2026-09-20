import { createControllerClient, unavailableClient } from "./controller.ts";
import { browserDesktop } from "./desktop.ts";
import { createDesktopAdapter, createNativeTransport, isDesktop } from "./native.ts";

/** Application composition root; reusable pages only receive the session. */
export function createPlatform() {
  return isDesktop()
    ? { client: createControllerClient(createNativeTransport()), desktop: createDesktopAdapter() }
    : { client: unavailableClient, desktop: browserDesktop };
}
