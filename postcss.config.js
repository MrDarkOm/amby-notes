import autoprefixer from "autoprefixer"
import tailwindcss from "tailwindcss"
import { densityScalePlugin } from "./scripts/postcss-density-scale.mjs"

export default {
  plugins: [tailwindcss(), autoprefixer(), densityScalePlugin()],
}
