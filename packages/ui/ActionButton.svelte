<script lang="ts">
  import { onDestroy, type Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  type ActionResult = { ok: boolean; visible: boolean };
  type Action = (event: MouseEvent) => ActionResult | Promise<ActionResult>;
  type Props = { action: Action; children: Snippet } & Omit<
    HTMLButtonAttributes,
    "children" | "onclick"
  >;

  let { action, children, ...buttonProps }: Props = $props();
  let feedback = $state<"success" | "failure" | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function complete(event: MouseEvent) {
    clearTimeout(timer);
    feedback = null;
    let result: ActionResult;
    try {
      result = await action(event);
    } catch {
      result = { ok: false, visible: false };
    }
    if (result.visible) return;
    feedback = result.ok ? "success" : "failure";
    timer = setTimeout(() => {
      feedback = null;
    }, 1800);
  }

  onDestroy(() => clearTimeout(timer));
</script>

<span class="action-button">
  <button {...buttonProps} onclick={(event) => void complete(event)}>{@render children()}</button>
  <span class="action-feedback-slot" aria-hidden={feedback ? undefined : "true"}>
    {#if feedback}
      <span
        class="action-feedback"
        role="status"
        aria-label={feedback === "success" ? "操作完成" : "操作失败"}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {#if feedback === "success"}
            <path d="M5 12.5 9.5 17 19 7.5" />
          {:else}
            <path d="M6 6 18 18M18 6 6 18" />
          {/if}
        </svg>
      </span>
    {/if}
  </span>
</span>

<style>
  .action-button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    vertical-align: middle;
  }
  .action-feedback-slot {
    display: inline-grid;
    width: 1.25em;
    height: 1.25em;
    flex: 0 0 1.25em;
    place-items: center;
  }
  .action-feedback {
    display: inline-grid;
    width: 100%;
    height: 100%;
    place-items: center;
    color: var(--cc-success, #2b481e);
    pointer-events: none;
    animation: action-feedback-fade 1800ms ease both;
  }
  .action-feedback svg {
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .action-feedback path {
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 32;
    stroke-dashoffset: 32;
    animation: action-mark-draw 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes action-mark-draw {
    to {
      stroke-dashoffset: 0;
    }
  }
  @keyframes action-feedback-fade {
    0%,
    100% {
      opacity: 0;
      transform: scale(0.72);
    }
    14%,
    74% {
      opacity: 1;
      transform: scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .action-feedback {
      animation: none;
    }
    .action-feedback path {
      animation: none;
      stroke-dashoffset: 0;
    }
  }
</style>
