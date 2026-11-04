/**
 * Options that need a page reload (they size the GPU buffers or build the
 * trees) come from the URL:  ?tree=glb&bones=0&trees=6&count=2000&maxCount=4000&seed=7
 *
 * tree      glb (the GLB below, or ?glb=...) or procedural (the provisional tree)
 * bones     1 keeps the armature: branches the pointer shakes, expensive.
 *           0 strips it at load (as a Blender export without armature would):
 *           a static tree that sways in the wind, cheap. A GLB without an
 *           armature is static either way (the panels say so)
 * trees     how many trees, from 1 to the limit of their kind (TREE_LIMITS)
 * count     leaves per tree when the page opens
 * maxCount  how many leaves each tree's GPU buffers hold: the most the panel slider can show
 * textures  how many of the leaf textures to use, 0 to 5: 0 shows the library's
 *           built-in leaf (no images), e.g. ?textures=0 or ?textures=1
 * lang      language of the debug panel: en (default) or es
 *
 * The panels change these by reloading the page with a new URL (see reloadWith()).
 * The live parameters of the trees and their leaves are the library's
 * (DEFAULT_PARAMS in lib/LeafTree.js), reached through tree.params and
 * shared by every tree.
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

/**
 * What each kind of tree allows. A rigged tree costs CPU every frame (its
 * spring rig, at 120 Hz) and GPU (skinning, plus a bone uniform array in
 * every leaf shader), and the pointer raycasts its skinned collider. A static
 * tree only adds a few vertex shader instructions.
 */
export const TREE_LIMITS = {
    rigged: { maxTrees: 4, label: 'con huesos' },
    static: { maxTrees: 16, label: 'sin huesos' }
}

// Leaves: per tree by default, and in total across every tree's buffers
const LEAVES_PER_SCENE = 20000
const MAX_CAPACITY_PER_SCENE = 160000

const bones = query.get('bones') !== '0'
const limits = bones ? TREE_LIMITS.rigged : TREE_LIMITS.static
const trees = intOption('trees', 1, 1, limits.maxTrees)
const roundDown = (value, step) => Math.floor(value / step) * step
const count = intOption('count', Math.min(5000, roundDown(LEAVES_PER_SCENE / trees, 100)), 0, 200000)
const capacity = Math.min(
    Math.max(count, intOption('maxCount', Math.min(10000, roundDown(2 * LEAVES_PER_SCENE / trees, 500)), 1, 200000)),
    Math.floor(MAX_CAPACITY_PER_SCENE / trees)
)

export const options = {
    // #debug in the URL shows every setting, the counters and the profiler
    debug: window.location.hash.toLowerCase() === '#debug',
    tree: ['glb', 'procedural'].includes(query.get('tree')) ? query.get('tree') : DEFAULT_TREE,
    glb: query.get('glb') || DEFAULT_GLB,
    bones,
    limits,
    trees,
    count: Math.min(count, capacity),
    capacity,
    seed: intOption('seed', 1, 0, 0x7fffffff),
    textures: intOption('textures', 5, 0, 5),
    // Language of the debug panel (#debug): en (default) or es
    lang: query.get('lang') === 'es' ? 'es' : 'en'
}

/**
 * Reload the page with some URL options changed, e.g. reloadWith({ trees: 4 }).
 * Leaf counts go back to their defaults, which depend on the number of trees.
 * Changing the kind of tree also drops ?glb=, back to the demo's GLB.
 */
export function reloadWith(changes)
{
    const next = new URLSearchParams(window.location.search)
    for(const [key, value] of Object.entries(changes)) next.set(key, String(value))
    // A new kind of tree means the demo's own models: a ?glb= of another file
    // may not have the armature the kind asks for
    if('tree' in changes || 'bones' in changes) next.delete('glb')
    if('trees' in changes || 'bones' in changes)
    {
        next.delete('count')
        next.delete('maxCount')
    }
    window.location.search = next.toString()
}

/**
 * The demo's leaf textures (public/textures/leaves/), with how often each one
 * appears. Five conifer sprigs cut from a reference photo.
 */
export const leafTextures = [
    { name: 'variant1', weight: 30, url: './textures/leaves/leaf_variant_1.webp' }, // dark green, dense
    { name: 'variant2', weight: 25, url: './textures/leaves/leaf_variant_2.webp' }, // olive green, thin and sparse
    { name: 'variant3', weight: 20, url: './textures/leaves/leaf_variant_3.webp' }, // blue green, compact
    { name: 'variant4', weight: 15, url: './textures/leaves/leaf_variant_4.webp' }, // green and yellow, dry
    { name: 'variant5', weight: 10, url: './textures/leaves/leaf_variant_5.webp' } // grey green, cold and aged
]

/**
 * Scene settings of the demo itself (not part of the library).
 */
export const sceneParams = {
    shadows: true
}
