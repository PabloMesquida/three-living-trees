import { TREE_LIMITS, options, reloadWith, sceneParams, treeChoices } from '../config.js'

/**
 * Debug interface: the Inspector's parameters panel for the controls, plus a
 * small text overlay with the particle counters.
 *
 * The "Scene" group rebuilds the scene (kind of tree, how many, textures,
 * leaf buffers, language) by reloading the page. Every other control edits
 * the first tree's params, which main.js copies to the others, and only shows
 * up when the kind of tree uses it.
 *
 * English by default; ?lang=es (or the language select) switches to Spanish.
 */

const COUNTERS_INTERVAL = 0.25

const STRINGS = {
    en: {
        scene: 'Scene',
        kind: 'tree',
        kinds: ['with bones', 'without bones'],
        trees: (max) => `trees (max. ${max})`,
        textures: 'textures (0 = built-in leaf)',
        capacity: 'max. leaves per tree',
        language: 'language',
        actions: 'Actions',
        reset: 'reset simulation',
        shake: 'shake all',
        tree: 'Tree',
        treeMotion: 'motion (pointer)',
        motionStrength: 'strength',
        sway: 'sway',
        swaySpeed: 'sway speed',
        leaves: 'Leaves',
        leafCount: 'count per tree',
        leafFall: 'falling',
        spontaneousFall: 'spontaneous fall',
        regeneration: 'regrowth',
        detachProbability: 'detach probability',
        detachThreshold: (rigged) => rigged ? 'shake threshold' : 'threshold (gusts and pointer)',
        gripVariation: 'grip variation',
        gravity: 'gravity',
        windStrength: 'wind',
        windAngle: 'wind direction',
        growDuration: 'grow duration',
        leafSize: 'leaf scale',
        leafCurve: 'leaf curve',
        leafColor: 'leaf color',
        orientation: 'Leaf orientation',
        leafAngle: 'angle to branch',
        leafAngleVariation: 'angle variation',
        leafRoll: 'roll',
        leafRollVariation: 'roll variation',
        leafUpward: 'towards the sky',
        debug: 'Debug',
        shadows: 'shadows',
        showAnchors: 'show anchors',
        stateColors: 'color by state',
        attached: 'attached ',
        falling: 'falling  ',
        growing: 'growing  ',
        total: 'total    ',
        shakeLine: 'shake    ',
        bone: 'bone     ',
        pointer: 'pointer  ',
        crown: 'crown',
        summary: (count, rigged, max) => `${count} ${count === 1 ? 'tree' : 'trees'} ${rigged ? 'with' : 'without'} bones (max. ${max})`,
        bones: 'bones',
        windOnGpu: 'wind on GPU',
        leavesOf: (active, capacity) => `leaves ${active} of ${capacity}`,
        noArmature: 'the GLB has no armature: it is static'
    },
    es: {
        scene: 'Escena',
        kind: 'árbol',
        kinds: ['con huesos', 'sin huesos'],
        trees: (max) => `árboles (máx. ${max})`,
        textures: 'texturas (0 = hoja propia)',
        capacity: 'máx. hojas por árbol',
        language: 'idioma',
        actions: 'Acciones',
        reset: 'reiniciar simulación',
        shake: 'sacudir todo',
        tree: 'Árbol',
        treeMotion: 'movimiento (puntero)',
        motionStrength: 'fuerza',
        sway: 'vaivén',
        swaySpeed: 'velocidad vaivén',
        leaves: 'Hojas',
        leafCount: 'cantidad por árbol',
        leafFall: 'caída',
        spontaneousFall: 'caída espontánea',
        regeneration: 'regeneración',
        detachProbability: 'prob. desprendimiento',
        detachThreshold: (rigged) => rigged ? 'umbral de sacudida' : 'umbral (ráfagas y puntero)',
        gripVariation: 'variación del agarre',
        gravity: 'gravedad',
        windStrength: 'viento',
        windAngle: 'dirección viento',
        growDuration: 'duración crecimiento',
        leafSize: 'escala hojas',
        leafCurve: 'curva hojas',
        leafColor: 'color hojas',
        orientation: 'Orientación hojas',
        leafAngle: 'ángulo con la rama',
        leafAngleVariation: 'variación del ángulo',
        leafRoll: 'giro sobre su eje',
        leafRollVariation: 'variación del giro',
        leafUpward: 'hacia el cielo',
        debug: 'Depuración',
        shadows: 'sombras',
        showAnchors: 'ver anclajes',
        stateColors: 'color por estado',
        attached: 'unidas   ',
        falling: 'cayendo  ',
        growing: 'creciendo',
        total: 'total    ',
        shakeLine: 'sacudida ',
        bone: 'hueso    ',
        pointer: 'puntero  ',
        crown: 'copa',
        summary: (count, rigged, max) => `${count} ${count === 1 ? 'árbol' : 'árboles'} ${rigged ? 'con' : 'sin'} huesos (máx. ${max})`,
        bones: 'huesos',
        windOnGpu: 'viento en GPU',
        leavesOf: (active, capacity) => `hojas ${active} de ${capacity}`,
        noArmature: 'el GLB no tiene esqueleto: es estático'
    }
}

