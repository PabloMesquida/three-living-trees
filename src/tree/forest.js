import * as THREE from 'three/webgpu'
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js'
import { LeafTree, loadLeafTextures, loadTreeScene } from '../../lib/index.js'
import { createRandom } from '../../lib/utils/random.js'
import { createProceduralTree } from './ProceduralTree.js'
import { stripBones } from './stripBones.js'

/**
 * The demo's trees: one or several LeafTree instances of the same kind.
 *
 *   - A GLB is loaded once and cloned (SkeletonUtils.clone keeps each copy's
 *     own skeleton); provisional trees are built one per seed, so they differ.
 *   - Without bones, the armature is stripped before cloning (stripBones.js).
 *   - Leaf textures are loaded once (with the renderer's anisotropic filtering)
 *     and passed to every tree as textures.
 *   - Trees stand on a jittered grid, each turned and scaled a little, placed
 *     before LeafTree.create() so their rest pose is the placed one. A single
 *     tree stays at the origin, unturned and unscaled.
 *
 * Returns { trees, bounds }: the LeafTree list and the box holding all of them.
 */
export async function createForest(renderer, options, leafTextures)
{
    const { tree, glb, bones, trees: total, count, capacity, seed } = options

    const [template, textures] = await Promise.all([
        tree === 'glb' ? loadTreeScene(glb) : null,
        loadLeafTextures(leafTextures, renderer)
    ])
    if(template !== null && !bones) stripBones(template)
    const sharedTextures = textures.map((texture, index) => ({ ...leafTextures[index], url: undefined, texture }))

    const objects = []
    for(let i = 0; i < total; i++)
    {
        let object
        if(template !== null)
        {
            object = i === 0 ? template : (bones ? cloneRigged(template) : template.clone())
            object.name = total > 1 ? `${glb} #${i + 1}` : glb
        }
        else
        {
            object = createProceduralTree(seed + i)
            if(!bones) stripBones(object)
        }
        objects.push(object)
    }

    layOut(objects, seed)

    const trees = []
    for(let i = 0; i < total; i++)
    {
        trees.push(await LeafTree.create(renderer, {
            object: objects[i],
            count,
            capacity,
            seed: seed + i,
            textures: sharedTextures
        }))
    }

    // Measured like TreeAsset measures a tree: geometry bounds at rest, in world space
    const bounds = new THREE.Box3()
    for(const leafTree of trees)
        for(const mesh of leafTree.asset.meshes) bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld))

    return { trees, bounds }
}

/**
 * A grid as square as possible, spaced by the widest tree, each tree off its
 * cell a little, turned and scaled.
 */
function layOut(objects, seed)
{
    if(objects.length === 1) return

    const random = createRandom(seed * 4513 + 29)
    const size = new THREE.Vector3()
    let spacing = 0
    for(const object of objects)
    {
        new THREE.Box3().setFromObject(object).getSize(size)
        spacing = Math.max(spacing, size.x, size.z, size.y * 0.45)
    }
    spacing *= 1.1

    const columns = Math.ceil(Math.sqrt(objects.length))
    const rows = Math.ceil(objects.length / columns)

    objects.forEach((object, i) =>
    {
        const column = i % columns
        const row = Math.floor(i / columns)
        object.position.set(
            (column - (columns - 1) * 0.5 + random.range(-0.15, 0.15)) * spacing,
            0,
            (row - (rows - 1) * 0.5 + random.range(-0.15, 0.15)) * spacing
        )
        object.rotation.y = random.range(0, Math.PI * 2)
        object.scale.setScalar(random.range(0.85, 1.15))
        object.updateMatrixWorld(true)
    })
}
