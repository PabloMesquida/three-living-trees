import * as THREE from 'three/webgpu'
import { instancedArray, int } from 'three/tsl'
import { GOLDEN_ANGLE, PushSpring, TreeSway } from './TreeSway.js'

/**
 * The wind sway of many trees at once, for LeafForest: the same motion as
 * TreeSway, with what differs per tree in one storage buffer instead of
 * uniforms. The bark finds its tree by instanceIndex and the leaves by their
 * anchor's "bone", which is the tree.
 *
 * Three vec4 per tree:
 *
 *     base.xyz (world), height (world)
 *     push.xyz, phase (each tree sways from its own time)
 *     previous push.xyz, ground height (where its leaves land)
 *
 * Springs only exist for trees being pushed, so a forest at rest costs nothing
 * on the CPU and uploads nothing.
 */

const FIELDS = 3
const STRIDE = FIELDS * 4
const SETTLED = 1e-4 // of the tree height

const _push = new THREE.Vector3()

export class ForestSway extends TreeSway
{
    constructor(seed, treeCount)
    {
        super(seed)

        this.treeCount = treeCount
        this.springs = new Map() // tree index -> PushSpring

        this.trees = instancedArray(new Float32Array(treeCount * STRIDE), 'vec4')
        this.data = this.trees.value.array

        // The same scattering as TreeSway's seed, so trees do not sway in step
        for(let i = 0; i < treeCount; i++)
            this.data[i * STRIDE + 7] = (Math.imul(seed + i, 2654435761) >>> 0) / 4294967296 * 200

        this.upload()
    }

    upload()
    {
        this.trees.value.needsUpdate = true
    }

    treeNodes(tree)
    {
        const u = this.uniforms
        const index = int(tree).mul(FIELDS)
        const placement = this.trees.element(index)
        const motion = this.trees.element(index.add(1))
        const previous = this.trees.element(index.add(2))

        return {
            base: placement.xyz,
            height: placement.w,
            time: u.time.add(motion.w),
            previousTime: u.previousTime.add(motion.w),
            push: motion.xyz,
            previousPush: previous.xyz
        }
    }

    treeValues(tree)
    {
        const { data } = this
        const i = tree * STRIDE

        return {
            base: new THREE.Vector3(data[i], data[i + 1], data[i + 2]),
            height: data[i + 3],
            time: this.uniforms.time.value + data[i + 7],
            push: new THREE.Vector3(data[i + 4], data[i + 5], data[i + 6])
        }
    }

    ground(tree)
    {
        return this.trees.element(int(tree).mul(FIELDS).add(2)).w
    }

    /** uniforms.height holds the height of the template, the tree at scale 1. */
    leafScale(tree)
    {
        return this.trees.element(int(tree).mul(FIELDS)).w.div(this.uniforms.height)
    }

    /**
     * Where one tree is: its base and height, and where its leaves land.
     */
    setTreePlacement(tree, base, height, groundY)
    {
        const { data } = this
        const i = tree * STRIDE

        data[i] = base.x
        data[i + 1] = base.y
        data[i + 2] = base.z
        data[i + 3] = height
        data[i + 11] = groundY
    }

    clearPush()
    {
        for(const spring of this.springs.values()) spring.force.set(0, 0, 0)
    }

    springOf(tree)
    {
        let spring = this.springs.get(tree)
        if(spring === undefined)
        {
            spring = new PushSpring()
            this.springs.set(tree, spring)
        }
        return spring
    }

    /** Push one tree at a world point, like TreeSway.applyPush(). */
    applyPush(tree, point, force, duration = 0)
    {
        if(!this.enabled) return

        const i = tree * STRIDE
        const lever = THREE.MathUtils.clamp((point.y - this.data[i + 1]) / this.data[i + 3], 0, 1)

        this.springOf(tree).applyForce(force, this.strength * lever, duration)
    }

    /** A kick to every crown, each tree towards its own direction. */
    shakeAll(strength = 2.2)
    {
        const turn = this.shakes++ * GOLDEN_ANGLE

        for(let tree = 0; tree < this.treeCount; tree++)
            this.springOf(tree).kick(turn + tree * GOLDEN_ANGLE, strength, this.data[tree * STRIDE + 3])
    }

    update(deltaTime)
    {
        const u = this.uniforms

        u.previousTime.value = u.time.value
        u.time.value += deltaTime * this.speed
        u.deltaTime.value = deltaTime

        if(this.springs.size === 0) return

        for(const [tree, spring] of this.springs)
        {
            const i = tree * STRIDE
            const height = this.data[i + 3]
            const settled = SETTLED * height

            spring.update(deltaTime, height)

            // At rest: to zero, and kept one more frame so "previous" gets there too
            if(spring.force.lengthSq() === 0 && spring.velocity.length() < settled && spring.push.length() < settled)
            {
                spring.velocity.set(0, 0, 0)
                spring.push.set(0, 0, 0)
                if(spring.previous.lengthSq() === 0) this.springs.delete(tree)
            }

            spring.push.toArray(this.data, i + 4)
            spring.previous.toArray(this.data, i + 8)
        }

        this.upload()
    }

    reset()
    {
        super.reset()
        this.springs.clear()

        for(let tree = 0; tree < this.treeCount; tree++)
        {
            const i = tree * STRIDE
            _push.set(0, 0, 0).toArray(this.data, i + 4)
            _push.toArray(this.data, i + 8)
        }

        this.upload()
    }
}
