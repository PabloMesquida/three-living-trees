import * as THREE from 'three/webgpu'
import { createRandom } from '../utils/random.js'
import { ROLE_BRANCH } from '../tree/TreeAsset.js'

/**
 * Leaf anchors: the birth points of the leaves.
 *
 * An anchor is rigidly attached to exactly one bone and stored in that bone's
 * local space, so following the rig is a single matrix product per leaf:
 *
 *     world position    = bone.matrixWorld * anchor.position
 *     world orientation = bone world quaternion * anchor.quaternion
 *
 * The set is plain typed arrays, independent of the particle simulation:
 *
 *     id          index in the arrays (stable for a given tree + seed), or
 *                 the node name for explicit anchors (`names`)
 *     bone        Uint16, index into asset.bones
 *     position    vec3 in the bone's local space
 *     quaternion  leaf frame in the bone's local space: +Y is the direction
 *                 the leaf grows towards, +Z is the normal of its plane
 *
 * Two sources, the second wins when present:
 *   1. sampled on the surface of the meshes (area weighted, seeded): skinned
 *      meshes in a rigged tree, plain meshes in a static one
 *   2. explicit `leaf_anchor*` nodes in the GLB (parented to bones when rigged)
 *
 * Sampled anchors also keep, in bone space, the direction their branch grows
 * towards, the outward direction from the branch axis and the world up. Their
 * orientation is then rebuilt from a few parameters by orientAnchors(), so it
 * can be tuned live. Explicit anchors keep the orientation authored in Blender.
 */

// A surface point only becomes an anchor where one bone clearly dominates the
// skin weights. In the blend zone of a joint the skinned surface moves away
// from any single bone, and a rigidly attached leaf would visibly drift.
const MIN_DOMINANT_WEIGHT = 0.8
const MAX_TRIES = 24

const createSet = (count, source) => ({
    count,
    source,
    names: null,
    bone: new Uint16Array(count),
    position: new Float32Array(count * 3),
    quaternion: new Float32Array(count * 4),
    frame: null // sampled anchors only, see orientAnchors()
})

/**
 * `branchRadius` (static trees only): leaves grow on surfaces whose branch is
 * at most this thick, in metres. null picks it from the tree itself.
 */
export function generateAnchors(asset, count, seed, { branchRadius = null } = {})
{
    if(asset.explicitAnchors.length > 0) return collectExplicitAnchors(asset)
    return asset.rigged
        ? sampleSurfaceAnchors(asset, count, seed)
        : sampleStaticAnchors(asset, count, seed, branchRadius)
}

/**
 * The anchors of one tree repeated for several, each tree being a "bone".
 *
 * They are interleaved, one per tree in turn, so the first N of them are an
 * even spread over the trees and showing fewer leaves takes from all of them.
 * Each tree starts at its own point of the list: when not all the anchors are
 * shown, each tree shows its own part of them.
 */
export function repeatAnchors(set, trees, seed)
{
    const perTree = set.count
    const result = createSet(perTree * trees, `${set.source}, repetidos en ${trees} árboles`)
    const random = createRandom(seed * 6151 + 13)
    const starts = Array.from({ length: trees }, () => Math.floor(random() * perTree))
    const frame = set.frame

    if(frame !== null)
    {
        result.frame = {
            direction: new Float32Array(result.count * 3),
            radial: new Float32Array(result.count * 3),
            up: new Float32Array(result.count * 3),
            random: new Float32Array(result.count * 2)
        }
    }

    const copy = (from, to, i, j, size) =>
    {
        for(let k = 0; k < size; k++) to[i * size + k] = from[j * size + k]
    }

    for(let a = 0; a < perTree; a++)
    {
        for(let tree = 0; tree < trees; tree++)
        {
            const i = a * trees + tree
            const j = (a + starts[tree]) % perTree

            result.bone[i] = tree
            copy(set.position, result.position, i, j, 3)
            copy(set.quaternion, result.quaternion, i, j, 4)

            if(frame !== null)
            {
                copy(frame.direction, result.frame.direction, i, j, 3)
                copy(frame.radial, result.frame.radial, i, j, 3)
                copy(frame.up, result.frame.up, i, j, 3)
                copy(frame.random, result.frame.random, i, j, 2)
            }
        }
    }

    return result
}

