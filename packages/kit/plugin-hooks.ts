import type { Reroute } from "@sveltejs/kit/hooks";

// The host owns generation-scoped URLs; every signed document has one Kit page.
export const reroute: Reroute = () => "/";
