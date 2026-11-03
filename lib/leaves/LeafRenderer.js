import * as THREE from 'three/webgpu'
import { Fn, PI, float, hash, instanceIndex, instancedBufferAttribute, int, max, mix, normalLocal, positionLocal, select, sin, smoothstep, texture, uniform, uv, vec3, vec4 } from 'three/tsl'
import { createBoneNodes, quatRotate } from '../utils/tsl.js'

/**
 * Draws the leaves and, for debugging, the anchors.
 *
 * Leaves: one instanced Mesh (a plane, two triangles) for all the particles.
 * The vertex shader only reads what the simulation wrote: world position,
 * scale and orientation. It knows nothing about bones or states.
 * With textures, each leaf shows one of them, chosen once per leaf and passed
 * as a per-instance attribute: one material and one draw call for all of them.
 * The leaf is as tall as its size and as wide as its texture's proportion says
 * (width / height of the image), so textures of any shape can be mixed.
 * Without textures, the leaf shape is drawn from the plane's uv instead.
 *
 * Anchors: instanced sprites placed at bone matrix * anchor, straight from the
 * bone uniforms (plus the sway of a static tree). They show where a leaf will
 * regrow even while it is away.
 *
 * Both work in world space, so they can hang anywhere in the scene graph (the
 * library puts them under the tree's root): their own world matrix is locked
 * to the identity and never inherits a parent's transform.
 */

// Built-in leaf, in plane units (the plane is 0.6 wide and 1 tall, stem at the bottom centre)
const BUILT_IN_ASPECT = 0.6
const BLADE_START = 0.1 // where the stem becomes the blade
const BLADE_END = 0.98 // tip
const BLADE_HALF_WIDTH = 0.19 // at its widest, about a third of the way up
const EDGE = 0.012 // soft edge, for alphaToCoverage
const STEM_HALF_WIDTH = 0.011

const lockToWorld = (object) =>
{
    object.matrixAutoUpdate = false
    object.matrixWorldAutoUpdate = false
    object.matrix.identity()
    object.matrixWorld.identity()
    return object
}

