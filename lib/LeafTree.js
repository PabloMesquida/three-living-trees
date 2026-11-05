import * as THREE from 'three/webgpu'
import { buildTreeAsset } from './tree/TreeAsset.js'
import { TreeSway } from './tree/TreeSway.js'
import { loadTreeScene } from './tree/loadTree.js'
import { BranchRig } from './rig/BranchRig.js'
import { BoneState } from './rig/BoneState.js'
import { generateAnchors, orientAnchors } from './anchors/AnchorSet.js'
import { LeafSimulation, spontaneousChance } from './leaves/LeafSimulation.js'
import { LeafRenderer } from './leaves/LeafRenderer.js'
import { checkLeafTextures, leafTextureAspect, loadLeafTextures } from './leaves/leafTextures.js'
import { assignVariants } from './leaves/textureVariants.js'
import { PointerInteraction } from './interaction/PointerInteraction.js'

/**
 * A tree whose leaves grow on its branches, come loose, fall with gravity and
 * wind, and grow back. Rigged trees sway when the pointer shakes them; static
 * trees (no bones) sway in the wind, in the vertex shader, and the pointer
 * pushes them too.
 *
 *     const tree = await LeafTree.create(renderer, { url: './models/tree.glb' })
 *     scene.add(tree.object)
 *     tree.enablePointer(canvas, camera) // optional
 *
 *     renderer.setAnimationLoop(() =>
 *     {
 *         tree.update(timer.getDelta())
 *         renderer.render(scene, camera)
 *     })
 *
 * The leaves hang from `tree.object` (the tree's root) but live in world
 * space, so the tree can be moved, rotated and scaled like any other object.
 *
 * Needs a WebGPURenderer running on WebGPU: the leaves are simulated in
 * compute shaders and there is no WebGL path.
 */

export const DEFAULT_PARAMS = {
    // Tree
    treeMotion: true, // the pointer can push the branches (rigged) or the whole tree (static)
    motionStrength: 1,
    sway: 1, // static trees: wind sway, 0 = still, 1 = the crown leans about 3 % of the tree height
    swaySpeed: 1, // static trees: 1 = normal, 2 = twice as fast

    // Leaves
    leafCount: 5000, // leaves shown, from 0 to the capacity
    leafFall: true,
    spontaneousFall: 0, // 0..1: leaves falling on their own, from one at a time (low) to all together (1)
    regeneration: true,
    detachProbability: 0.25, // chance per decision tick for a leaf whose branch shakes past its grip
    detachThreshold: 0.5, // branch shake (rad/s) under which no leaf lets go; static trees: bending rate of the sway
    gripVariation: 0.5, // each leaf needs between 1x and (1 + this)x the threshold
    gravity: 4,
    windStrength: 0.6,
    windAngle: 20, // degrees around Y, 0 = +X: falling leaves and the sway of static trees
    growDuration: 1.5,
    leafSize: 0.17, // relative to a 3.6 m tree: the leaves scale with the tree
    leafColor: '#4f7a3a', // built-in leaf only (no textures): any THREE.Color value
    leafCurve: 0.15, // how far the tip bends, as a fraction of the leaf's height; 0 = flat, and cheaper

    // Leaf orientation (sampled anchors), see orientAnchors() in anchors/AnchorSet.js
    leafAngle: 40, // degrees from the branch axis: 0 = along the branch, 90 = straight out
    leafAngleVariation: 12,
    leafRoll: 0, // degrees around the leaf's own axis
    leafRollVariation: 25,
    leafUpward: 0.2, // 0..1, bend towards the sky

    // Debug views
    showAnchors: false,
    stateColors: false
}

const MAX_DELTA = 1 / 30
const DEFAULT_CAPACITY = 10000

const _scale = new THREE.Vector3()
const _ground = new THREE.Vector3()

const warnedRenderers = new WeakSet()

/**
 * The leaves use alphaToCoverage, so their edges write an alpha below 1 to the
 * canvas. With WebGPURenderer's default (alpha: true, a premultiplied canvas)
 * the page shows through those pixels as thin lines. Once per renderer: a
 * forest would repeat it for every tree.
 */
function warnAboutCanvasAlpha(renderer)
{
    if(renderer.alpha !== true || warnedRenderers.has(renderer)) return
    warnedRenderers.add(renderer)

    console.warn('[tree] El renderer usa alpha: true (su valor por defecto): el fondo de la página se ve a través de los bordes de las hojas, como líneas finas. Créalo con new WebGPURenderer({ alpha: false }), salvo que quieras el canvas transparente.')
}

