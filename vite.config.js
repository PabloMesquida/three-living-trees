import { existsSync } from 'node:fs'
import { mergeConfig } from 'vite'

// PORT lets a launcher pick a free port; `npm run dev` alone uses 5173 (or the next free one).
const port = Number(process.env.PORT) || 5173

const config = {
    server: { host: 'localhost', port, strictPort: Boolean(process.env.PORT) },
    build: { target: 'esnext', sourcemap: true }
}

// Settings for one machine only, if it has them: vite.config.local.js is not versioned
const localConfig = new URL('./vite.config.local.js', import.meta.url)

export default async (env) =>
{
    if(!existsSync(localConfig)) return config

    const { default: local } = await import(localConfig.href)
    return mergeConfig(config, local(env))
}
