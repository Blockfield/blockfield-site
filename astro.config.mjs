// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  site: 'https://blockfield.pro',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  build: { inlineStylesheets: 'always' },
});