/**
 * Anchors authored in Blender as empties (parented to bones in a rigged tree).
 */
function collectExplicitAnchors(asset)
{
    const entries = [...asset.explicitAnchors].sort((a, b) => a.node.name.localeCompare(b.node.name))
    const set = createSet(entries.length, 'leaf_anchor* del GLB')
    set.names = entries.map(({ node }) => node.name)

    const local = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()

    entries.forEach(({ node, bone }, i) =>
    {
        local.copy(bone.matrixWorld).invert().multiply(node.matrixWorld)
        local.decompose(position, quaternion, scale)

        set.bone[i] = asset.boneIndex.get(bone)
        position.toArray(set.position, i * 3)
        quaternion.toArray(set.quaternion, i * 4)

        // The empties are only data
        node.visible = false
    })

    return set
}

/**
 * Anchors scattered on the surface of the branches.
 */
function sampleSurfaceAnchors(asset, count, seed)
{
    const random = createRandom(seed * 15485863 + 5)
    const set = createSet(count, 'muestreo de superficie')

    // 1. Collect the triangles that belong to branch bones, in world space
    const triangles = [] // { mesh, a, b, c, area }
    const areas = []
    let totalArea = 0

    const vA = new THREE.Vector3()
    const vB = new THREE.Vector3()
    const vC = new THREE.Vector3()
    const edge1 = new THREE.Vector3()
    const edge2 = new THREE.Vector3()
    const normal = new THREE.Vector3()

    const worldPosition = (mesh, index, target) =>
        mesh.getVertexPosition(index, target).applyMatrix4(mesh.matrixWorld)

    // Area weighted centre of each branch bone's surface: from the bone's head
    // towards it is the way the branch grows, whatever the bone's local axes
    const centres = new Map() // bone index -> [x, y, z, area]

    for(const mesh of asset.emitterMeshes)
    {
        const { index, attributes } = mesh.geometry
        const { skinIndex, skinWeight } = attributes
        const joints = mesh.skeleton.bones.map((bone) => asset.boneIndex.get(bone))
        const triangleCount = (index ? index.count : attributes.position.count) / 3

        mesh.userData.joints = joints

        for(let t = 0; t < triangleCount; t++)
        {
            const a = index ? index.getX(t * 3) : t * 3
            const b = index ? index.getX(t * 3 + 1) : t * 3 + 1
            const c = index ? index.getX(t * 3 + 2) : t * 3 + 2

            const dominant = dominantBone(joints, skinIndex, skinWeight, a, b, c, 1 / 3, 1 / 3)
            if(asset.roles[dominant.bone] !== ROLE_BRANCH) continue

            worldPosition(mesh, a, vA)
            worldPosition(mesh, b, vB)
            worldPosition(mesh, c, vC)
            const area = normal.crossVectors(edge1.subVectors(vB, vA), edge2.subVectors(vC, vA)).length() * 0.5
            if(area <= 0) continue

            totalArea += area
            triangles.push({ mesh, a, b, c })
            areas.push(totalArea)

            const centre = centres.get(dominant.bone) || [0, 0, 0, 0]
            centre[0] += (vA.x + vB.x + vC.x) / 3 * area
            centre[1] += (vA.y + vB.y + vC.y) / 3 * area
            centre[2] += (vA.z + vB.z + vC.z) / 3 * area
            centre[3] += area
            centres.set(dominant.bone, centre)
        }
    }

    if(triangles.length === 0)
    {
        throw new Error(asset.roles.includes(ROLE_BRANCH)
            ? 'No hay superficie donde sembrar hojas: ninguna cara está pesada mayoritariamente a un hueso "branch*".'
            : 'Ningún hueso del archivo se llama "branch*", así que no hay ramas donde sembrar hojas. ' +
              'Si el GLB se comprimió con gltfpack, repite la compresión con la opción -kn para conservar los nombres de los nodos.')
    }

    // 2. Pick points, area weighted
    const boneInverse = new Map()
    const inverseOf = (boneIndex) =>
    {
        if(!boneInverse.has(boneIndex))
            boneInverse.set(boneIndex, asset.bones[boneIndex].matrixWorld.clone().invert())
        return boneInverse.get(boneIndex)
    }

    // Per bone, in its own space: branch direction and world up
    const boneFrames = new Map()
    const frameOf = (boneIndex) =>
    {
        if(boneFrames.has(boneIndex)) return boneFrames.get(boneIndex)

        const bone = asset.bones[boneIndex]
        const inverseRotation = bone.getWorldQuaternion(new THREE.Quaternion()).invert()
        const head = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld)
        const [x, y, z, area] = centres.get(boneIndex)
        const direction = new THREE.Vector3(x / area, y / area, z / area).sub(head)

        // A segment whose centre sits on its head: fall back on the bone's +Y (Blender's bone axis)
        if(direction.lengthSq() < 1e-10) direction.set(0, 1, 0)
        else direction.applyQuaternion(inverseRotation).normalize()

        const frame = { direction, up: new THREE.Vector3(0, 1, 0).applyQuaternion(inverseRotation) }
        boneFrames.set(boneIndex, frame)
        return frame
    }

    set.frame = {
        direction: new Float32Array(count * 3),
        radial: new Float32Array(count * 3),
        up: new Float32Array(count * 3),
        random: new Float32Array(count * 2)
    }

    const point = new THREE.Vector3()
    const radial = new THREE.Vector3()
    const localNormal = new THREE.Vector3()
    const boneQuaternion = new THREE.Quaternion()
    let rejected = 0

    for(let i = 0; i < count; i++)
    {
        let triangle, u, v, dominant

        for(let attempt = 0; attempt < MAX_TRIES; attempt++)
        {
            // Binary search in the cumulative areas
            const target = random() * totalArea
            let low = 0
            let high = areas.length - 1
            while(low < high)
            {
                const middle = (low + high) >> 1
                if(areas[middle] < target) low = middle + 1
                else high = middle
            }
            triangle = triangles[low]

            // Uniform point in the triangle
            const r1 = Math.sqrt(random())
            const r2 = random()
            u = r1 * (1 - r2)
            v = r1 * r2

            const { mesh, a, b, c } = triangle
            const { skinIndex, skinWeight } = mesh.geometry.attributes
            dominant = dominantBone(mesh.userData.joints, skinIndex, skinWeight, a, b, c, u, v)

            if(dominant.weight >= MIN_DOMINANT_WEIGHT && asset.roles[dominant.bone] === ROLE_BRANCH) break
            if(attempt < MAX_TRIES - 1) rejected++
        }

        const { mesh, a, b, c } = triangle
        worldPosition(mesh, a, vA)
        worldPosition(mesh, b, vB)
        worldPosition(mesh, c, vC)
        normal.crossVectors(edge1.subVectors(vB, vA), edge2.subVectors(vC, vA)).normalize()
        point.copy(vA).addScaledVector(edge1, u).addScaledVector(edge2, v)

        // Two random numbers per leaf for the angle and roll scatter. Six are
        // drawn so the sequence, and therefore every anchor position, stays the
        // same as before orientation became tunable.
        const jitter = [random(), random(), random(), random(), random(), random()]

        // To the dominant bone's local space
        const bone = asset.bones[dominant.bone]
        const frame = frameOf(dominant.bone)
        point.applyMatrix4(inverseOf(dominant.bone))

        // Outward from the branch axis (the axis runs through the bone's head)
        radial.copy(point).addScaledVector(frame.direction, -point.dot(frame.direction))
        if(radial.lengthSq() < 1e-10)
        {
            bone.getWorldQuaternion(boneQuaternion).invert()
            radial.copy(localNormal.copy(normal).applyQuaternion(boneQuaternion))
            radial.addScaledVector(frame.direction, -radial.dot(frame.direction))
        }
        radial.normalize()

        set.bone[i] = dominant.bone
        point.toArray(set.position, i * 3)
        frame.direction.toArray(set.frame.direction, i * 3)
        radial.toArray(set.frame.radial, i * 3)
        frame.up.toArray(set.frame.up, i * 3)
        set.frame.random[i * 2] = jitter[0]
        set.frame.random[i * 2 + 1] = jitter[3]
    }

    orientAnchors(set, DEFAULT_ORIENTATION)

    for(const mesh of asset.emitterMeshes) delete mesh.userData.joints

    set.source += ` (${triangles.length} caras de rama, ${rejected} puntos descartados por pesos mezclados)`
    return set
}