export class LeafRenderer
{
    /**
     * `aspects`: width / height of each texture. `sway`: a static tree's
     * TreeSway, for the anchor view (null when rigged).
     */
    constructor(simulation, boneState, textures, variants, aspects, sway = null)
    {
        this.uniforms = {
            size: uniform(0.17),
            stateColors: uniform(0),
            color: uniform(new THREE.Color(0x4f7a3a)) // built-in leaf only
        }

        // Texture of each leaf, as a per-instance attribute (only needed to choose between several)
        this.variant = textures.length > 1
            ? instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(variants), 1))
            : null

        this.leaves = lockToWorld(this.createLeaves(simulation, textures, aspects))
        this.anchors = lockToWorld(this.createAnchors(simulation, boneState, sway))
    }

    dispose()
    {
        this.leaves.geometry.dispose()
        this.leaves.material.dispose()
        this.anchors.material.dispose() // a Sprite's geometry is shared by every sprite: not ours to dispose
    }

    createLeaves(simulation, textures, aspects)
    {
        const u = this.uniforms

        // A unit plane whose origin is the bottom edge: the leaf grows out of
        // its anchor. Its width is set per leaf in the vertex shader.
        const geometry = new THREE.PlaneGeometry(1, 1)
        geometry.translate(0, 0.5, 0)
        const aspect = textures.length > 0 ? this.selectVariant(aspects.map((value) => float(value))) : float(BUILT_IN_ASPECT)

        // alphaToCoverage keeps the thin needles visible from afar, where
        // mipmapping averages their alpha below any fixed cutout threshold
        const material = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaToCoverage: true })

        material.positionNode = Fn(() =>
        {
            const position = simulation.position.element(instanceIndex)
            const orientation = simulation.orientation.element(instanceIndex)

            // Width: the proportion of the leaf's texture. Then the scale: global
            // size (the height), a fixed per-leaf variation, and the life-cycle scale
            positionLocal.mulAssign(vec3(aspect, 1, 1))
            const variation = mix(0.75, 1.25, hash(instanceIndex.add(9176)))
            positionLocal.mulAssign(u.size.mul(variation).mul(position.w))

            // Rotation, applied to the normal too so the shading follows
            positionLocal.assign(quatRotate(orientation, positionLocal))
            normalLocal.assign(quatRotate(orientation, normalLocal))

            // Translation
            positionLocal.addAssign(position.xyz)

            return positionLocal
        })()

        // Debug view: one flat color per state
        const state = simulation.state.element(instanceIndex).x
        const stateColor = select(
            state.lessThan(0.5),
            vec3(0.25, 0.75, 0.2),
            select(state.lessThan(1.5), vec3(1, 0.5, 0.05), vec3(0.2, 0.75, 1))
        )
        const leafColor = textures.length > 0 ? this.selectVariant(textures.map((map) => texture(map, uv()))) : this.createLeafShape()

        // The alpha travels in colorNode so the shadow pass sees it too, and the
        // mask cuts the shadow to the shape of the leaf instead of its rectangle
        material.colorNode = vec4(mix(leafColor.rgb, stateColor.toVertexStage(), u.stateColors), leafColor.a)
        material.alphaTest = 0.5
        material.maskShadowNode = leafColor.a.greaterThan(0.5)

        const mesh = new THREE.Mesh(geometry, material)
        mesh.name = 'leaves'
        mesh.count = simulation.count
        mesh.frustumCulled = false // positions only exist on the GPU

        return mesh
    }

    /**
     * The leaf's own value out of one per texture: its color and alpha (every
     * texture is sampled and the leaf's own selected: a select, not a branch,
     * keeps the sampling in uniform control flow) or its proportion. With one
     * texture there is nothing to select.
     */
    selectVariant(values)
    {
        if(values.length === 1) return values[0]

        let value = values[values.length - 1]
        for(let i = values.length - 2; i >= 0; i--)
            value = select(this.variant.lessThan(i + 0.5), values[i], value)

        return value
    }

    /**
     * Color and alpha of the built-in leaf, with no image: a lanceolate blade
     * on a short stem, drawn from the plane's uv. One color for the whole tree
     * (uniforms.color), with a fixed per-leaf tint, a darker midrib and a
     * slightly lighter tip.
     */
    createLeafShape()
    {
        const u = this.uniforms

        // x: distance from the midline, y: from the stem (0) to the tip (1)
        const x = uv().x.sub(0.5).mul(BUILT_IN_ASPECT).abs()
        const y = uv().y

        // Blade: widest at about a third of its length, pointed at the tip
        const along = y.sub(BLADE_START).div(BLADE_END - BLADE_START).saturate()
        const halfWidth = sin(along.pow(0.7).mul(PI)).mul(BLADE_HALF_WIDTH)
        const blade = smoothstep(halfWidth.sub(EDGE), halfWidth, x).oneMinus()

        // Stem: a thin stalk from the anchor into the base of the blade
        const stem = smoothstep(STEM_HALF_WIDTH * 0.6, STEM_HALF_WIDTH, x).oneMinus()
            .mul(smoothstep(BLADE_START + 0.04, BLADE_START + 0.08, y).oneMinus())

        // Per leaf: a little brighter or darker, some a touch yellower
        const brightness = mix(0.82, 1.12, hash(instanceIndex.add(5381)))
        const yellowing = hash(instanceIndex.add(7253)).mul(0.3)
        const tint = mix(vec3(1), vec3(1.2, 1.08, 0.55), yellowing).mul(brightness).toVertexStage()

        const midrib = mix(0.7, 1, smoothstep(0.003, 0.012, x))
        const tip = mix(0.88, 1.06, along)

        return vec4(u.color.mul(tint).mul(midrib).mul(tip), max(blade, stem))
    }

    createAnchors(simulation, boneState, sway)
    {
        const bones = createBoneNodes(boneState)

        const material = new THREE.SpriteNodeMaterial({ color: 0xff2e63, depthTest: false })
        const anchor = simulation.anchorData.element(instanceIndex)
        const rest = bones.matrices.element(int(anchor.w)).mul(vec4(anchor.xyz, 1)).xyz
        material.positionNode = sway === null ? rest : rest.add(sway.offset(rest))
        material.scaleNode = uniform(0.03)

        const sprite = new THREE.Sprite(material)
        sprite.name = 'leaf_anchors_debug'
        sprite.count = simulation.count
        sprite.frustumCulled = false
        sprite.renderOrder = 10
        sprite.visible = false

        return sprite
    }
}
