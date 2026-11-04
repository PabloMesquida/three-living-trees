import * as THREE from 'three/webgpu'

/**
 * Turns a rigged tree into a static one, as if it had been exported from
 * Blender without its armature: every SkinnedMesh becomes a plain Mesh with
 * the shape it has at rest, and the bones go away. The library then loads it
 * as a static tree (no bones), which sways in its vertex shader.
 *
 * Positions are baked through the skin at rest; normals are kept, which is
 * right as long as the rest pose is the bind pose (true for a fresh export).
 */
export function stripBones(root)
{
    root.updateMatrixWorld(true)

    const skinnedMeshes = []
    const topBones = []
    root.traverse((object) =>
    {
        if(object.isSkinnedMesh) skinnedMeshes.push(object)
        else if(object.isBone && object.parent?.isBone !== true) topBones.push(object)
    })

    const rootInverse = root.matrixWorld.clone().invert()
    const vertex = new THREE.Vector3()

    for(const skinned of skinnedMeshes)
    {
        const geometry = skinned.geometry.clone()
        geometry.deleteAttribute('skinIndex')
        geometry.deleteAttribute('skinWeight')

        const position = geometry.attributes.position
        for(let i = 0; i < position.count; i++)
        {
            skinned.applyBoneTransform(i, vertex.fromBufferAttribute(skinned.geometry.attributes.position, i))
            position.setXYZ(i, vertex.x, vertex.y, vertex.z)
        }
        geometry.computeBoundingBox()
        geometry.computeBoundingSphere()

        const mesh = new THREE.Mesh(geometry, skinned.material)
        mesh.name = skinned.name
        mesh.visible = skinned.visible

        // Same parent when it can stay (its name may mark a collider or an
        // emitter), the root when the parent is a bone that goes away
        const parent = skinned.parent.isBone ? root : skinned.parent
        const parentInverse = parent === root ? rootInverse : parent.matrixWorld.clone().invert()
        new THREE.Matrix4().multiplyMatrices(parentInverse, skinned.matrixWorld).decompose(mesh.position, mesh.quaternion, mesh.scale)

        skinned.removeFromParent()
        parent.add(mesh)
    }

    for(const bone of topBones) bone.removeFromParent()

    return root
}
