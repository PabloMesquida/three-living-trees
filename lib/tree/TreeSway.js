import * as THREE from 'three/webgpu'
import { Fn, dot, modelWorldMatrix, modelWorldMatrixInverse, positionLocal, sin, uniform, vec3, vec4 } from 'three/tsl'

/**
 * Wind sway of a static tree (no bones), done in the vertex shader.
 *
 * One function, offset(), gives the displacement of any world point of the
 * tree. The bark adds it in its vertex shader (lit pass and shadow pass alike)
 * and the leaf simulation adds it to every anchor, so attached and growing
 * leaves stay exactly on their branch. Falling leaves are free bodies and do
 * not sway: they leave with the speed their branch had.
 *
 *   - The displacement grows with the height above the base of the tree,
 *     as height², so the trunk barely moves and the crown does.
 *   - Along the wind (windAngle): a lean that grows in the gusts plus two
 *     oscillations. Across it, a smaller one. A faster flutter on top.
 *   - The phase changes across the crown, so it bends like a tree and not
 *     like a pendulum, and each tree starts at its own time (from its seed).
 *   - The pointer adds a push: a damped spring on the CPU, decaying on its own.
 *
 * Everything is in world space, so the tree can be moved, rotated and scaled.
 */

// At sway = 1 the crown leans about this fraction of the tree height, on average
const SWAY_SCALE = 0.03

// The whole crown bends as one, without the whip of a rigged branch tip, so
// its bending rate is scaled up to be compared with the same detachThreshold:
// at sway = 2 the strongest gusts reach the default threshold at the top
const SHAKE_GAIN = 2.5

// Pointer push: a damped spring with the whole tree as its mass
const STEP = 1 / 120
const MAX_STEPS = 10
const PUSH_FREQUENCY = 0.7 // Hz
const PUSH_DAMPING = 0.12 // damping ratio
const PUSH_GAIN = 4
const MAX_PUSH = 0.1 // of the tree height, at the top
const SHAKE_KICK = 0.24 // shakeAll(): crown speed per unit of strength, in tree heights per second; strong enough at the default strength to shake the lower branches too
const GOLDEN_ANGLE = 2.39996 // each shakeAll() pushes in a new direction

const _force = new THREE.Vector3()

export class TreeSway
{
    constructor(seed)
    {
        this.enabled = true // the pointer can push
        this.strength = 1
        this.speed = 1

        this.uniforms = {
            time: uniform(0), // seconds scaled by speed, plus the tree's own phase
            previousTime: uniform(0),
            deltaTime: uniform(0),
            amount: uniform(1),
            direction: uniform(new THREE.Vector3(1, 0, 0)), // wind, horizontal unit vector
            base: uniform(new THREE.Vector3()), // bottom centre of the tree, world
            height: uniform(1), // world
            push: uniform(new THREE.Vector3()),
            previousPush: uniform(new THREE.Vector3())
        }

        // Each seed starts the motion at its own point, so trees do not sway in step
        this.startTime = (Math.imul(seed, 2654435761) >>> 0) / 4294967296 * 200
        this.uniforms.time.value = this.startTime
        this.uniforms.previousTime.value = this.startTime

        // Push spring state (world vectors at the top of the tree)
        this.pushVelocity = new THREE.Vector3()
        this.pushForce = new THREE.Vector3()
        this.accumulator = 0
        this.shakes = 0

        this.materials = [] // [mesh, original material]
        this.ownMaterials = []
        this.report = []
    }

    /**
     * Displacement (world) of a world point of the tree at a given time and push.
     */
    displacement(position, time, push)
    {
        const u = this.uniforms
        const relative = position.sub(u.base)

        const height = relative.y.div(u.height).max(0)
        const bend = height.mul(height)

        // Phase across the crown, in tree heights: smooth at the scale of a
        // branch, so a leaf and the bark under it move the same
        const spread = dot(relative, vec3(0.9, 0.35, 0.7)).div(u.height).mul(3)

        // Gusts: a slow envelope from 0 to 1, peaking now and then
        const gust = sin(time.mul(0.21)).mul(sin(time.mul(0.47).add(1.9))).mul(0.5).add(0.5).pow(2)

        const wave = sin(time.mul(1.25).sub(spread)).mul(0.55)
            .add(sin(time.mul(2.7).add(0.8).sub(spread.mul(1.7))).mul(0.2))
        const flutter = sin(time.mul(4.3).add(spread.mul(4.1))).mul(gust.add(0.3)).mul(0.08)
        const along = gust.mul(0.65).add(0.35).add(wave.mul(gust.add(0.5))).add(flutter)
        const across = sin(time.mul(0.83).add(2.1).sub(spread)).mul(0.25)

        const side = vec3(u.direction.z.negate(), 0, u.direction.x)
        const wind = u.direction.mul(along).add(side.mul(across)).mul(u.amount.mul(SWAY_SCALE).mul(u.height))

        return wind.add(push).mul(bend)
    }

    /** Displacement of a world point now: the one bark and leaves share. */
    offset(position)
    {
        return this.displacement(position, this.uniforms.time, this.uniforms.push)
    }

    /**
     * How hard the branch at a world point shakes, compared with
     * detachThreshold like a rigged tree's branch shake: its bending rate
     * (2 * speed / height above the base, for a height² curve, in rad/s)
     * times SHAKE_GAIN. Measured between the previous frame and this one, so
     * moving the tree itself does not count.
     */
    shake(position)
    {
        const u = this.uniforms
        const now = this.displacement(position, u.time, u.push)
        const before = this.displacement(position, u.previousTime, u.previousPush)
        const height = position.y.sub(u.base.y).max(u.height.mul(0.1))

        return now.sub(before).length().div(u.deltaTime.max(0.0001)).mul(2 * SHAKE_GAIN).div(height)
    }

