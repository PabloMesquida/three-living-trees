import { TREE_LIMITS, options, reloadWith } from '../config.js'

/**
 * The small panel shown without #debug: kind and number of trees (they
 * reload the page), number of leaves, falling, regrowth, wind sway (static
 * trees), reset and shake. Everything else lives in DebugUI
 * (#debug). The controls edit the first tree's params; main.js copies them
 * to the others.
 */
export class BasicPanel
{
    constructor({ trees, onChange })
    {
        const tree = trees[0]
        const { params } = tree
        const element = document.getElementById('basic-panel')
        element.hidden = false

        // Selects that rebuild the scene
        const select = (text, choices, current, apply) =>
        {
            const label = document.createElement('label')
            label.className = 'row'
            const name = document.createElement('span')
            name.textContent = text
            const input = document.createElement('select')
            for(const [title, value] of choices)
            {
                const option = document.createElement('option')
                option.value = value
                option.textContent = title
                option.selected = value === current
                input.append(option)
            }
            input.addEventListener('change', () => apply(input.value))
            label.append(name, input)
            return label
        }

        const kindLabel = select(
            'árbol',
            [['GLB con huesos', 'glb:1'], ['GLB sin huesos', 'glb:0'], ['provisional con huesos', 'procedural:1'], ['provisional sin huesos', 'procedural:0']],
            `${options.tree}:${tree.rigged ? 1 : 0}`, // what loaded, not what the URL asked for
            (value) =>
            {
                const [source, bones] = value.split(':')
                const limit = (bones === '1' ? TREE_LIMITS.rigged : TREE_LIMITS.static).maxTrees
                reloadWith({ tree: source, bones, trees: Math.min(options.trees, limit) })
            }
        )
        const counts = Array.from({ length: options.limits.maxTrees }, (_, i) => [String(i + 1), String(i + 1)])
        const treesLabel = select('árboles', counts, String(options.trees), (value) => reloadWith({ trees: value }))

        const note = document.createElement('p')
        note.className = 'note'
        note.textContent = (tree.rigged
            ? `Con huesos: hasta ${TREE_LIMITS.rigged.maxTrees} árboles. Ramas que el puntero sacude; caro (rig en CPU y skinning).`
            : `Sin huesos: hasta ${TREE_LIMITS.static.maxTrees} árboles. Se mecen con el viento en la GPU; el puntero empuja toda la copa.`) +
            (options.bones && !tree.rigged ? ` Ojo: ${options.glb} no tiene esqueleto, así que es estático.` : '')

        // Sliders
        const slider = (key, text, min, max, step, format) =>
        {
            const label = document.createElement('label')
            label.className = 'row'
            const name = document.createElement('span')
            name.textContent = text
            const value = document.createElement('output')
            const input = document.createElement('input')
            input.type = 'range'
            input.min = min
            input.max = max
            input.step = step
            input.value = params[key]
            value.textContent = format(params[key])
            input.addEventListener('input', () =>
            {
                params[key] = Number(input.value)
                value.textContent = format(params[key])
                onChange()
            })
            label.append(name, input, value)
            return label
        }

        const countLabel = slider('leafCount', trees.length > 1 ? 'hojas/árbol' : 'hojas', 0, tree.capacity, 1, (value) => value)
        const spontaneousLabel = slider('spontaneousFall', 'caída sola', 0, 1, 0.01, (value) => `${Math.round(value * 100)} %`)
        // Only a static tree sways in the wind
        const swayLabel = tree.rigged ? null : slider('sway', 'vaivén', 0, 4, 0.05, (value) => value.toFixed(2))

        // Toggles
        const toggle = (key, text) =>
        {
            const label = document.createElement('label')
            label.className = 'row'
            const name = document.createElement('span')
            name.textContent = text
            const input = document.createElement('input')
            input.type = 'checkbox'
            input.checked = params[key]
            input.addEventListener('change', () =>
            {
                params[key] = input.checked
                onChange()
            })
            label.append(name, input)
            return label
        }

        // Actions
        const button = (text, action) =>
        {
            const element = document.createElement('button')
            element.type = 'button'
            element.textContent = text
            element.addEventListener('click', action)
            return element
        }
        const actions = document.createElement('div')
        actions.className = 'actions'
        actions.append(button('reiniciar', () => trees.forEach((leafTree) => leafTree.reset())))
        // Every branch of a rigged tree, the whole crown of a static one
        actions.append(button('sacudir todo', () => trees.forEach((leafTree) => leafTree.shakeAll())))

        element.append(
            kindLabel, treesLabel, note,
            countLabel, spontaneousLabel, ...(swayLabel ? [swayLabel] : []),
            toggle('leafFall', 'caída'), toggle('regeneration', 'regeneración'), actions
        )
    }

    update()
    {
    }
}
