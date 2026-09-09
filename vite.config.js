import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths, so the build works both at the project-pages
  // subpath (/asri/) and at the root of a custom domain.
  base: './',
  build: {
    target: 'es2022',
  },
})
