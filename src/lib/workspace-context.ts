import { createContext } from "svelte";
import type { ControllerSession } from "./session.ts";
import type { SessionView } from "./session.svelte.ts";

export const [getWorkspace, setWorkspace] = createContext<{
  session: ControllerSession;
  view: SessionView;
  openAdd(): void;
}>();
