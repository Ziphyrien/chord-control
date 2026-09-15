import "../src/app.css";
import { mount } from "svelte";
import App from "../src/App.svelte";
import type { ControllerClient } from "../src/lib/controller.ts";
import type {
  ControllerCommand,
  ControllerEvent,
  ControllerSnapshot,
  Json,
} from "../shared/protocol.ts";

declare global {
  interface Window {
    controllerCommand(
      command: ControllerCommand,
    ): Promise<{ result: Json; snapshot: ControllerSnapshot; message?: string }>;
  }
}
let emit: (event: ControllerEvent) => void = () => {};
const client: ControllerClient = {
  async connect(receive) {
    emit = receive;
    await this.send({ type: "snapshot" });
    return () => {
      emit = () => {};
    };
  },
  async send(command) {
    const response = await window.controllerCommand(command);
    emit({ type: "snapshot", snapshot: response.snapshot });
    if (response.message) throw new Error(response.message);
    return response.result;
  },
};
mount(App, { target: document.getElementById("app")!, props: { client } });
