/**
 * Options that need a page reload (they size the GPU buffers or pick the tree)
 * come from the URL:  ?count=2000&maxCount=20000&seed=7&tree=glb&glb=./models/test_tree.glb
 *
 * count     leaves shown when the page opens
 * maxCount  how many leaves the GPU buffers hold: the most the panel slider can show
 *
 * The live parameters of the tree and its leaves are the library's
 * (DEFAULT_PARAMS in lib/LeafTree.js), reached through tree.params.
 */
const query = new URLSearchParams(window.location.search)

const intOption = (name, fallback, min, max) =>
{
    const value = parseInt(query.get(name), 10)
    return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback
}

// What the demo shows when the URL says nothing
const DEFAULT_TREE = 'glb' // 'glb' or 'procedural'
const DEFAULT_GLB = './models/sapling_test12_b.glb'

const count = intOption('count', 5000, 0, 200000)

export const options = {
    // #debug in the URL shows every setting, the counters and the profiler
    debug: window.location.hash.toLowerCase() === '#debug',
    count,
    capacity: Math.max(count, intOption('maxCount', 10000, 1, 200000)),
    seed: intOption('seed', 1, 0, 0x7fffffff),
    tree: ['glb', 'procedural'].includes(query.get('tree')) ? query.get('tree') : DEFAULT_TREE,
    glb: query.get('glb') || DEFAULT_GLB
}

/**
 * Scene settings of the demo itself (not part of the library).
 */
export const sceneParams = {
    shadows: true
}
