import * as THREE from 'three/webgpu'
import { Fn, PI, dFdx, dFdy, dot, float, hash, instanceIndex, instancedBufferAttribute, int, log2, max, min, mix, normalLocal, normalize, positionLocal, select, sin, smoothstep, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { createBoneNodes, quatRotate } from '../utils/tsl.js'
import { leafTextureSize } from './leafTextures.js'

/**
 * Draws the leaves and, for debugging, the anchors.
 *
 * Leaves: one instanced Mesh (a plane, subdivided when it curves) for all the
 * particles. The vertex shader only reads what the simulation wrote: world
 * position, scale, orientation and whether it has landed. It knows nothing
 * about bones.
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

// Leaf textures: alpha gained per mipmap level, so thin leaves seen from afar
// or edge-on keep their coverage instead of averaging out below alphaTest.
// Higher values fill distant crowns too much
const MIP_ALPHA_SCALE = 0.12

// Built-in leaf, in plane units (the plane is 0.6 wide and 1 tall, stem at the bottom centre)
const BUILT_IN_ASPECT = 0.6
const BLADE_START = 0.1 // where the stem becomes the blade
const BLADE_END = 0.98 // tip
const BLADE_HALF_WIDTH = 0.19 // at its widest, about a third of the way up
const EDGE = 0.012 // soft edge, for alphaToCoverage
const STEM_HALF_WIDTH = 0.011

// Curved leaf: enough to bend along the leaf and to fold it across its midrib,
// at 12 triangles against the 2 of a flat one
const CURVE_COLUMNS = 2
const CURVE_ROWS = 3

const lockToWorld = (object) =>
{
    object.matrixAutoUpdate = false
    object.matrixWorldAutoUpdate = false
    object.matrix.identity()
    object.matrixWorld.identity()
    return object
}

/**
 * A unit plane whose origin is the bottom edge: the leaf grows out of its
 * anchor. Its width and curve are set per leaf in the vertex shader.
 */
const createLeafPlane = (columns, rows) => new THREE.PlaneGeometry(1, 1, columns, rows).translate(0, 0.5, 0)

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
            color: uniform(new THREE.Color(0x4f7a3a)), // built-in leaf only
            curve: uniform(0)
        }

        this.flatGeometry = createLeafPlane(1, 1)
        this.curvedGeometry = createLeafPlane(CURVE_COLUMNS, CURVE_ROWS)

        // Texture of each leaf, as a per-instance attribute (only needed to choose between several)
        this.variant = textures.length > 1
            ? instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(variants), 1))
            : null

        this.leaves = lockToWorld(this.createLeaves(simulation, textures, aspects))
        this.anchors = lockToWorld(this.createAnchors(simulation, boneState, sway))
    }

    /**
     * How far the leaves bend, as a fraction of their height. At 0 they use the
     * flat plane, so a scene that doesn't need the curve doesn't pay for it.
     */
    setCurve(curve)
    {
        this.uniforms.curve.value = curve
        this.leaves.geometry = curve > 0 ? this.curvedGeometry : this.flatGeometry
    }

    dispose()
    {
        this.flatGeometry.dispose()
        this.curvedGeometry.dispose()
        this.leaves.material.dispose()
        this.anchors.material.dispose() // a Sprite's geometry is shared by every sprite: not ours to dispose
    }

    createLeaves(simulation, textures, aspects)
    {
        const u = this.uniforms

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

            // Curve, in leaf units: the normal comes from the same surface
            const curve = this.createCurveAmount(orientation, simulation.state.element(instanceIndex).z)
            const x = positionLocal.x
            const y = positionLocal.y
            positionLocal.z.assign(curve.mul(y.mul(y).add(x.mul(x).mul(4))))
            normalLocal.assign(normalize(vec3(curve.mul(x).mul(-8), curve.mul(y).mul(-2), 1)))

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
        const leafColor = textures.length > 0 ? this.createTextureColor(textures) : this.createLeafShape()

        // The alpha travels in colorNode so the shadow pass sees it too, and the
        // mask cuts the shadow to the shape of the leaf instead of its rectangle
        material.colorNode = vec4(mix(leafColor.rgb, stateColor.toVertexStage(), u.stateColors), leafColor.a)
        material.alphaTest = 0.5
        material.maskShadowNode = leafColor.a.greaterThan(0.5)

        const mesh = new THREE.Mesh(this.flatGeometry, material)
        mesh.name = 'leaves'
        mesh.count = simulation.count
        mesh.frustumCulled = false // positions only exist on the GPU

        return mesh
    }

    /**
     * How far this leaf bends along its normal (+Z), with its sign. The tip and
     * edges bend towards the ground whichever face looks up, so the sign follows
     * the face. It fades through 0 when the leaf stands on edge, instead of
     * flipping: a tumbling leaf flexes rather than pops.
     *
     * Landed leaves lie with +Z up and bend upwards: they keep their curve, resting
     * on the stem and midrib, and no part of them goes under the ground.
     */
    createCurveAmount(orientation, landed)
    {
        // World height of the leaf's +Z: the matrix element (1, 2) of the quaternion
        const faceUp = orientation.y.mul(orientation.z).sub(orientation.w.mul(orientation.x)).mul(2)
        const droop = faceUp.mul(3).clamp(-1, 1).negate()
        const direction = select(landed.greaterThan(0.5), float(1), droop)
        const variation = mix(0.6, 1.4, hash(instanceIndex.add(3163)))

        return this.uniforms.curve.mul(variation).mul(direction)
    }

    /**
     * Color and alpha from the leaf textures, the leaf's own one.
     *
     * A small or edge-on leaf is sampled from a coarse mipmap, where thin
     * needles average out to a low alpha and alphaTest drops the whole leaf
     * (leaves on the ground vanish when seen from low down). So the alpha is
     * raised with the mipmap level the GPU is reading: unchanged up close,
     * x1.5 four levels down. The level comes from how many texels one pixel
     * spans along each screen axis, as the GPU works it out, taking the
     * texture's anisotropic filtering into account.
     */
    createTextureColor(textures)
    {
        const color = this.selectVariant(textures.map((map) => texture(map, uv())))
        const size = this.selectVariant(textures.map((map, index) => vec2(...leafTextureSize(map, index))))
        const anisotropy = this.selectVariant(textures.map((map) => float(Math.max(map.anisotropy, 1))))

        const texels = uv().mul(size)
        const dx = dFdx(texels)
        const dy = dFdy(texels)
        const major = max(dot(dx, dx), dot(dy, dy)).sqrt()
        const minor = min(dot(dx, dx), dot(dy, dy)).sqrt().max(1e-6)
        const footprint = major.div(min(major.div(minor), anisotropy))
        const level = log2(footprint.max(1e-6)).max(0)

        return vec4(color.rgb, color.a.mul(level.mul(MIP_ALPHA_SCALE).add(1)).min(1))
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
