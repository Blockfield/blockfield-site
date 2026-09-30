// @ts-check
import { defineConfig } from 'astro/config'
import node from '@astrojs/node'

export default defineConfig({
  site: 'https://blockfield.pro',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  // Preserve spaces between inline elements when upgrading from Astro 5.
  compressHTML: true,
  build: { inlineStylesheets: 'always' },
})
