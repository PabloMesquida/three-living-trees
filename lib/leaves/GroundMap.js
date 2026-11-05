import * as THREE from 'three/webgpu'
import { clamp, cos, cross, float, ivec2, max, normalize, select, sin, textureLoad, uniform, vec2, vec3, vec4 } from 'three/tsl'

/**
 * Where leaves land on uneven ground: the height of the given meshes seen from
 * above, in a texture the leaf simulation reads.
 *
 * The triangles are drawn into the map on the CPU when it is made, keeping the
 * highest one in each cell. It takes no render and works with any mesh, and it
 * costs the leaves one texture read while they fall. Heights aren't filtered,
 * so a ledge stays a ledge. It only knows the top surface: a leaf can't land
 * under an overhang. Call bake() again if the ground changes.
 *
 * A cell with no ground has no height: leaves over it keep falling, until the
 * simulation recycles them (or down to `floorY`, if there is one).
 */

export const NO_GROUND = -1e9
const EDGE_CELLS = 2
const MAX_SLOPE = 1.75 // about 60°: anything steeper is a ledge or a wall, which a leaf doesn't lie along
const LEAF_HALF_WIDTH = 0.35 // of its length: enough for the shape of the ground under it

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _matrix = new THREE.Matrix4()
const _instance = new THREE.Matrix4()

export class GroundMap
{
    constructor(resolution)
    {
        this.resolution = resolution
        this.data = new Float32Array(resolution * resolution).fill(NO_GROUND)
        this.region = new THREE.Box2()
        this.triangles = 0

        this.texture = new THREE.DataTexture(this.data, resolution, resolution, THREE.RedFormat, THREE.FloatType)
        this.texture.minFilter = THREE.NearestFilter
        this.texture.magFilter = THREE.NearestFilter
        this.texture.generateMipmaps = false
        this.texture.needsUpdate = true

        this.uniforms = {
            origin: uniform(new THREE.Vector2()),
            cellsPerMetre: uniform(new THREE.Vector2(1, 1)),
            floorY: uniform(NO_GROUND)
        }
    }

    /**
     * Draw the meshes into the map, over `region` (a Box2 in world XZ) or the part
     * of it they cover. `floorY`: nothing is lower than this, null for no limit.
     */
    bake(meshes, region, floorY = null)
    {
        const { data, resolution, uniforms } = this
        const surfaces = []

        for(const object of meshes)
        {
            object.updateWorldMatrix(true, true)
            object.traverse((child) =>
            {
                if(child.isMesh && child.geometry?.attributes.position !== undefined) surfaces.push(child)
            })
        }

        if(surfaces.length === 0)
            throw new Error('`ground` no contiene ninguna malla: las hojas no tendrían dónde aterrizar.')

        // Only what the leaves can reach: the cells are that much finer
        const covered = new THREE.Box2().makeEmpty()
        const box = new THREE.Box3()
        const forEachMatrix = (mesh, visit) =>
        {
            if(mesh.isInstancedMesh !== true)
            {
                visit(mesh.matrixWorld)
                return
            }

            for(let i = 0; i < mesh.count; i++)
            {
                mesh.getMatrixAt(i, _instance)
                visit(_matrix.multiplyMatrices(mesh.matrixWorld, _instance))
            }
        }

        for(const mesh of surfaces)
        {
            if(mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox()
            forEachMatrix(mesh, (matrix) =>
            {
                box.copy(mesh.geometry.boundingBox).applyMatrix4(matrix)
                covered.expandByPoint(new THREE.Vector2(box.min.x, box.min.z))
                covered.expandByPoint(new THREE.Vector2(box.max.x, box.max.z))
            })
        }

        const area = region.clone().intersect(covered)
        if(area.isEmpty()) area.copy(region)

        // A ring of cells past the edge. Points off the map take the nearest cell,
        // so this tells the end of the ground (the ring stays empty) from the end
        // of the map (it holds ground, which goes on)
        const ring = EDGE_CELLS / (resolution - EDGE_CELLS * 2)
        const ringX = (area.max.x - area.min.x) * ring
        const ringZ = (area.max.y - area.min.y) * ring
        area.min.x -= ringX
        area.max.x += ringX
        area.min.y -= ringZ
        area.max.y += ringZ
        this.region.copy(area)

        const sizeX = Math.max(area.max.x - area.min.x, 1e-3)
        const sizeZ = Math.max(area.max.y - area.min.y, 1e-3)
        const perX = resolution / sizeX
        const perZ = resolution / sizeZ

        data.fill(NO_GROUND)
        this.triangles = 0

        for(const mesh of surfaces)
        {
            const { position } = mesh.geometry.attributes
            const index = mesh.geometry.index
            const count = (index ? index.count : position.count) / 3

            forEachMatrix(mesh, (matrix) =>
            {
                for(let t = 0; t < count; t++)
                {
                    const i = t * 3
                    _a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrix)
                    _b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(matrix)
                    _c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(matrix)

                    this.drawTriangle(_a, _b, _c, area.min.x, area.min.y, perX, perZ)
                }
            })

            this.triangles += count
        }

        uniforms.origin.value.copy(area.min)
        uniforms.cellsPerMetre.value.set(perX, perZ)
        uniforms.floorY.value = floorY ?? NO_GROUND

        this.texture.needsUpdate = true
    }

