import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Threads pool keeps the suite runnable in sandboxed environments that
    // block child-process spawning (forks pool needs node:child_process.fork).
    pool: 'threads',
    include: ['tests/**/*.spec.ts'],
  },
})
