<script lang="ts">
  import Modal from "../Modal.svelte";
  import Select from "../Select.svelte";
  import Disclosure from "../Disclosure.svelte";
  import Checkbox from "../Checkbox.svelte";
  import Switch from "../Switch.svelte";
  import Notice from "../Notice.svelte";
  import Page from "../Page.svelte";
  import Facts from "../Facts.svelte";

  let showing = $state(false);
  let value = $state("all");
  let open = $state(false);
  let checked = $state(false);
  let disabled = $state(false);
  let enabled = $state(false);
  let requested = $state(false);
  let pending = $state(false);
  let requests = $state(0);
  let submissions = $state(0);
  const items = [
    { value: "all", label: "All events" },
    { value: "attention", label: "Needs attention" },
  ];
</script>

<Notice id="notice-neutral">Ready</Notice>
<Notice id="notice-success" tone="success">Plugin paused</Notice>
<Notice id="notice-error" tone="error">Request failed</Notice>
<form
  onsubmit={(event) => {
    event.preventDefault();
    submissions += 1;
  }}
>
  <Checkbox id="updates" label="Automatic updates" bind:checked {disabled} />
  <Switch
    id="startup"
    label="Start at login"
    bind:checked={
      () => enabled,
      (value) => {
        requested = value;
        pending = true;
        requests += 1;
      }
    }
    disabled={pending || disabled}
  />
  <button type="submit">Save fixture</button>
</form>
<button type="button" onclick={() => (checked = false)}>Reset checkbox</button>
<button type="button" onclick={() => (disabled = !disabled)}>Toggle disabled</button>
<button
  type="button"
  onclick={() => {
    enabled = requested;
    pending = false;
  }}>Confirm switch</button
>
<button
  type="button"
  onclick={() => {
    pending = false;
  }}>Reject switch</button
>
<p data-testid="checked">{String(checked)}</p>
<p data-testid="enabled">{String(enabled)}</p>
<p data-testid="requested">{String(requested)}</p>
<p data-testid="requests">{requests}</p>
<p data-testid="submissions">{submissions}</p>

<button onclick={() => (showing = true)}>Open dialog</button>
<button onclick={() => (value = "all")}>Reset selection</button>
<button onclick={() => (open = !open)}>Toggle from parent</button>
<Select label="Filter events" {items} bind:value />
<p data-testid="selection">{value}</p>
<p data-testid="expanded">{String(open)}</p>
<Disclosure title="Report" bind:open>
  <p>Report contents</p>
</Disclosure>
{#if showing}
  <Modal title="Preferences" onclose={() => (showing = false)}>
    {#snippet description()}Choose which events to display.{/snippet}
    <Select label="Dialog filter" {items} bind:value />
    <button onclick={() => (showing = false)}>Cancel</button>
  </Modal>
{/if}

<Page title="Portable page" description="Shared page fixture">
  {#snippet actions()}<button type="button">Page action</button>{/snippet}
  <p data-testid="page-content">Page contents</p>
  <Facts id="page-facts" items={[{ label: "State", value: "Ready" }]} />
</Page>