// Kinds of tree, in the order of STRINGS.*.kinds: the value of ?bones
const KIND_VALUES = ['1', '0']

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

export class DebugUI
{
    constructor({ renderer, trees, onChange })
    {
        const tree = trees[0]
        const { params, simulation } = tree
        const t = STRINGS[options.lang]

        this.t = t
        this.trees = trees
        this.elapsed = 0
        this.frames = 0
        this.fps = 0
        this.element = document.getElementById('counters')
        this.element.hidden = false

        // Scene: anything that sizes buffers or builds trees reloads the page
        const scene = {
            kind: tree.rigged ? '1' : '0', // what loaded, not what the URL asked for
            trees: options.trees,
            textures: options.textures,
            capacity: options.capacity,
            lang: options.lang
        }
        const sceneGroup = renderer.inspector.createParameters(t.scene)
        sceneGroup.add(scene, 'kind', Object.fromEntries(t.kinds.map((label, i) => [label, KIND_VALUES[i]]))).name(t.kind).onChange(() =>
        {
            const limit = (scene.kind === '1' ? TREE_LIMITS.rigged : TREE_LIMITS.static).maxTrees
            reloadWith({ bones: scene.kind, trees: Math.min(options.trees, limit) })
        })
        sceneGroup.add(scene, 'trees', [...new Set([...treeChoices(options.limits.maxTrees), options.trees])].sort((a, b) => a - b)).name(t.trees(options.limits.maxTrees)).onChange(() => reloadWith({ trees: scene.trees }))
        sceneGroup.add(scene, 'textures', range(0, 5)).name(t.textures).onChange(() => reloadWith({ textures: scene.textures }))
        const capacities = [...new Set([1000, 2500, 5000, 10000, 20000, options.capacity])]
            .filter((value) => value * options.trees <= 160000)
            .sort((a, b) => a - b)
        sceneGroup.add(scene, 'capacity', capacities).name(t.capacity).onChange(() => reloadWith({ maxCount: scene.capacity, count: Math.min(params.leafCount, scene.capacity) }))
        sceneGroup.add(scene, 'lang', { English: 'en', Español: 'es' }).name(t.language).onChange(() => reloadWith({ lang: scene.lang }))

        // Actions, near the top so they are always in reach. shakeAll() shakes
        // every branch of a rigged tree and the whole crown of a static one
        const actions = renderer.inspector.createParameters(t.actions)
        actions.add({ reset: () => trees.forEach((leafTree) => leafTree.reset()) }, 'reset').name(t.reset)
        actions.add({ shake: () => trees.forEach((leafTree) => leafTree.shakeAll()) }, 'shake').name(t.shake)

        // Tree motion: the pointer pushes either kind; only a static tree sways in the wind
        const motion = renderer.inspector.createParameters(t.tree)
        motion.add(params, 'treeMotion').name(t.treeMotion).onChange(onChange)
        motion.add(params, 'motionStrength', 0, 3, 0.01).name(t.motionStrength).onChange(onChange)
        if(!tree.rigged)
        {
            motion.add(params, 'sway', 0, 5, 0.05).name(t.sway).onChange(onChange)
            motion.add(params, 'swaySpeed', 0, 4, 0.05).name(t.swaySpeed).onChange(onChange)
        }

        const leaves = renderer.inspector.createParameters(t.leaves)
        leaves.add(params, 'leafCount', 0, simulation.capacity, 1).name(t.leafCount).onChange(onChange)
        leaves.add(params, 'leafFall').name(t.leafFall).onChange(onChange)
        leaves.add(params, 'spontaneousFall', 0, 1, 0.01).name(t.spontaneousFall).onChange(onChange)
        leaves.add(params, 'regeneration').name(t.regeneration).onChange(onChange)
        leaves.add(params, 'detachProbability', 0, 1, 0.01).name(t.detachProbability).onChange(onChange)
        leaves.add(params, 'detachThreshold', 0.1, 6, 0.05).name(t.detachThreshold(tree.rigged)).onChange(onChange)
        leaves.add(params, 'gripVariation', 0, 6, 0.1).name(t.gripVariation).onChange(onChange)
        leaves.add(params, 'gravity', 0, 15, 0.1).name(t.gravity).onChange(onChange)
        leaves.add(params, 'windStrength', 0, 4, 0.05).name(t.windStrength).onChange(onChange)
        leaves.add(params, 'windAngle', -180, 180, 1).name(t.windAngle).onChange(onChange)
        leaves.add(params, 'growDuration', 0.1, 6, 0.1).name(t.growDuration).onChange(onChange)
        leaves.add(params, 'leafSize', 0.02, 0.5, 0.005).name(t.leafSize).onChange(onChange)
        leaves.add(params, 'leafCurve', 0, 0.5, 0.01).name(t.leafCurve).onChange(onChange)
        // The color only drives the built-in leaf, drawn when there are no textures
        if(tree.textures.length === 0) leaves.addColor(params, 'leafColor').name(t.leafColor).onChange(onChange)

        // Only sampled anchors can be reoriented; explicit ones keep their Blender orientation
        if(tree.anchors.frame !== null)
        {
            const orientation = renderer.inspector.createParameters(t.orientation)
            orientation.add(params, 'leafAngle', 0, 90, 1).name(t.leafAngle).onChange(onChange)
            orientation.add(params, 'leafAngleVariation', 0, 45, 1).name(t.leafAngleVariation).onChange(onChange)
            orientation.add(params, 'leafRoll', -90, 90, 1).name(t.leafRoll).onChange(onChange)
            orientation.add(params, 'leafRollVariation', 0, 90, 1).name(t.leafRollVariation).onChange(onChange)
            orientation.add(params, 'leafUpward', 0, 1, 0.01).name(t.leafUpward).onChange(onChange)
        }

        const debug = renderer.inspector.createParameters(t.debug)
        debug.add(sceneParams, 'shadows').name(t.shadows).onChange(onChange)
        debug.add(params, 'showAnchors').name(t.showAnchors).onChange(onChange)
        debug.add(params, 'stateColors').name(t.stateColors).onChange(onChange)

        // Until the first read back: every leaf on its anchor
        const active = trees.reduce((sum, leafTree) => sum + leafTree.simulation.count, 0)
        this.render({ attached: active, falling: 0, growing: 0, total: active })
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
        Promise.all(this.trees.map((tree) => tree.readCounts()))
            .then((list) => this.render(list.reduce((sum, counts) => ({
                attached: sum.attached + counts.attached,
                falling: sum.falling + counts.falling,
                growing: sum.growing + counts.growing,
                total: sum.total + counts.total
            }), { attached: 0, falling: 0, growing: 0, total: 0 })))
            .finally(() => { this.waiting = false })
    }