    /**
     * Give the meshes materials that sway. Their own materials are standard
     * ones (MeshStandardMaterial from the GLB, ...) and only Node materials
     * have a positionNode, so each is converted the way the renderer itself
     * does it (renderer.library.fromMaterial: the matching Node material with
     * every property and texture copied over). Node materials are cloned.
     * Each tree gets its own copies: trees cloned from one GLB share materials.
     */
    applyToMeshes(renderer, meshes)
    {
        const converted = new Map()

        const convert = (material) =>
        {
            if(converted.has(material)) return converted.get(material)

            const nodeMaterial = material.isNodeMaterial ? material.clone() : renderer.library.fromMaterial(material)
            if(nodeMaterial === null)
            {
                this.report.push(`AVISO: el material "${material.name || material.type}" no tiene versión Node: esa malla no se mece.`)
                converted.set(material, material)
                return material
            }

            // fromMaterial() copies every own key, the original's listeners and uuid too
            nodeMaterial._listeners = undefined
            nodeMaterial.uuid = THREE.MathUtils.generateUUID()

            const rest = nodeMaterial.positionNode ?? positionLocal
            nodeMaterial.positionNode = Fn(() =>
            {
                const world = modelWorldMatrix.mul(vec4(rest, 1)).xyz
                return rest.add(modelWorldMatrixInverse.mul(vec4(this.offset(world), 0)).xyz)
            })()

            converted.set(material, nodeMaterial)
            this.ownMaterials.push(nodeMaterial)
            return nodeMaterial
        }

        for(const mesh of meshes)
        {
            this.materials.push([mesh, mesh.material])
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material)
        }
    }

    /**
     * Where the tree is: the displacement follows its base and height.
     */
    setPlacement(base, height)
    {
        this.uniforms.base.value.copy(base)
        this.uniforms.height.value = height
    }

    setWind(angle, amount, speed)
    {
        this.uniforms.direction.value.set(Math.cos(angle), 0, -Math.sin(angle))
        this.uniforms.amount.value = amount
        this.speed = speed
    }

    /**
     * Forget the push of the previous frame (the pointer sets a new one).
     */
    clearPush()
    {
        this.pushForce.set(0, 0, 0)
    }

    /**
     * Push the tree at a world point, like BranchRig.applyPush(): `force` is
     * the pointer velocity (m/s). It bends the whole tree, more the higher
     * the point. With a duration it is a kick, applied at once.
     */
    applyPush(boneIndex, point, force, duration = 0)
    {
        if(!this.enabled) return

        const { base, height } = this.uniforms
        const lever = THREE.MathUtils.clamp((point.y - base.value.y) / height.value, 0, 1)

        _force.set(force.x, 0, force.z).multiplyScalar(PUSH_GAIN * this.strength * lever)

        if(duration > 0) this.pushVelocity.addScaledVector(_force, duration)
        else this.pushForce.add(_force)
    }

    /**
     * A kick to the whole crown, like BranchRig.shakeAll() for a rigged tree:
     * the push spring starts at `strength` * SHAKE_KICK tree heights per
     * second, each time in a new direction. Same strength, same shake.
     */
    shakeAll(strength = 2.2)
    {
        const angle = this.shakes++ * GOLDEN_ANGLE
        _force.set(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(strength * SHAKE_KICK * this.uniforms.height.value)
        this.pushVelocity.add(_force)
    }

    /**
     * Advance the wind and the push. Before the leaf simulation step, which
     * reads both the current and the previous values.
     */
    update(deltaTime)
    {
        const u = this.uniforms

        u.previousTime.value = u.time.value
        u.time.value += deltaTime * this.speed
        u.deltaTime.value = deltaTime
        u.previousPush.value.copy(u.push.value)

        const omega = Math.PI * 2 * PUSH_FREQUENCY
        const limit = MAX_PUSH * u.height.value
        const push = u.push.value

        this.accumulator += deltaTime
        let steps = 0
        while(this.accumulator >= STEP && steps < MAX_STEPS)
        {
            this.pushVelocity
                .addScaledVector(push, -omega * omega * STEP)
                .addScaledVector(this.pushVelocity, -2 * PUSH_DAMPING * omega * STEP)
                .addScaledVector(this.pushForce, STEP)
            push.addScaledVector(this.pushVelocity, STEP)

            if(push.length() > limit)
            {
                push.setLength(limit)
                this.pushVelocity.multiplyScalar(0.6)
            }

            this.accumulator -= STEP
            steps++
        }
        if(steps === MAX_STEPS) this.accumulator = 0
    }

    /** Back at rest: no push, and the wind from the tree's starting time. */
    reset()
    {
        const u = this.uniforms
        u.time.value = this.startTime
        u.previousTime.value = this.startTime
        u.deltaTime.value = 0
        u.push.value.set(0, 0, 0)
        u.previousPush.value.set(0, 0, 0)
        this.pushVelocity.set(0, 0, 0)
        this.pushForce.set(0, 0, 0)
        this.accumulator = 0
        this.shakes = 0
    }

    /** Give the meshes their own materials back. */
    dispose()
    {
        for(const [mesh, material] of this.materials) mesh.material = material
        for(const material of this.ownMaterials) material.dispose()
        this.materials.length = 0
        this.ownMaterials.length = 0
    }
}
