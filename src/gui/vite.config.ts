import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 产物直接落到服务端的静态目录，由既有 node 服务托管，不需要第二个 Web 服务
export default defineConfig({
	plugins: [react()],
	build: {
		outDir: resolve(import.meta.dirname, '../server/public'),
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		// 开发时把接口代理给 GUI 服务，前端仍走同源路径，不受 Host/Origin 校验影响
		proxy: {
			'/api': {
				target: 'http://127.0.0.1:8787',
				changeOrigin: false,
			},
		},
	},
});