    render(counts)
    {
        const { trees, t } = this
        const tree = trees[0]
        const active = trees.reduce((sum, leafTree) => sum + leafTree.simulation.count, 0)
        const capacity = trees.reduce((sum, leafTree) => sum + leafTree.anchors.count, 0)
        const coherent = counts.total === active
        const hovering = trees.find((leafTree) => leafTree.pointer?.hovering)
        const hovered = hovering === undefined ? '—' : (hovering.rigged ? hovering.asset.bones[hovering.pointer.hoveredBone].name : t.crown)
        const maxShake = Math.max(...trees.map((leafTree) => leafTree.rig.maxShake))
        const bones = trees.reduce((sum, leafTree) => sum + (leafTree.rigged ? leafTree.asset.bones.length : 0), 0)

        this.element.innerHTML =
            `<span class="attached">${t.attached} ${String(counts.attached).padStart(6)}</span>\n` +
            `<span class="falling">${t.falling} ${String(counts.falling).padStart(6)}</span>\n` +
            `<span class="growing">${t.growing} ${String(counts.growing).padStart(6)}</span>\n` +
            `<span class="${coherent ? 'dim' : 'bad'}">${t.total} ${String(counts.total).padStart(6)} / ${active} ${coherent ? '✓' : '✗'}</span>\n` +
            '<span class="dim">' +
            (tree.rigged
                ? `${t.shakeLine} ${maxShake.toFixed(2).padStart(6)} rad/s\n` +
                  `${t.bone} ${hovered}\n`
                : `${t.pointer} ${hovered}\n`) +
            t.summary(options.trees, tree.rigged, options.limits.maxTrees) +
            (tree.rigged ? ` · ${t.bones} ${bones}` : ` · ${t.windOnGpu}`) + '\n' +
            (options.bones && !tree.rigged ? `<span class="bad">${t.noArmature}</span>\n` : '') +
            `${t.leavesOf(active, capacity)} · ${this.fps.toFixed(0)} fps\n` +
            `WebGPU · ${options.glb}</span>`
    }
}