/**
 * Anchors scattered on a static tree: no bones, so no skin weights to tell
 * branch from trunk and no bone to give the way a branch grows. Both come
 * from the mesh itself, triangle by triangle.
 *
 * On a smooth-shaded tube the vertex normals all point away from the axis, so
 * across two vertices at different angles around the tube
 *
 *     axis    ∥  normalA × normalB
 *     radius  =  |positionA - positionB| (across the axis) / |normalA - normalB|
 *
 * Leaves only grow where the branch is thinner than `branchRadius`, which
 * keeps them off the trunk. Without it, the limit is a fraction of the
 * thickest part of the tree. A dedicated `leaf_emitter*` mesh is taken as it is.
 *
 * Every anchor hangs from the single static bone (the tree's root), and its
 * branch direction points away from the trunk.
 */
const AUTO_RADIUS_FRACTION = 0.4 // of the trunk radius (99th percentile of all the estimates)
const MIN_NORMAL_SPREAD = 0.02 // below this the normals are too alike to measure anything
const VERTICAL = 0.85 // |direction.y| above which a branch counts as growing upwards

const _across = new THREE.Vector3()

/**
 * The axis and radius of the branch under one triangle, from the corners whose
 * normals differ most: { axis, radius }. A flat patch has no axis and an
 * infinite radius. `p` and `n` are its three positions and normals.
 */
