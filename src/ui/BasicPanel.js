import { params } from '../config.js'

/**
 * The small panel shown without #debug: number of leaves, falling,
 * regrowth, reset and shake. Everything else lives in DebugUI (#debug).
 */
export class BasicPanel
{
    constructor({ rig, simulation, onChange, onReset })
    {
        const element = document.getElementById('basic-panel')
        element.hidden = false

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

        const countLabel = slider('leafCount', 'hojas', 0, simulation.capacity, 1, (value) => value)
        const spontaneousLabel = slider('spontaneousFall', 'caída sola', 0, 1, 0.01, (value) => `${Math.round(value * 100)} %`)

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
        actions.append(
            button('reiniciar', onReset),
            button('sacudir todo', () => rig.shakeAll())
        )

        element.append(countLabel, spontaneousLabel, toggle('leafFall', 'caída'), toggle('regeneration', 'regeneración'), actions)
    }

    update()
    {
    }
}
