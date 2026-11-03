import { options, sceneParams } from '../config.js'

/**
 * Debug interface: the Inspector's parameters panel for the controls, plus a
 * small text overlay with the particle counters.
 */

const COUNTERS_INTERVAL = 0.25

export class DebugUI
{
    constructor({ renderer, tree, onChange })
    {
        const { params, simulation } = tree

        this.tree = tree
        this.elapsed = 0
        this.frames = 0
        this.fps = 0
        this.element = document.getElementById('counters')
        this.element.hidden = false

        // Only a rigged tree can move
        if(tree.rigged)
        {
            const motion = renderer.inspector.createParameters('Árbol')
            motion.add(params, 'treeMotion').name('movimiento').onChange(onChange)
            motion.add(params, 'motionStrength', 0, 3, 0.01).name('fuerza').onChange(onChange)
        }

        const leaves = renderer.inspector.createParameters('Hojas')
        leaves.add(params, 'leafCount', 0, simulation.capacity, 1).name('cantidad').onChange(onChange)
        leaves.add(params, 'leafFall').name('caída').onChange(onChange)
        leaves.add(params, 'spontaneousFall', 0, 1, 0.01).name('caída espontánea').onChange(onChange)
        leaves.add(params, 'regeneration').name('regeneración').onChange(onChange)
        if(tree.rigged)
        {
            leaves.add(params, 'detachProbability', 0, 1, 0.01).name('prob. desprendimiento').onChange(onChange)
            leaves.add(params, 'detachThreshold', 0.1, 6, 0.05).name('umbral de sacudida').onChange(onChange)
            leaves.add(params, 'gripVariation', 0, 6, 0.1).name('variación del agarre').onChange(onChange)
        }
        leaves.add(params, 'gravity', 0, 15, 0.1).name('gravedad').onChange(onChange)
        leaves.add(params, 'windStrength', 0, 4, 0.05).name('viento').onChange(onChange)
        leaves.add(params, 'windAngle', -180, 180, 1).name('dirección viento').onChange(onChange)
        leaves.add(params, 'growDuration', 0.1, 6, 0.1).name('duración crecimiento').onChange(onChange)
        leaves.add(params, 'leafSize', 0.02, 0.5, 0.005).name('escala hojas').onChange(onChange)

        // Only sampled anchors can be reoriented; explicit ones keep their Blender orientation
        if(tree.anchors.frame !== null)
        {
            const orientation = renderer.inspector.createParameters('Orientación hojas')
            orientation.add(params, 'leafAngle', 0, 90, 1).name('ángulo con la rama').onChange(onChange)
            orientation.add(params, 'leafAngleVariation', 0, 45, 1).name('variación del ángulo').onChange(onChange)
            orientation.add(params, 'leafRoll', -90, 90, 1).name('giro sobre su eje').onChange(onChange)
            orientation.add(params, 'leafRollVariation', 0, 90, 1).name('variación del giro').onChange(onChange)
            orientation.add(params, 'leafUpward', 0, 1, 0.01).name('hacia el cielo').onChange(onChange)
        }

        const debug = renderer.inspector.createParameters('Depuración')
        debug.add(sceneParams, 'shadows').name('sombras').onChange(onChange)
        debug.add(params, 'showAnchors').name('ver anclajes').onChange(onChange)
        debug.add(params, 'stateColors').name('color por estado').onChange(onChange)
        debug.add({ reset: () => tree.reset() }, 'reset').name('reiniciar simulación')
        if(tree.rigged) debug.add({ shake: () => tree.shakeAll() }, 'shake').name('sacudir todo')
        debug.add({ swap: () => switchTree() }, 'swap').name(options.tree === 'glb' ? 'usar árbol provisional' : 'usar GLB')

        this.render(simulation.counts)
    }

    update(deltaTime)
    {
        this.elapsed += deltaTime
        this.frames++

        if(this.elapsed < COUNTERS_INTERVAL) return

        this.fps = this.frames / this.elapsed
        this.elapsed = 0
        this.frames = 0

        // One read in flight at most, so a slow GPU cannot pile them up
        if(this.waiting) return
        this.waiting = true
        this.tree.readCounts()
            .then((counts) => this.render(counts))
            .finally(() => { this.waiting = false })
    }

    render(counts)
    {
        const { rig, asset, anchors, pointer, simulation } = this.tree
        const coherent = counts.total === simulation.count
        const hovered = pointer === null || pointer.hoveredBone === -1 ? '—' : asset.bones[pointer.hoveredBone].name

        this.element.innerHTML =
            `<span class="attached">unidas    ${String(counts.attached).padStart(6)}</span>\n` +
            `<span class="falling">cayendo   ${String(counts.falling).padStart(6)}</span>\n` +
            `<span class="growing">creciendo ${String(counts.growing).padStart(6)}</span>\n` +
            `<span class="${coherent ? 'dim' : 'bad'}">total     ${String(counts.total).padStart(6)} / ${simulation.count} ${coherent ? '✓' : '✗'}</span>\n` +
            (asset.rigged
                ? `<span class="dim">sacudida  ${rig.maxShake.toFixed(2).padStart(6)} rad/s\n` +
                  `hueso     ${hovered}\n` +
                  `huesos ${asset.bones.length} · `
                : '<span class="dim">árbol estático · ') +
            `hojas ${simulation.count} de ${anchors.count} · ${this.fps.toFixed(0)} fps\n` +
            `WebGPU · ${options.tree === 'glb' ? options.glb : 'árbol provisional'}</span>`
    }
}

function switchTree()
{
    const query = new URLSearchParams(window.location.search)
    query.set('tree', options.tree === 'glb' ? 'procedural' : 'glb')
    window.location.search = query.toString()
}
