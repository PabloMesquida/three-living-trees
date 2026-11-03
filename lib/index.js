/**
 * tree-demo: trees whose leaves grow, fall and grow back, simulated on the GPU
 * with Three.js WebGPU. Start with LeafTree.create(); the rest is for custom
 * setups and debug tools.
 */
export { LeafTree, DEFAULT_PARAMS } from './LeafTree.js'
export { DEFAULT_LEAF_TEXTURES, loadLeafTextures } from './leaves/leafTextures.js'
export { LeafSimulation, STATE_ATTACHED, STATE_FALLING, STATE_GROWING, spontaneousChance } from './leaves/LeafSimulation.js'
export { buildTreeAsset, ROLE_STATIC, ROLE_TRUNK, ROLE_BRANCH } from './tree/TreeAsset.js'
export { loadTreeScene } from './tree/loadTree.js'
export { DEFAULT_ORIENTATION } from './anchors/AnchorSet.js'
