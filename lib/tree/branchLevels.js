import * as THREE from 'three/webgpu'
import { branchAxis } from '../anchors/AnchorSet.js'

/**
 * Levels of detail for a tree, by removing whole branches from the thinnest up.
 *
 * Most of the triangles of a tree are in its thinnest branches, which from afar
 * are thin lines hidden among the leaves. A generated tree is usually made of
 * one island per branch, so removing whole islands leaves no pieces floating.
 * The levels only differ in their index, so they share the vertices.
 *
 * `fractions`: the part of the triangles each level keeps, from most to least.
 * Returns one index per fraction, plus its numbers of triangles and branches.
 * Returns nothing when the mesh can't be split like this: all one island, or
 * flat shaded (with no way to tell how thick a branch is).
 */

const WELD = 1e-5 // of the size of the mesh: UV seams split vertices at one point
const THICKNESS = 0.9 // the percentile that stands for a branch: its thick end, without outliers

export function branchLevels(geometry, fractions)
{
    const { position, normal } = geometry.attributes
    if(normal === undefined || fractions.length === 0) return []

    const index = geometry.index
    const triangles = (index ? index.count : position.count) / 3
    const corner = (triangle, k) => (index ? index.getX(triangle * 3 + k) : triangle * 3 + k)

    // Islands: triangles joined by a vertex at the same position
    if(geometry.boundingBox === null) geometry.computeBoundingBox()
    const step = Math.max(geometry.boundingBox.getSize(new THREE.Vector3()).length() * WELD, 1e-9)

    const welded = new Map()
    const weld = new Int32Array(position.count)
    for(let i = 0; i < position.count; i++)
    {
        const key = `${Math.round(position.getX(i) / step)},${Math.round(position.getY(i) / step)},${Math.round(position.getZ(i) / step)}`
        if(!welded.has(key)) welded.set(key, welded.size)
        weld[i] = welded.get(key)
    }

    const parent = Int32Array.from({ length: welded.size }, (_, i) => i)
    const find = (item) =>
    {
        let root = item
        while(parent[root] !== root)
        {
            parent[root] = parent[parent[root]]
            root = parent[root]
        }
        return root
    }

    for(let t = 0; t < triangles; t++)
    {
        const a = find(weld[corner(t, 0)])
        parent[find(weld[corner(t, 1)])] = a
        parent[find(weld[corner(t, 2)])] = a
    }

    // Thickness of each island, from the triangles that have a measure of it
    const islands = new Map()
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    const n = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]

    for(let t = 0; t < triangles; t++)
    {
        for(let k = 0; k < 3; k++)
        {
            p[k].fromBufferAttribute(position, corner(t, k))
            n[k].fromBufferAttribute(normal, corner(t, k))
        }

        const id = find(weld[corner(t, 0)])
        if(!islands.has(id)) islands.set(id, { triangles: [], radii: [] })

        const island = islands.get(id)
        island.triangles.push(t)

        const { radius } = branchAxis(p, n)
        if(Number.isFinite(radius)) island.radii.push(radius)
    }

    if(islands.size < 2) return []

    const branches = [...islands.values()].map((island) =>
    {
        island.radii.sort((a, b) => a - b)
        island.thickness = island.radii.length > 0 ? island.radii[Math.floor((island.radii.length - 1) * THICKNESS)] : 0
        return island
    })

    if(branches.every((island) => island.thickness === 0)) return []

    branches.sort((a, b) => b.thickness - a.thickness)

    // The thickest branches, up to each level's share of the triangles
    return fractions.map((fraction) =>
    {
        const target = triangles * fraction
        const kept = []
        let count = 0

        for(const island of branches)
        {
            if(count >= target) break
            kept.push(island)
            count += island.triangles.length
        }

        const levelIndex = new Uint32Array(count * 3)
        let i = 0
        for(const island of kept)
        {
            for(const t of island.triangles)
            {
                levelIndex[i++] = corner(t, 0)
                levelIndex[i++] = corner(t, 1)
                levelIndex[i++] = corner(t, 2)
            }
        }

        return { index: levelIndex, triangles: count, branches: kept.length }
    })
}
