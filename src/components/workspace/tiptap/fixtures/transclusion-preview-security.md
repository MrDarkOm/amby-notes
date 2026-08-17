# Safe transclusion preview

- A list item
- Another item with `code`

See [safe link](https://example.com) and [[Wiki Note]].

<script>globalThis.transclusionScriptRan = true</script>
<img src="invalid" onerror="globalThis.transclusionImageRan = true">
<iframe src="https://attacker.example"></iframe>
[javascript link](javascript:alert(1))
<style>body { display: none; }</style>
<svg onload="globalThis.transclusionSvgRan = true"><circle /></svg>
<div class="ordinary">ordinary raw HTML</div>
