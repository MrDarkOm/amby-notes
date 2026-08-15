/** Styling injected into emoji-mart's closed visual boundary. */
export const EMOJI_PICKER_SHADOW_STYLE = `
  #root > .padding-lr:not(.scroll) {
    padding: 12px;
    border-bottom: 1px solid var(--menu-border);
  }
  #root > .padding-lr:not(.scroll) .spacer { display: none; }
  .search { padding: 0; }
  .search input[type="search"] {
    height: 40px;
    border: 1px solid var(--menu-border);
    border-radius: 10px;
    background: transparent;
    box-shadow: none;
    font-size: 14px;
    font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: hsl(var(--foreground));
    padding-left: 40px;
    padding-top: 0;
    padding-bottom: 0;
  }
  .search input[type="search"]::placeholder {
    color: hsl(var(--muted-foreground));
    opacity: 1;
  }
  .search .loupe {
    left: 12px;
    width: 20px;
    height: 20px;
    color: hsl(var(--muted-foreground));
  }
  .search .loupe svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  .search input[type="search"]:focus {
    border-color: hsl(var(--primary));
    box-shadow: none;
  }
  .search + .flex {
    width: 40px !important;
    height: 40px !important;
    margin-left: 8px;
    border: 1px solid var(--menu-border);
    border-radius: 10px;
  }
  .search + .flex .skin-tone-button {
    width: 100% !important;
    height: 100% !important;
  }
  .category .sticky { font-size: 12px; }
`
