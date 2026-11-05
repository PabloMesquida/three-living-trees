import * as THREE from 'three/webgpu'
import { LeafTree, DEFAULT_PARAMS } from './LeafTree.js'
import { generateAnchors, repeatAnchors } from './anchors/AnchorSet.js'
import { ForestSway } from './tree/ForestSway.js'
import { ROLE_STATIC, buildTreeAsset } from './tree/TreeAsset.js'
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
 * It has the LeafTree API (set, update, enablePointer, shakeAll, reset...) and
 * costs one draw call per mesh of the tree, plus one for all the leaves, and
 * one compute dispatch, however many trees there are.
 *
 *   - The bark is an InstancedMesh per mesh of the tree.
 *   - There is one leaf simulation, in which each tree is a static "bone": the
 *     anchors are the tree's, repeated, and each leaf follows its tree's
 *     matrix. Each tree shows its own part of them, so copies don't look alike.
 *   - What differs per tree (place, sway phase, push) is in ForestSway's buffer.
 *
 * Trees don't have bones here: a rigged GLB is stripped as it loads. Options
 * and params are LeafTree's, with `count` and `capacity` per tree.
 */

export const MAX_FOREST_TREES = 1024 // the bone uniform arrays: 64 KB of mat4
const DEFAULT_LEAVES = 20000 // in the whole forest, when `count` isn't given

const _base = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _relative = new THREE.Matrix4()

export class LeafForest extends LeafTree
{
    /**
     * Options: those of LeafTree.create(), plus
     *
     *   transforms  one per tree, a Matrix4 or an Object3D (its position, rotation
     *               and scale). They stand in for the transform of the tree's
     *               root, relative to forest.object
     *   count       leaves shown per tree (default: 20000 between all of them)
     *   capacity    most leaves per tree the GPU buffers hold (default: count)
     *   groundY     world height where leaves land (default: the base of each tree)
     */
    static async create(renderer, options = {})
    {
        const { transforms } = options
        if(!Array.isArray(transforms) || transforms.length === 0)
            throw new Error('LeafForest.create necesita `transforms`, una lista con un Matrix4 o un Object3D por árbol.')
        if(transforms.length > MAX_FOREST_TREES)
            throw new Error(`LeafForest admite hasta ${MAX_FOREST_TREES} árboles y se pasaron ${transforms.length}.`)

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
    createAsset(root, source, { transforms })
    {
        stripBones(root)

        const template = buildTreeAsset(root, source)
        this.template = template

        const object = new THREE.Group()
        object.name = 'forest'
        this.object = object

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
        const instanced = new Map()

        const instance = (mesh) =>
        {
            if(instanced.has(mesh)) return instanced.get(mesh)

            const copies = new THREE.InstancedMesh(mesh.geometry, mesh.material, bones.length)
            copies.name = mesh.name
            copies.visible = mesh.visible
            _relative.multiplyMatrices(rootInverse, mesh.matrixWorld)
            bones.forEach((bone, index) => copies.setMatrixAt(index, bone.matrix.clone().multiply(_relative)))
            object.add(copies)

            instanced.set(mesh, copies)
            return copies
        }

        const meshes = template.meshes.map(instance)
        const pickMeshes = template.pickMeshes.map(instance)
        this.instancedMeshes = [...instanced.values()]

        const boneIndex = new Map(bones.map((bone, index) => [bone, index]))

        return {
            ...template,
            root: object,
            rigged: false,
            bones,
            boneIndex,
            parents: new Int16Array(bones.length).fill(-1),
            roles: new Uint8Array(bones.length).fill(ROLE_STATIC),
            meshes,
            pickMeshes,
            report: [...template.report, `Bosque: ${bones.length} árboles, ${template.meshes.length + 1} draw calls y un solo compute`]
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

    /**
     * Leaf size, ground and sway follow each tree, and the forest wherever it
     * is placed. The per-tree part only runs again when forest.object moves.
     */
    updatePlacement()
    {
        const { asset, object, sway } = this

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
            sway.setTreePlacement(tree, _base, asset.height * _scale.y / asset.rootScale, this.groundY ?? _base.y)
        })
        sway.upload()
    }

    /** The meshes of the tree that was passed in stay as they were. */
    dispose()
    {
        super.dispose()

        for(const copies of this.instancedMeshes)
        {
            this.object.remove(copies)
            copies.dispose()
        }
    }
}
