<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    actions,
    footer,
    children,
  }: { actions?: Snippet; footer?: Snippet; children?: Snippet; [key: string]: unknown } = $props();
</script>

<section class="frame">
  <header>
    <h2>Neuxie AI</h2>
    {#if actions}{@render actions()}{/if}
  </header>
  <div class="content">
    {#if children}{@render children()}{/if}
  </div>
  {#if footer}{@render footer()}{/if}
</section>

<style>
  .frame {
    display: flex;
    flex: 1;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
    color: var(--color-text);
  }

  header {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    min-block-size: 48px;
    padding: 6px 12px;
  }

  h2 {
    flex: 1;
    margin: 0;
    font-size: 14px;
    font-weight: 550;
    letter-spacing: -0.015em;
  }

  .content {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-block-size: 0;
    overflow: hidden;
  }
</style>
