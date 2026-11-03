import * as THREE from 'three/webgpu'

/**
 * Turns pointer movement over the tree into pushes on the rig (rigged tree)
 * or on the sway (static tree): anything with applyPush() and clearPush().
 *
 * Every frame a ray is cast against the tree's pick meshes (skinned, so the
 * hit follows the bent branches; a static tree is picked at rest, the sway
 * moves it a few centimetres at most). The hit triangle gives the bone, and
 * the pointer's screen motion, taken to world space at the hit distance,
 * gives the direction and strength of the push.
 */

const MAX_SPEED = 6 // m/s, so a flick across the screen cannot explode the rig
const ENTER_SPEED = 1.6 // minimum speed of the kick when the pointer enters the tree
const ENTER_DURATION = 1 / 30
const SMOOTHING = 18

const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _motion = new THREE.Vector3()
const _kick = new THREE.Vector3()

export class PointerInteraction
{
    constructor(canvas, camera, asset, rig)
    {
        this.camera = camera
        this.asset = asset
        this.rig = rig

        this.raycaster = new THREE.Raycaster()
        this.pointer = new THREE.Vector2()
        this.previousPointer = new THREE.Vector2()
        this.velocity = new THREE.Vector3() // world space, smoothed
        this.inside = false // pointer over the canvas
        this.hasPrevious = false
        this.intersections = []

        // Exposed for the debug overlay
        this.hovering = false
        this.hoveredBone = -1

        const onMove = (event) =>
        {
            const rect = canvas.getBoundingClientRect()
            this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
            this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
            this.inside = true
        }

        const onLeave = () =>
        {
            this.inside = false
            this.hasPrevious = false
        }

        canvas.addEventListener('pointermove', onMove)
        canvas.addEventListener('pointerdown', onMove)
        canvas.addEventListener('pointerleave', onLeave)

        this.dispose = () =>
        {
            canvas.removeEventListener('pointermove', onMove)
            canvas.removeEventListener('pointerdown', onMove)
            canvas.removeEventListener('pointerleave', onLeave)
            rig.clearPush()
        }
    }

    update(deltaTime)
    {
        const { rig, camera, raycaster, pointer } = this

        rig.clearPush()

        const wasHovering = this.hovering
        this.hovering = false
        this.hoveredBone = -1

        if(!this.inside || deltaTime <= 0) return

        // Pick
        this.intersections.length = 0
        raycaster.setFromCamera(pointer, camera)
        raycaster.intersectObjects(this.asset.pickMeshes, false, this.intersections)

        const hit = this.intersections[0]

        if(hit !== undefined)
        {
            // Pointer motion in world units at the hit distance
            const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * hit.distance
            const halfWidth = halfHeight * camera.aspect
            const dx = this.hasPrevious ? pointer.x - this.previousPointer.x : 0
            const dy = this.hasPrevious ? pointer.y - this.previousPointer.y : 0

            _right.setFromMatrixColumn(camera.matrixWorld, 0)
            _up.setFromMatrixColumn(camera.matrixWorld, 1)
            _motion.set(0, 0, 0)
                .addScaledVector(_right, dx * halfWidth)
                .addScaledVector(_up, dy * halfHeight)
                .divideScalar(deltaTime)
                .clampLength(0, MAX_SPEED)

            this.velocity.lerp(_motion, 1 - Math.exp(-SMOOTHING * deltaTime))

            const boneIndex = this.boneFromHit(hit)
            this.hovering = true
            this.hoveredBone = boneIndex

            rig.applyPush(boneIndex, hit.point, this.velocity)

            // Entering the tree always produces a reaction, even at a crawl
            if(!wasHovering)
            {
                _kick.copy(_motion)
                if(_kick.lengthSq() < 1e-6) _kick.copy(_right)
                _kick.setLength(Math.max(_kick.length(), ENTER_SPEED))
                rig.applyPush(boneIndex, hit.point, _kick, ENTER_DURATION)
            }
        }
        else
        {
            this.velocity.set(0, 0, 0)
        }

        this.previousPointer.copy(pointer)
        this.hasPrevious = true
    }

    /**
     * The bone with the largest skin weight on the first vertex of the hit
     * face. A static tree has one "bone", its root.
     */
    boneFromHit(hit)
    {
        const mesh = hit.object
        if(!mesh.isSkinnedMesh) return 0

        const { skinIndex, skinWeight } = mesh.geometry.attributes
        const vertex = hit.face.a

        let best = 0
        for(let k = 1; k < 4; k++)
        {
            if(skinWeight.getComponent(vertex, k) > skinWeight.getComponent(vertex, best)) best = k
        }

        return this.asset.boneIndex.get(mesh.skeleton.bones[skinIndex.getComponent(vertex, best)])
    }
}