export function branchAxis(p, n)
{
    let best = -1
    let spread = MIN_NORMAL_SPREAD
    for(let k = 0; k < 3; k++)
    {
        const value = n[k].distanceTo(n[(k + 1) % 3])
        if(value > spread)
        {
            spread = value
            best = k
        }
    }

    if(best === -1) return { axis: null, radius: Infinity }

    const a = best
    const b = (best + 1) % 3
    const axis = new THREE.Vector3().crossVectors(n[a], n[b])
    if(axis.lengthSq() <= 1e-10) return { axis: null, radius: Infinity }

    axis.normalize()
    _across.subVectors(p[a], p[b])
    _across.addScaledVector(axis, -_across.dot(axis))

    return { axis, radius: _across.length() / spread }
}

function sampleStaticAnchors(asset, count, seed, branchRadius)
{
    const random = createRandom(seed * 15485863 + 5)
    const set = createSet(count, 'muestreo de superficie estática')

    const root = asset.root
    root.updateMatrixWorld(true)
    const baseWorld = root.localToWorld(asset.base.clone())

    // 1. Every triangle in world space, with its branch axis and radius
    const all = [] // { p: [vA, vB, vC], n: [nA, nB, nC], axis, radius, area }
    const normalMatrix = new THREE.Matrix3()
    const edge1 = new THREE.Vector3()
    const edge2 = new THREE.Vector3()

    for(const mesh of asset.emitterMeshes)
    {
        const geometry = mesh.geometry
        if(geometry.attributes.normal === undefined) geometry.computeVertexNormals()

        const { index, attributes } = geometry
        const triangleCount = (index ? index.count : attributes.position.count) / 3
        normalMatrix.getNormalMatrix(mesh.matrixWorld)

        for(let t = 0; t < triangleCount; t++)
        {
            const corners = [0, 1, 2].map((k) => index ? index.getX(t * 3 + k) : t * 3 + k)
            const p = corners.map((vertex) => new THREE.Vector3().fromBufferAttribute(attributes.position, vertex).applyMatrix4(mesh.matrixWorld))
            const n = corners.map((vertex) => new THREE.Vector3().fromBufferAttribute(attributes.normal, vertex).applyMatrix3(normalMatrix).normalize())

            const area = edge1.subVectors(p[1], p[0]).cross(edge2.subVectors(p[2], p[0])).length() * 0.5
            if(area <= 0) continue

            const { axis, radius } = branchAxis(p, n)

            all.push({ p, n, axis, radius, area })
        }
    }

    // 2. Which triangles carry leaves
    let limit = Infinity
    if(!asset.dedicatedEmitters)
    {
        if(branchRadius !== null) limit = branchRadius
        else
        {
            const radii = all.map((triangle) => triangle.radius).filter(Number.isFinite).sort((a, b) => a - b)
            if(radii.length > 0) limit = radii[Math.floor((radii.length - 1) * 0.99)] * AUTO_RADIUS_FRACTION
        }
    }

    const triangles = all.filter((triangle) => triangle.radius <= limit || triangle.axis === null)
    if(triangles.length === 0)
        throw new Error(`No hay superficie donde sembrar hojas: ninguna parte del árbol es más fina que branchRadius (${limit.toFixed(3)} m).`)

    const areas = []
    let totalArea = 0
    for(const triangle of triangles)
    {
        totalArea += triangle.area
        areas.push(totalArea)
    }

    // 3. Pick points, area weighted, and build each leaf's frame in the root's space
    const inverseRoot = root.matrixWorld.clone().invert()
    const inverseRotation = root.getWorldQuaternion(new THREE.Quaternion()).invert()
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(inverseRotation)

    set.frame = {
        direction: new Float32Array(count * 3),
        radial: new Float32Array(count * 3),
        up: new Float32Array(count * 3),
        random: new Float32Array(count * 2)
    }

    const point = new THREE.Vector3()
    const normal = new THREE.Vector3()
    const direction = new THREE.Vector3()
    const radial = new THREE.Vector3()
    const worldUp = new THREE.Vector3(0, 1, 0)

    for(let i = 0; i < count; i++)
    {
        const target = random() * totalArea
        let low = 0
        let high = areas.length - 1
        while(low < high)
        {
            const middle = (low + high) >> 1
            if(areas[middle] < target) low = middle + 1
            else high = middle
        }
        const { p, n, axis } = triangles[low]

        const r1 = Math.sqrt(random())
        const r2 = random()
        const u = r1 * (1 - r2)
        const v = r1 * r2
        const w = 1 - u - v

        point.copy(p[0]).multiplyScalar(w).addScaledVector(p[1], u).addScaledVector(p[2], v)
        normal.copy(n[0]).multiplyScalar(w).addScaledVector(n[1], u).addScaledVector(n[2], v).normalize()

        // Along the branch, away from the base of the tree. On a flat patch
        // (no axis) the leaf climbs the surface instead.
        if(axis !== null) direction.copy(axis)
        else direction.copy(worldUp).addScaledVector(normal, -normal.dot(worldUp))
        if(direction.lengthSq() < 1e-10) direction.set(1, 0, 0).addScaledVector(normal, -normal.x)
        direction.normalize()

        // Which way along the axis: a branch grows away from the trunk, seen
        // from above (its tip may hang lower than its base); the trunk and
        // near vertical shoots grow up
        const outward = (point.x - baseWorld.x) * direction.x + (point.z - baseWorld.z) * direction.z
        const tipwards = Math.abs(direction.y) > VERTICAL || Math.abs(outward) < 1e-6 ? direction.y : outward
        if(tipwards < 0) direction.negate()

        // Outward: the normal, without its component along the branch
        radial.copy(normal).addScaledVector(direction, -normal.dot(direction))
        if(radial.lengthSq() < 1e-10) radial.copy(normal)
        radial.normalize()

        set.bone[i] = 0
        point.applyMatrix4(inverseRoot).toArray(set.position, i * 3)
        direction.applyQuaternion(inverseRotation).toArray(set.frame.direction, i * 3)
        radial.applyQuaternion(inverseRotation).toArray(set.frame.radial, i * 3)
        up.toArray(set.frame.up, i * 3)
        set.frame.random[i * 2] = random()
        set.frame.random[i * 2 + 1] = random()
    }

    orientAnchors(set, DEFAULT_ORIENTATION)

    const flat = triangles.filter((triangle) => triangle.axis === null).length
    set.source += Number.isFinite(limit)
        ? ` (${triangles.length} de ${all.length} caras con hojas, ramas de hasta ${limit.toFixed(3)} m de radio, ${flat} sin curvatura)`
        : ` (${triangles.length} caras de leaf_emitter)`
    return set
}

