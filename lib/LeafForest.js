import * as THREE from 'three/webgpu'
import { LeafTree, DEFAULT_PARAMS } from './LeafTree.js'
import { generateAnchors, repeatAnchors } from './anchors/AnchorSet.js'
import { ForestSway } from './tree/ForestSway.js'
import { ROLE_STATIC, buildTreeAsset } from './tree/TreeAsset.js'
import { branchLevels } from './tree/branchLevels.js'
import { stripBones } from './tree/stripBones.js'

/**
 * Many copies of one static tree, drawn and simulated as one:
 *
 *     const forest = await LeafForest.create(renderer, {
 *         url: './models/tree.glb',
 *         transforms: [matrixA, matrixB, objectC] // one per tree
 *     })
 *     scene.add(forest.object)
 *
 *     // in the loop: the camera chooses each tree's detail
 *     forest.update(deltaTime, camera)
 *
 * It has the LeafTree API (set, update, enablePointer, shakeAll, reset...) and
 * costs a few draw calls and one compute dispatch, however many trees there are.
 *
 *   - The bark is an InstancedMesh per mesh of the tree and level of detail.
 *     Each frame, each tree is left out if the camera can't see it (or its
 *     shadow, more or less), or goes to the level its size on screen asks for.
 *     The levels are the tree without its thinnest branches (branchLevels.js).
 *   - There is one leaf simulation, in which each tree is a static "bone": the
 *     anchors are the tree's, repeated, and each leaf follows its tree's
 *     matrix. Each tree shows its own part of them, so copies don't look alike.
 *     All the leaves are always drawn.
 *   - What differs per tree (place, sway phase, push) is in ForestSway's buffer.
 *
 * Trees don't have bones here: a rigged GLB is stripped as it loads. Options
 * and params are LeafTree's, with `count` and `capacity` per tree.
 */

export const MAX_FOREST_TREES = 1024 // the bone uniform arrays: 64 KB of mat4
const DEFAULT_LEAVES = 20000 // in the whole forest, when `count` isn't given
const DEFAULT_LOD_TRIANGLES = [0.25, 0.08]
const DEFAULT_LOD_SCREEN = [0.5, 0.2]
const DEFAULT_CULL_MARGIN = 1.5
const HYSTERESIS = 0.9 // a tree goes back up only past this much of the way: no flicker at the border
const CULLED = -1

const _base = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _centre = new THREE.Vector3()
const _camera = new THREE.Vector3()
const _sphere = new THREE.Sphere()
const _frustum = new THREE.Frustum()
const _viewProjection = new THREE.Matrix4()
const _relative = new THREE.Matrix4()
const _matrix = new THREE.Matrix4()

export class LeafForest extends LeafTree
{
    /**
     * Options: those of LeafTree.create(), plus
     *
     *   transforms    one per tree, a Matrix4 or an Object3D (its position, rotation
     *                 and scale). They stand in for the transform of the tree's
     *                 root, relative to forest.object
     *   count         leaves shown per tree (default: 20000 between all of them)
     *   capacity      most leaves per tree the GPU buffers hold (default: count)
     *   groundY       world height where leaves land (default: the base of each tree)
     *   lodTriangles  the share of the triangles each lower level keeps (default [0.25, 0.08])
     *   lodScreen     the tree's height, as a share of the screen's, below which it
     *                 goes to each of those levels (default [0.5, 0.2]). [] always
     *                 uses the full tree
     *   cullMargin    how far outside the view a tree stays, in tree heights, so its
     *                 shadow doesn't go away with it (default 1.5). Infinity never
     *                 leaves one out
     */
    static async create(renderer, options = {})
    {
        const { transforms } = options
        if(!Array.isArray(transforms) || transforms.length === 0)
            throw new Error('LeafForest.create necesita `transforms`, una lista con un Matrix4 o un Object3D por árbol.')
        if(transforms.length > MAX_FOREST_TREES)
            throw new Error(`LeafForest admite hasta ${MAX_FOREST_TREES} árboles y se pasaron ${transforms.length}.`)

        const { lodTriangles = DEFAULT_LOD_TRIANGLES, lodScreen = DEFAULT_LOD_SCREEN } = options
        if(lodScreen.length > 0 && lodScreen.length !== lodTriangles.length)
            throw new Error('lodTriangles y lodScreen deben tener un valor por cada nivel.')

        const count = options.count ?? Math.min(DEFAULT_PARAMS.leafCount, Math.floor(DEFAULT_LEAVES / transforms.length))

        return super.create(renderer, { ...options, count, capacity: options.capacity ?? count })
    }

    get treeCount()
    {
        return this.asset.bones.length
    }