export class LeafTree
{
    /**
     * Options (all optional except `url` or `object`):
     *
     *   url            GLB to load
     *   object         an Object3D already loaded (e.g. a node of a bigger GLB), instead of url
     *   textures       1 to 5 leaf textures, [{ url | texture, weight, name }]: PNG or WebP
     *                  with alpha, stem at the bottom centre, any proportion (each leaf
     *                  takes its texture's width / height). A `texture` must be loaded and
     *                  is used as it is (set its colorSpace to SRGBColorSpace). None, or [],
     *                  draws a built-in leaf shape colored by params.leafColor
     *   count          leaves shown at the start (default 5000)
     *   capacity       most leaves the GPU buffers hold, the top of leafCount (default 10000)
     *   seed           same seed, same tree: anchors, textures, rig tuning, sway phase (default 1)
     *   branchRadius   static trees: thickest branch (metres) that carries leaves (default: automatic)
     *   groundY        world height where leaves land (default: the base of the tree)
     *   castShadow     tree and leaves cast shadows (default true)
     *   receiveShadow  tree and leaves receive shadows (default true)
     *   params         initial values for DEFAULT_PARAMS
     */
    static async create(renderer, options = {})
    {
        const { url, object } = options
        if(Boolean(url) === Boolean(object))
            throw new Error('LeafTree.create necesita `url` (un GLB) o `object` (un Object3D ya cargado), uno de los dos.')

        await renderer.init()
        if(renderer.backend?.isWebGPUBackend !== true)
            throw new Error('LeafTree necesita un WebGPURenderer funcionando con WebGPU: las hojas se simulan en compute shaders y no hay modo WebGL.')
        warnAboutCanvasAlpha(renderer)

        const textureList = checkLeafTextures(options.textures)
        const [root, textures] = await Promise.all([
            object ?? loadTreeScene(url),
            loadLeafTextures(textureList, renderer)
        ])

        return new this(renderer, root, { ...options, textures: textureList, loadedTextures: textures, source: url ?? object.name ?? 'Object3D' })
    }

    /**
     * Use LeafTree.create(): it loads what this needs and checks the renderer.
     */
    constructor(renderer, root, options)
    {
        const {
            textures,
            loadedTextures,
            source,
            count = DEFAULT_PARAMS.leafCount,
            capacity = Math.max(count, DEFAULT_CAPACITY),
            seed = 1,
            branchRadius = null,
            groundY = null,
            castShadow = true,
            receiveShadow = true,
            params = {}
        } = options

        this.renderer = renderer
        this.object = root
        this.groundY = groundY
        this.pointer = null
        this.textures = loadedTextures
        this.ownTextures = textures.map((entry) => typeof entry !== 'object' || !entry.texture)
        const aspects = loadedTextures.map(leafTextureAspect)

        // Tree -> anchors -> rig -> particles
        const asset = this.createAsset(root, source, options)
        this.asset = asset

        for(const mesh of asset.meshes)
        {
            mesh.castShadow = castShadow
            mesh.receiveShadow = receiveShadow
        }

        // Anchors for the full capacity. They are independent random samples,
        // so the first N of them are an even spread too: showing fewer leaves
        // just shows a prefix. Explicit anchors fix the capacity instead.
        this.anchors = this.createAnchors(asset, capacity, seed, branchRadius)

        this.params = { ...DEFAULT_PARAMS, leafCount: count, ...params }
        this.params.leafCount = Math.min(this.params.leafCount, this.anchors.count / this.treeCount)

        this.rig = new BranchRig(asset, seed)
        this.boneState = new BoneState(asset, this.rig)

        // A static tree sways in its vertex shader instead: bark and leaves share the displacement
        this.sway = null
        if(!asset.rigged)
        {
            this.sway = this.createSway(seed)
            this.sway.applyToMeshes(renderer, asset.meshes)
        }

        this.simulation = new LeafSimulation(renderer, this.anchors, this.boneState, seed, this.sway)

        this.variants = assignVariants(this.anchors.count, textures, seed)
        this.leafRenderer = new LeafRenderer(this.simulation, this.boneState, loadedTextures, this.variants, aspects, this.sway)
        this.leafRenderer.leaves.castShadow = castShadow
        this.leafRenderer.leaves.receiveShadow = receiveShadow
        this.object.add(this.leafRenderer.leaves, this.leafRenderer.anchors)

        this.orientationKey = ''
        this.apply()
    }

    // LeafForest replaces these three
    createAsset(root, source)
    {
        return buildTreeAsset(root, source)
    }

    createAnchors(asset, capacity, seed, branchRadius)
    {
        return generateAnchors(asset, Math.max(1, Math.round(capacity)), seed, { branchRadius })
    }

    createSway(seed)
    {
        return new TreeSway(seed)
    }

    /** How many trees share these leaves: LeafForest has several. */
    get treeCount()
    {
        return 1
    }

    /** True when the tree has an armature and its branches can move. */
    get rigged()
    {
        return this.asset.rigged
    }

    /** The most leaves each tree can show (the top of params.leafCount). */
    get capacity()
    {
        return this.simulation.capacity / this.treeCount
    }

    /** Lines describing what was found in the tree, for the console. */
    get report()
    {
        return [...this.asset.report, ...(this.sway?.report ?? []), `Anclajes: ${this.anchors.count}, ${this.anchors.source}`]
    }

    /**
     * Change parameters (any key of DEFAULT_PARAMS) and apply them at once.
     */
    set(changes)
    {
        Object.assign(this.params, changes)
        this.apply()
    }

