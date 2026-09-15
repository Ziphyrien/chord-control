import "./app.css";
import App from "./App.svelte";
import { mount } from "svelte";
import { createControllerClient } from "./lib/controller.ts";

const target = document.getElementById("app");
if (!target) throw new Error("App target was not found");

mount(App, { target, props: { client: createControllerClient() } });
