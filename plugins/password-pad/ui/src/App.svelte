<script lang="ts">
  import { onMount } from "svelte";
  import Page from "@chord-control/ui/Page.svelte";
  import Notice from "@chord-control/ui/Notice.svelte";
  import type { PluginCall } from "../../../../sdk/ui.ts";
  import { CONFIRM_KEY, GRID_SIZE } from "../../input.ts";
  import { PadSession, type PadState } from "./session.ts";

  import type { PluginSurface } from "../../../../shared/protocol.ts";

  let { call, surface = "window" }: { call: PluginCall; surface?: PluginSurface } = $props();
  const preview = $derived(surface === "panel");
  const previewCells = Array.from("0123456789ABCDEFGHIJKLMNPQRSTUVWXYZ＃");
  let pad = $state.raw<PadState>({ view: null, count: 0, busy: true, message: "" });
  let session: PadSession | undefined;
  const positions = Array.from({ length: GRID_SIZE ** 2 }, (_, position) => position);

  function keydown(event: KeyboardEvent, position: number) {
    const movement: Record<string, number | undefined> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -GRID_SIZE,
      ArrowDown: GRID_SIZE,
    };
    const shift = movement[event.key];
    if (shift !== undefined && position + shift >= 0 && position + shift < positions.length) {
      event.preventDefault();
      const button = event.currentTarget as HTMLButtonElement;
      button.parentElement
        ?.querySelectorAll<HTMLButtonElement>("button")
        [position + shift]?.focus();
    } else if (event.key === "Backspace") {
      event.preventDefault();
      session?.backspace();
    }
  }

  onMount(() => {
    if (preview) return;
    const current = new PadSession(
      (method, input) => call(method, input),
      (next) => {
        pad = next;
      },
    );
    session = current;
    current.start();
    return () => {
      current.pause();
      session = undefined;
    };
  });
</script>

<Page title={pad.view?.title ?? "密保盘"} titleId="title" --cc-page-width="400px">
  <div
    id="cells"
    role="group"
    aria-label={preview ? "密保盘预览" : "单击输入，最后点击 ＃ 确认"}
    aria-busy={!preview && pad.busy}
  >
    {#each positions as position (position)}
      {@const value = preview ? previewCells[position] : pad.view?.cells[position]}
      <button
        type="button"
        disabled={preview || pad.busy || !pad.view}
        aria-label={value === CONFIRM_KEY ? "确认" : (value ?? "空")}
        onclick={() => session?.select(position)}
        onkeydown={(event) => keydown(event, position)}>{value ?? ""}</button
      >
    {/each}
  </div>
  <p id="input" aria-live="polite" aria-label={`已输入 ${pad.count} 位`}>
    {"•".repeat(pad.count)}
  </p>
  <Notice id="status"
    >{preview
      ? "密保盘预览"
      : pad.message || (!pad.view ? (pad.busy ? "正在加载…" : "暂无待验证请求") : "")}</Notice
  >
</Page>

<style>
  #cells {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    touch-action: manipulation;
    user-select: none;
  }
  #cells button {
    aspect-ratio: 1;
    min-width: 0;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    font:
      500 22px ui-monospace,
      monospace;
  }
  #cells button:disabled {
    opacity: 1;
  }
  #cells button:enabled:hover,
  #cells button:enabled:active {
    background: var(--cc-accent);
  }
  #cells button:focus-visible {
    outline: 2px solid var(--cc-focus);
    outline-offset: -4px;
  }
  #input {
    margin: 0;
    min-height: 24px;
    text-align: center;
    letter-spacing: 3px;
    overflow-wrap: anywhere;
  }
</style>