/**
 * Leaf orientation, pine style: every leaf leaves its branch towards the tip,
 * opened by `angle` from the branch axis.
 *
 *   angle            degrees between the leaf and its branch (0 = along the
 *                    branch towards the tip, 90 = straight out of the bark)
 *   angleVariation   ± degrees of random scatter on the angle
 *   roll             degrees the leaf turns on its own axis (0 = its face
 *                    looks around the branch, 90 = its face looks outwards)
 *   rollVariation    ± degrees of random scatter on the roll
 *   upward           0..1, how much the leaves bend towards the sky
 *
 * Writes set.quaternion. Does nothing for explicit anchors.
 */
export const DEFAULT_ORIENTATION = { angle: 40, angleVariation: 12, roll: 0, rollVariation: 25, upward: 0.2 }

const _direction = new THREE.Vector3()
const _radial = new THREE.Vector3()
const _up = new THREE.Vector3()
const _grow = new THREE.Vector3()
const _face = new THREE.Vector3()
const _side = new THREE.Vector3()
const _basis = new THREE.Matrix4()
const _quaternion = new THREE.Quaternion()
const _roll = new THREE.Quaternion()

export function orientAnchors(set, { angle, angleVariation, roll, rollVariation, upward })
{
    if(set.frame === null) return false

    const { direction, radial, up, random } = set.frame
    const degrees = Math.PI / 180

    for(let i = 0; i < set.count; i++)
    {
        _direction.fromArray(direction, i * 3)
        _radial.fromArray(radial, i * 3)
        _up.fromArray(up, i * 3)

        // Growth: from the branch axis, opened towards the outside
        const opening = (angle + (random[i * 2] * 2 - 1) * angleVariation) * degrees
        _grow.copy(_direction).multiplyScalar(Math.cos(opening)).addScaledVector(_radial, Math.sin(opening))
        _grow.addScaledVector(_up, upward).normalize()

        // Face: perpendicular to the plane that holds the branch and the leaf, then rolled
        _face.crossVectors(_direction, _grow)
        if(_face.lengthSq() < 1e-8) _face.crossVectors(_radial, _grow)
        _face.normalize()
        _roll.setFromAxisAngle(_grow, (roll + (random[i * 2 + 1] * 2 - 1) * rollVariation) * degrees)
        _face.applyQuaternion(_roll)

        // Leaf plane: +Y grows, +Z is its normal
        _side.crossVectors(_grow, _face)
        _basis.makeBasis(_side, _grow, _face)
        _quaternion.setFromRotationMatrix(_basis).toArray(set.quaternion, i * 4)
    }

    return true
}

// Sum the skin weights per bone at a barycentric point and return the largest.
const _weights = new Map()
const _dominant = { bone: 0, weight: 0 }

function dominantBone(joints, skinIndex, skinWeight, a, b, c, u, v)
{
    _weights.clear()

    const accumulate = (vertex, factor) =>
    {
        for(let k = 0; k < 4; k++)
        {
            const weight = skinWeight.getComponent(vertex, k) * factor
            if(weight <= 0) continue
            const bone = joints[skinIndex.getComponent(vertex, k)]
            _weights.set(bone, (_weights.get(bone) || 0) + weight)
        }
    }

    accumulate(a, 1 - u - v)
    accumulate(b, u)
    accumulate(c, v)

    let total = 0
    _dominant.bone = 0
    _dominant.weight = 0
    for(const [bone, weight] of _weights)
    {
        total += weight
        if(weight > _dominant.weight)
        {
            _dominant.bone = bone
            _dominant.weight = weight
        }
    }
    if(total > 0) _dominant.weight /= total

    return _dominant
}