    /** Keep the highest surface at the centre of each cell the triangle covers. */
    drawTriangle(a, b, c, originX, originZ, perX, perZ)
    {
        const { data, resolution } = this

        const area = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)
        if(Math.abs(area) < 1e-10) return // seen edge-on from above: a wall

        const toCellX = (x) => (x - originX) * perX
        const toCellZ = (z) => (z - originZ) * perZ

        const startX = Math.max(Math.ceil(toCellX(Math.min(a.x, b.x, c.x)) - 0.5), 0)
        const endX = Math.min(Math.floor(toCellX(Math.max(a.x, b.x, c.x)) - 0.5), resolution - 1)
        const startZ = Math.max(Math.ceil(toCellZ(Math.min(a.z, b.z, c.z)) - 0.5), 0)
        const endZ = Math.min(Math.floor(toCellZ(Math.max(a.z, b.z, c.z)) - 0.5), resolution - 1)

        for(let row = startZ; row <= endZ; row++)
        {
            const z = originZ + (row + 0.5) / perZ

            for(let column = startX; column <= endX; column++)
            {
                const x = originX + (column + 0.5) / perX

                const u = ((x - a.x) * (c.z - a.z) - (c.x - a.x) * (z - a.z)) / area
                const v = ((b.x - a.x) * (z - a.z) - (x - a.x) * (b.z - a.z)) / area
                if(u < 0 || v < 0 || u + v > 1) continue

                const height = a.y + u * (b.y - a.y) + v * (c.y - a.y)
                const cell = row * resolution + column
                if(height > data[cell]) data[cell] = height
            }
        }
    }

    /** The height under a world XZ point, as a node. Points off the map take the nearest cell. */
    heightAt(xz)
    {
        const { origin, cellsPerMetre, floorY } = this.uniforms
        const last = float(this.resolution - 1)
        const cell = xz.sub(origin).mul(cellsPerMetre).floor()
        const clamped = vec2(clamp(cell.x, 0, last), clamp(cell.y, 0, last))

        return max(textureLoad(this.texture, ivec2(clamped)).x, floorY)
    }

    /**
     * The rotation (a quaternion node) that takes a leaf lying flat to the ground
     * under it, for a leaf with its stem at `xz`, `length` long and pointing the
     * way `yaw` turns it. It measures the ground at the tip and at both sides, so
     * the leaf rests on what is really under it. Past a ledge or against a wall,
     * that side stays level instead of tipping the leaf over.
     */
    tiltAt(xz, length, yaw)
    {
        const along = vec2(sin(yaw).negate(), cos(yaw).negate())
        const across = vec2(cos(yaw), sin(yaw).negate())
        const width = length.mul(LEAF_HALF_WIDTH * 2)
        const middle = xz.add(along.mul(length.mul(0.5)))

        const rise = (to, from, span) =>
        {
            const step = to.sub(from).toVar()
            return select(step.abs().lessThan(span.mul(MAX_SLOPE)), step, float(0))
        }

        const stem = this.heightAt(xz).toVar()
        const tip = this.heightAt(xz.add(along.mul(length))).toVar()
        const right = this.heightAt(middle.add(across.mul(width.mul(0.5)))).toVar()
        const left = this.heightAt(middle.sub(across.mul(width.mul(0.5)))).toVar()

        const forward = vec3(along.x.mul(length), rise(tip, stem, length), along.y.mul(length))
        const sideways = vec3(across.x.mul(width), rise(right, left, width), across.y.mul(width))
        const normal = normalize(cross(sideways, forward)).toVar()

        // The shortest turn from straight up to that normal
        return normalize(vec4(normal.z, 0, normal.x.negate(), normal.y.add(1)))
    }

    /** The same on the CPU, for the scripted checks. */
    heightAtPoint(x, z)
    {
        const { origin, cellsPerMetre, floorY } = this.uniforms
        const limit = this.resolution - 1
        const column = THREE.MathUtils.clamp(Math.floor((x - origin.value.x) * cellsPerMetre.value.x), 0, limit)
        const row = THREE.MathUtils.clamp(Math.floor((z - origin.value.y) * cellsPerMetre.value.y), 0, limit)

        return Math.max(this.data[row * this.resolution + column], floorY.value)
    }

    dispose()
    {
        this.texture.dispose()
    }
}
