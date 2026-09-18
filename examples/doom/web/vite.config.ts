import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { parseGameSessions } from '../../shared/web/src/game-sessions.ts';

const sessions = process.env.GAME_SESSIONS_JSON ? parseGameSessions(JSON.parse(process.env.GAME_SESSIONS_JSON)) : null;
export default defineConfig({
  define: { __GAME_SESSIONS__: JSON.stringify(sessions) },
  plugins: [react()],
  build: {
    outDir: '../../../dist/web',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('index.html', import.meta.url)) },
  },
});
