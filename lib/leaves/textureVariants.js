import { createRandom } from '../utils/random.js'

/**
 * Weighted choice of a texture variant per leaf.
 *
 * Each texture has a non-negative weight. Weights are percentages by
 * convention but do not need to add up to 100: they are normalised, so
 * 3 and 1 mean 75 % / 25 %. A weight of 0 is never picked; a texture without
 * a weight counts as 1.
 *
 * Invalid weights (negative or non-numeric, all zeros) are reported in the
 * console and replaced by equal weights, so the leaves keep showing.
 */

export function normalizeDistribution(weights, names)
{
    const problems = []

    const values = weights.map((value, index) =>
    {
        if(typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        {
            problems.push(`"${names[index]}" = ${value} (debe ser un número >= 0)`)
            return 0
        }
        return value
    })

    const total = values.reduce((sum, weight) => sum + weight, 0)
    if(total <= 0) problems.push('todos los pesos son 0')

    if(problems.length > 0)
    {
        console.error(`[leaves] Pesos de texturas no válidos: ${problems.join('; ')}. Se usan pesos iguales.`)
        return values.map(() => 1 / values.length)
    }

    return values.map((weight) => weight / total)
}

/**
 * Returns a function that maps a random number in [0, 1) to a variant index.
 */
export function createWeightedPicker(probabilities)
{
    const cumulative = []
    let sum = 0
    for(const probability of probabilities)
    {
        sum += probability
        cumulative.push(sum)
    }

    return (random) =>
    {
        const target = random * sum
        for(let i = 0; i < cumulative.length; i++)
        {
            // Strict comparison: a zero weight adds nothing to the running sum and can never win
            if(probabilities[i] > 0 && target < cumulative[i]) return i
        }
        // Rounding at the very top of the range: last variant with a non-zero weight
        return probabilities.findLastIndex((probability) => probability > 0)
    }
}

/**
 * One variant per leaf, decided once from the texture list. The same seed
 * always gives the same assignment, so a leaf keeps its texture for the whole
 * session and across reloads.
 */
export function assignVariants(count, textures, seed)
{
    // Nothing to choose from: every leaf shows the first (or only) look
    if(textures.length <= 1) return new Uint8Array(count)

    const weights = textures.map((entry) => (typeof entry === 'object' && entry.weight !== undefined ? entry.weight : 1))
    const names = textures.map((entry, index) => (typeof entry === 'object' && entry.name) || `textura ${index + 1}`)
    const pick = createWeightedPicker(normalizeDistribution(weights, names))
    const random = createRandom(seed * 92821 + 17)
    const variants = new Uint8Array(count)

    for(let i = 0; i < count; i++) variants[i] = pick(random())

    return variants
}
