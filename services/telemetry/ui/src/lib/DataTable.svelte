<script>
  let { id, headers, rows, empty = "暂无数据" } = $props();
</script>

<div class="scroll">
  <table>
    <thead
      ><tr
        >{#each headers as heading (heading)}<th>{heading}</th>{/each}</tr
      ></thead
    >
    <tbody {id}>
      {#each rows as row (row)}
        <tr
          >{#each row as cell, column (column)}<td>{cell ?? "未知"}</td>{/each}</tr
        >
      {:else}
        <tr><td colspan={headers.length}>{empty}</td></tr>
      {/each}
    </tbody>
  </table>
</div>