    /**
     * Push this.params to the rig, the GPU uniforms and the debug views. Call
     * it after editing this.params directly (set() already does).
     */
    apply()
    {
        const { params, simulation, leafRenderer, rig } = this

        // Leaf orientation: rebuilt only when one of its parameters changed
        const orientation = {
            angle: params.leafAngle,
            angleVariation: params.leafAngleVariation,
            roll: params.leafRoll,
            rollVariation: params.leafRollVariation,
            upward: params.leafUpward
        }
        const key = JSON.stringify(orientation)
        if(key !== this.orientationKey && orientAnchors(this.anchors, orientation))
            simulation.setAnchorQuaternions(this.anchors.quaternion)
        this.orientationKey = key

        simulation.setActiveCount(params.leafCount * this.treeCount)
        leafRenderer.leaves.count = simulation.count
        leafRenderer.anchors.count = simulation.count

        rig.enabled = params.treeMotion
        rig.strength = params.motionStrength

        const u = simulation.uniforms
        const angle = THREE.MathUtils.degToRad(params.windAngle)

        if(this.sway !== null)
        {
            this.sway.enabled = params.treeMotion
            this.sway.strength = params.motionStrength
            this.sway.setWind(angle, params.sway, params.swaySpeed)
        }

        u.fallEnabled.value = params.leafFall ? 1 : 0
        u.regenEnabled.value = params.regeneration ? 1 : 0
        u.detachProbability.value = params.detachProbability
        u.detachThreshold.value = params.detachThreshold
        u.gripSpread.value = params.gripVariation
        u.spontaneousChance.value = spontaneousChance(params.spontaneousFall)
        u.gravity.value = params.gravity
        u.wind.value.set(Math.cos(angle), 0, -Math.sin(angle)).multiplyScalar(params.windStrength)
        u.growDuration.value = params.growDuration

        leafRenderer.uniforms.stateColors.value = params.stateColors ? 1 : 0
        leafRenderer.uniforms.color.value.set(params.leafColor)
        leafRenderer.setCurve(params.leafCurve)
        leafRenderer.anchors.visible = params.showAnchors

        this.updatePlacement()
    }

    /**
     * Leaf size, ground height and sway follow the tree wherever it is placed.
     */
    updatePlacement()
    {
        const { asset, object } = this

        object.getWorldScale(_scale)
        const scale = _scale.y / asset.rootScale
        const base = object.localToWorld(_ground.copy(asset.base))

        this.leafRenderer.uniforms.size.value = this.params.leafSize * (asset.height / 3.6) * scale
        this.simulation.uniforms.groundY.value = this.groundY ?? base.y
        if(this.sway !== null) this.sway.setPlacement(base, asset.height * scale)
    }

    /**
     * Let the pointer shake the tree: the branches of a rigged tree, the
     * whole crown of a static one (a push that decays on its own). Call it
     * once; it returns the PointerInteraction.
     */
    enablePointer(canvas, camera)
    {
        this.disablePointer()
        this.pointer = new PointerInteraction(canvas, camera, this.asset, this.sway ?? this.rig)
        return this.pointer
    }

    disablePointer()
    {
        if(this.pointer === null) return
        this.pointer.dispose()
        this.pointer = null
    }

    /**
     * Advance one frame: pointer, rig or sway, then the leaves. Call it
     * before rendering. deltaTime in seconds; long frames are clamped.
     */
    update(deltaTime)
    {
        const delta = Math.min(Math.max(deltaTime, 0), MAX_DELTA)

        if(this.pointer !== null) this.pointer.update(delta)
        this.rig.update(delta)
        if(this.sway !== null) this.sway.update(delta)
        this.updatePlacement()
        this.simulation.step(delta)
    }

    /** A push on every branch at once (rigged tree) or on the whole crown (static tree). */
    shakeAll(strength)
    {
        if(this.sway !== null) this.sway.shakeAll(strength)
        else this.rig.shakeAll(strength)
    }

    /** Every branch back at rest and every leaf back on its anchor. */
    reset()
    {
        this.rig.reset()
        if(this.sway !== null) this.sway.reset()
        this.simulation.reset()
    }

    /**
     * Leaves per state, read back from the GPU: { attached, falling, growing, total }.
     * Asynchronous and a frame or two late: for debug displays, not every frame.
     */
    readCounts()
    {
        return this.simulation.readCounts()
    }

    /**
     * Free what the tree created. The tree's own meshes stay in the scene graph
     * (they belong to the GLB or to the object that was passed in), with their
     * own materials back.
     */
    dispose()
    {
        this.disablePointer()
        if(this.sway !== null) this.sway.dispose()
        this.object.remove(this.leafRenderer.leaves, this.leafRenderer.anchors)
        this.leafRenderer.dispose()
        this.simulation.dispose()
        this.textures.forEach((texture, index) =>
        {
            if(this.ownTextures[index]) texture.dispose()
        })
    }
}