    /**
     * The tree in the file becomes a template, and the asset that LeafTree works
     * with is the whole forest: a group with a static bone per tree.
     */
    createAsset(root, source, options)
    {
        const {
            transforms,
            lodTriangles = DEFAULT_LOD_TRIANGLES,
            lodScreen = DEFAULT_LOD_SCREEN,
            cullMargin = DEFAULT_CULL_MARGIN
        } = options

        stripBones(root)

        const template = buildTreeAsset(root, source)
        this.template = template
        this.lodScreen = lodScreen
        this.cullMargin = cullMargin

        const object = new THREE.Group()
        object.name = 'forest'
        this.object = object

        const treeCount = transforms.length
        const bones = transforms.map((transform, index) =>
        {
            const bone = new THREE.Object3D()
            bone.name = `tree ${index + 1}`

            if(transform.isObject3D) transform.updateMatrix()
            const matrix = transform.isObject3D ? transform.matrix : transform
            matrix.decompose(bone.position, bone.quaternion, bone.scale)

            object.add(bone)
            return bone
        })
        object.updateMatrixWorld(true)

        // Each mesh keeps its place in the tree: tree transform * root^-1 * mesh
        root.updateMatrixWorld(true)
        const rootInverse = root.matrixWorld.clone().invert()

        const matricesOf = (mesh) =>
        {
            const matrices = new Float32Array(treeCount * 16)
            _relative.multiplyMatrices(rootInverse, mesh.matrixWorld)
            bones.forEach((bone, tree) => _matrix.multiplyMatrices(bone.matrix, _relative).toArray(matrices, tree * 16))
            return matrices
        }

        // Picking uses every tree, whatever is drawn this frame
        const pickMeshes = template.pickMeshes.map((mesh) =>
        {
            const copies = new THREE.InstancedMesh(mesh.geometry, mesh.material, treeCount)
            copies.name = `${mesh.name} pick`
            copies.visible = false
            copies.instanceMatrix.array.set(matricesOf(mesh))
            object.add(copies)
            return copies
        })

        // The drawn bark: per mesh, one InstancedMesh per level, with the trees on it
        const levelCount = lodScreen.length > 0 ? lodScreen.length + 1 : 1
        const reports = []

        this.bark = template.meshes.map((mesh) =>
        {
            const levels = levelCount > 1 ? branchLevels(mesh.geometry, lodTriangles) : []

            const copies = Array.from({ length: levelCount }, (_, level) =>
            {
                const geometry = new THREE.BufferGeometry()
                for(const [name, attribute] of Object.entries(mesh.geometry.attributes)) geometry.setAttribute(name, attribute)
                geometry.setIndex(level > 0 && levels.length > 0 ? new THREE.BufferAttribute(levels[level - 1].index, 1) : mesh.geometry.index)
                for(const group of mesh.geometry.groups) geometry.addGroup(group.start, group.count, group.materialIndex)
                geometry.setAttribute('treeId', new THREE.InstancedBufferAttribute(new Float32Array(treeCount), 1).setUsage(THREE.DynamicDrawUsage))

                const instanced = new THREE.InstancedMesh(geometry, mesh.material, treeCount)
                instanced.name = `${mesh.name} ${level}`
                instanced.frustumCulled = false // done per tree
                instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
                object.add(instanced)

                return instanced
            })

            const triangles = (geometry) => (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3
            reports.push(copies.map((instanced) => triangles(instanced.geometry)).join(' > '))

            return { copies, matrices: matricesOf(mesh) }
        })

        this.levels = new Int8Array(treeCount).fill(0)
        this.spheres = new Float32Array(treeCount * 4)
        this.heights = new Float32Array(treeCount)
        this.drawLevels()

        // The tree's bounding sphere, in the root's space, for leaving trees out
        const box = new THREE.Box3()
        for(const mesh of template.meshes)
        {
            if(mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox()
            box.union(mesh.geometry.boundingBox.clone().applyMatrix4(_relative.multiplyMatrices(rootInverse, mesh.matrixWorld)))
        }
        this.treeSphere = box.getBoundingSphere(new THREE.Sphere())

        // Where the whole forest is, relative to forest.object
        this.localBounds = new THREE.Box3()
        for(const bone of bones) this.localBounds.union(box.clone().applyMatrix4(bone.matrix))

        return {
            ...template,
            root: object,
            rigged: false,
            bones,
            boneIndex: new Map(bones.map((bone, index) => [bone, index])),
            parents: new Int16Array(treeCount).fill(-1),
            roles: new Uint8Array(treeCount).fill(ROLE_STATIC),
            meshes: this.bark.flatMap(({ copies }) => copies),
            pickMeshes,
            report: [...template.report, `Bosque: ${treeCount} árboles, triángulos por nivel de detalle ${reports.join(', ')}`]
        }
    }

    createAnchors(asset, capacity, seed, branchRadius)
    {
        const anchors = generateAnchors(this.template, Math.max(1, Math.round(capacity)), seed, { branchRadius })
        return repeatAnchors(anchors, this.treeCount, seed)
    }

    createSway(seed)
    {
        return new ForestSway(seed, this.treeCount)
    }

    /** The box that holds every tree at rest, in world space. */
    get bounds()
    {
        this.object.updateWorldMatrix(true, false)
        return this.localBounds.clone().applyMatrix4(this.object.matrixWorld)
    }

    /** How many trees are at each level of detail right now, and how many are left out. */
    get levelCounts()
    {
        const counts = { culled: 0, levels: new Array(this.bark[0].copies.length).fill(0), triangles: 0 }

        for(let tree = 0; tree < this.treeCount; tree++)
        {
            if(this.levels[tree] === CULLED) counts.culled++
            else counts.levels[this.levels[tree]]++
        }

        for(const { copies } of this.bark)
            for(const instanced of copies)
                counts.triangles += instanced.count * instanced.geometry.index.count / 3

        return counts
    }

    /**
     * Advance one frame. With a camera, it chooses each tree's level of detail
     * and leaves out those it can't see; without one, they all stay as they are.
     */
    update(deltaTime, camera = null)
    {
        super.update(deltaTime)
        if(camera !== null) this.chooseLevels(camera)
    }

    chooseLevels(camera)
    {
        const { lodScreen, cullMargin, spheres, heights, levels } = this

        camera.updateMatrixWorld()
        _viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        _frustum.setFromProjectionMatrix(_viewProjection, camera.coordinateSystem)
        _camera.setFromMatrixPosition(camera.matrixWorld)

        // Height on screen, as a share of the screen's, of a 1 m object at 1 m
        const perMetre = camera.isPerspectiveCamera
            ? camera.zoom * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
            : camera.zoom / (camera.top - camera.bottom)

        let changed = false

        for(let tree = 0; tree < levels.length; tree++)
        {
            _centre.fromArray(spheres, tree * 4)
            _sphere.center.copy(_centre)
            _sphere.radius = spheres[tree * 4 + 3] + cullMargin * heights[tree]

            let level = CULLED
            if(cullMargin === Infinity || _frustum.intersectsSphere(_sphere))
            {
                const distance = camera.isPerspectiveCamera ? Math.max(_centre.distanceTo(_camera), 1e-3) : 1
                const onScreen = heights[tree] * perMetre / distance
                const current = levels[tree]

                level = 0
                for(let i = 0; i < lodScreen.length; i++)
                {
                    // To gain detail again, it must grow past the limit by a margin
                    const limit = current !== CULLED && current > i ? lodScreen[i] / HYSTERESIS : lodScreen[i]
                    if(onScreen < limit) level = i + 1
                }
            }

            if(level !== levels[tree])
            {
                levels[tree] = level
                changed = true
            }
        }

        if(changed) this.drawLevels()
    }

    /** Put each tree on the InstancedMeshes of its level. */
    drawLevels()
    {
        const { levels } = this

        for(const { copies, matrices } of this.bark)
        {
            const counts = new Array(copies.length).fill(0)

            for(let tree = 0; tree < levels.length; tree++)
            {
                const level = levels[tree]
                if(level === CULLED) continue

                const instanced = copies[level]
                const slot = counts[level]++

                instanced.instanceMatrix.array.set(matrices.subarray(tree * 16, tree * 16 + 16), slot * 16)
                instanced.geometry.attributes.treeId.array[slot] = tree
            }

            copies.forEach((instanced, level) =>
            {
                instanced.count = counts[level]
                instanced.visible = counts[level] > 0
                instanced.instanceMatrix.needsUpdate = true
                instanced.geometry.attributes.treeId.needsUpdate = true
            })
        }
    }

    /**
     * Leaf size, ground and sway follow each tree, and the forest wherever it
     * is placed. The per-tree part only runs again when forest.object moves.
     */
    updatePlacement()
    {
        const { asset, object, sway, treeSphere, spheres, heights } = this

        this.leafRenderer.uniforms.size.value = this.params.leafSize * (asset.height / 3.6)
        sway.uniforms.height.value = asset.height

        object.updateWorldMatrix(true, false)
        if(this.placedAt?.equals(object.matrixWorld)) return
        this.placedAt = object.matrixWorld.clone()

        object.updateMatrixWorld(true)

        asset.bones.forEach((bone, tree) =>
        {
            bone.localToWorld(_base.copy(asset.base))
            bone.getWorldScale(_scale)

            const treeScale = _scale.y / asset.rootScale
            heights[tree] = asset.height * treeScale
            sway.setTreePlacement(tree, _base, heights[tree], this.groundY ?? _base.y)

            bone.localToWorld(_centre.copy(treeSphere.center)).toArray(spheres, tree * 4)
            spheres[tree * 4 + 3] = treeSphere.radius * Math.max(_scale.x, _scale.y, _scale.z)
        })
        sway.upload()
    }

    /** The meshes of the tree that was passed in stay as they were. */
    dispose()
    {
        super.dispose()

        const remove = (instanced) =>
        {
            this.object.remove(instanced)
            instanced.dispose()
        }

        this.asset.pickMeshes.forEach(remove)
        for(const { copies } of this.bark)
        {
            for(const instanced of copies)
            {
                remove(instanced)
                instanced.geometry.dispose()
            }
        }
    }
}
