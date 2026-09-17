import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { createControllerClient, unavailableClient } from "./lib/controller.ts";
import { browserDesktop } from "./lib/desktop.ts";
import { createDesktopAdapter, createNativeTransport, isDesktop } from "./lib/native.ts";

const target = document.getElementById("app");
if (!target) throw new Error("缺少应用挂载节点");
const native = isDesktop();
const app = mount(App, {
  target,
  props: {
    client: native ? createControllerClient(createNativeTransport()) : unavailableClient,
    desktop: native ? createDesktopAdapter() : browserDesktop,
  },
});

// Dispose subscriptions when the development entry is replaced as well as on normal unmount.
if (import.meta.hot)
  import.meta.hot.dispose(async () => {
    const { unmount } = await import("svelte");
    await unmount(app);
  });
