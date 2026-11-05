# three-living-trees

Interactive Three.js (WebGPU) demo of a tree whose leaves come loose when you shake it with the pointer, fall, and grow back on the branches. It is also a small library you can use in your own scenes.

![Leaves falling off the tree after a shake](screenshot.jpg)

## Run the demo

Requires Node.js and a browser with WebGPU support (recent Chrome or Edge).

```bash
npm install
npm run dev
```

Open the address Vite prints (by default `http://localhost:5173/`).

- Move the pointer over the branches to shake the tree; drag to orbit the camera.
- The panel picks the kind of tree and how many. It also sets the number of leaves, spontaneous falling (from one at a time up to all together), falling, regrowth and the wind sway (trees without bones), resets them, and shakes every tree: every branch with bones, the whole crown without.
- Add `#debug` to the URL to show every setting and the particle counters. That panel is in English; its language select (or `?lang=es`) switches it to Spanish.

Every kind of tree the library supports can be tried, alone or several at once:

| Kind | URL | Trees | What it does |
| --- | --- | --- | --- |
| With bones (default) | `?bones=1` | up to 6 | Branches the pointer shakes. The rig runs on the CPU and the skinning on the GPU, per tree |
| Without bones | `?bones=0` | up to 500 | The same model, with its armature stripped at load as if exported without one. Sways in the wind on the GPU; the pointer pushes the crown. Several of them are one `LeafForest` |

- `?trees=N` sets how many. They stand on a grid, each turned and scaled a little. The GLB and the leaf textures are loaded once.
- Leaves are per tree: 5000 by default, fewer past 4 trees with bones (20 000 in all) or past 12 without (60 000 in all). `?count=` and `?maxCount=` change them. The panels' settings apply to every tree.
- `?textures=1` uses a single leaf texture, `?textures=0` none (the built-in leaf).

## Use it as a library

```bash
npm install three github:PabloMesquida/tree-demo#v0.5.0
```

Works with three 0.186.1 or newer (tested with 0.186.1 and 0.187.0).

```js
import * as THREE from 'three/webgpu'
import { LeafTree } from 'three-living-trees'

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false })

const tree = await LeafTree.create(renderer, {
    url: './models/tree.glb',
    textures: [                       // optional, see "Leaf textures"
        { url: './textures/leaf_a.webp', weight: 3 },
        { url: './textures/leaf_b.webp', weight: 1 }
    ]
})
scene.add(tree.object)               // move, rotate or scale it like any object
tree.enablePointer(canvas, camera)   // optional: shake it with the pointer

const timer = new THREE.Timer()
renderer.setAnimationLoop(() =>
{
    timer.update()
    tree.update(timer.getDelta())
    renderer.render(scene, camera)
})

tree.set({ spontaneousFall: 0.3, windStrength: 1 }) // any key of DEFAULT_PARAMS
```

Two kinds of tree work:

- **Rigged:** an armature with bones named `trunk*` and `branch*` and skinned meshes. Each branch is a spring the pointer can shake, and shaking makes leaves fall. Expensive: the CPU animates every bone and the GPU skins every vertex.
- **Static:** plain meshes with no bones (e.g. a Sapling Tree Gen curve converted to a mesh, smooth shaded). The whole tree sways in the wind in its vertex shader. Cheap, and for several of them there is `LeafForest`. Leaves grow on the thinner branches.

Main options of `LeafTree.create`: `url` or `object` (an already loaded `Object3D`), `count`, `capacity`, `seed`, `textures`, `branchRadius` (static trees), `groundY`, `ground`, `params`. The library needs a `WebGPURenderer` running on WebGPU; there is no WebGL fallback.

Create the renderer with `alpha: false`. The leaves use `alphaToCoverage`, so their edges write an alpha below 1 to the canvas. With the default `alpha: true`, the page background shows through those pixels as thin lines (white ones on a white page). `LeafTree.create` warns once per renderer about this. If you do want a transparent canvas, ignore the warning, but expect those lines.

### Uneven ground

By default leaves land at one height: the base of the tree, or `groundY`. On terrain with levels, a tree near a ledge drops leaves that stop in mid-air past the edge. Pass the meshes they should land on instead, already placed in the scene:

```js
const tree = await LeafTree.create(renderer, {
    url: './models/tree.glb',
    ground: [terrain, steps, rocks] // a mesh, a group, or a list of them
})
```

- Leaves land on the highest surface under them, and walls stop them: a leaf blown into one slides down to its foot.
- A leaf rests on the slope under it, keeping its curve. It measures the ground at its tip and sides, so it works on ramps and rounded surfaces. At a ledge or a wall (steeper than about 60°) it stays level instead of tipping over.
- Past the end of the ground, leaves keep falling until they are recycled. `groundY` then acts as a floor nothing falls below.
- The meshes are read once, when the tree is created: their triangles are drawn from above into a height map, with no render. 74 000 triangles take 20 ms. If the ground or the tree moves, call `tree.setGround(meshes)`.
- The cost while running is one or two texture reads per falling leaf, plus four when it lands. With 20 000 leaves in the air it didn't show in the frame time, against rounds that varied more than any difference.
- `groundResolution` (default 512) is the map's cells per side. It covers what leaves can reach, about 3 tree heights around, or less if the ground is smaller: about 6 cm per cell for a 5 m tree. A big `LeafForest` covers more, so it may want a higher one.
- It only knows the top surface, so a leaf can't land under an overhang. A leaf is rigid, so on a rock not much bigger than itself part of it can go through or hang in the air. It stays where it lands, even on a steep slope. Cells aren't filtered, so an edge can be off by up to one cell.

### Static trees: wind sway

The bark and the attached leaves share one displacement function, so leaves never come off their branch. Shadows sway too.

- The displacement grows with the height above the base of the tree (height²): the trunk barely moves and the crown does. It points along `windAngle`, the same angle that blows the falling leaves. It combines a lean that grows in gusts, two oscillations, a smaller one across the wind and a faster flutter. The phase changes across the crown.
- `sway` (default 1): how much the tree moves. At 1 the crown leans about 3 % of the tree height; `0` keeps it still.
- `swaySpeed` (default 1): 2 is twice as fast.
- Each tree starts at its own point in the motion, taken from its `seed`. Give each `LeafTree` in a scene a different `seed` so they don't sway in step; the trees of a `LeafForest` do it on their own.
- Strong gusts shake leaves off with the same rule as a rigged tree's branches (`detachThreshold`, `gripVariation`, `detachProbability`). At the defaults no leaf falls at `sway: 1`, a few fall in the strongest gusts at `sway: 2`, and many at `sway: 3`.
- Falling leaves are free: they leave with the speed of their branch and do not sway with the tree.
- `enablePointer` works too: the pointer gives the whole tree a push that decays on its own, more the higher it touches. `treeMotion` and `motionStrength` control it. Picking uses the tree's meshes at rest. Thin branches are hard to hit, so you can add a hidden mesh named `collider*` (e.g. a rough hull of the crown) for picking. `shakeAll()` kicks the whole crown, each time in a new direction.
- The GLB's materials (`MeshStandardMaterial` and the like) are replaced by their Node equivalents, with every property and texture copied over (the same conversion three's renderer does on its own), plus a `positionNode`. Each tree gets its own copies. `dispose()` puts the original materials back.

All of these change live with `tree.set({ sway: 2, swaySpeed: 1.5, windAngle: 90 })`. Rigged trees ignore `sway` and `swaySpeed`.

### Exporting a static tree from Blender

1. Build the tree without an armature: with Sapling Tree Gen, leave **Armature** off. If the tree already has one, delete the Armature object and its Armature modifier.
2. With the tree selected, **Object › Convert › Mesh** (Sapling makes curves), then **Shade Smooth**. The leaves are placed using the smooth normals to find each branch's axis.
3. **Object › Apply › All Transforms**, with the base of the trunk at the origin.
4. Give it a material. A Principled BSDF with its textures arrives as `MeshStandardMaterial`.
5. Optional: a hidden `collider` mesh for the pointer, a `leaf_emitter` mesh to choose where leaves grow, or `leaf_anchor` empties to place them by hand.
6. **File › Export › glTF 2.0**, format `.glb`, **+Y Up** on, and nothing animated (no skinning).

The tree loads as static because it has no bones. `tree.rigged` is `false` and the report says "Árbol estático".

### A forest: many copies of one tree

`LeafForest` draws and simulates many copies of one static tree as one. It has the same API as `LeafTree`, plus a list with the place of each tree:

```js
import { LeafForest } from 'three-living-trees'

const transforms = spots.map(({ x, y, z, turn, size }) =>
{
    const tree = new THREE.Object3D() // or a Matrix4
    tree.position.set(x, y, z)
    tree.rotation.y = turn
    tree.scale.setScalar(size)
    return tree
})

const forest = await LeafForest.create(renderer, {
    url: './models/tree.glb',
    transforms,
    textures: [{ url: './textures/leaf_a.webp' }]
})
scene.add(forest.object)
forest.enablePointer(canvas, camera)

// in the loop, once for all the trees: the camera chooses each tree's detail
forest.update(deltaTime, camera)
```

- It costs a few draw calls (one per mesh of the tree and level of detail, one for the leaves) and one compute dispatch, however many trees there are. Up to 1024 trees.
- Trees don't have bones here: a rigged GLB has its armature stripped as it loads.
- `count` and `capacity` are per tree. By default the forest shares 20 000 leaves between its trees, so raise `count` for a small one.
- Each tree can stand at its own height and scale, and its leaves scale with it. They land at its base, at `groundY` if you set it, or on `ground` (see "Uneven ground") for terrain that isn't flat.
- The pointer pushes the tree it touches, and `shakeAll()` shakes them all. Each tree shows its own part of the anchors and sways from its own time, so copies don't look alike. `set()` applies to the whole forest.

**Level of detail.** Most of a tree's triangles are in its thinnest branches, which from afar are thin lines among the leaves. So a distant tree is drawn without them, removed whole from the thinnest up, which leaves no pieces floating. The levels are made at load, share their vertices, and need no extra files. Shadows use the same level.

- `lodTriangles` (default `[0.25, 0.08]`): the share of the triangles each lower level keeps.
- `lodScreen` (default `[0.5, 0.2]`): the tree's height, as a share of the screen's, below which it goes to each of those levels. `[]` always uses the full tree.
- `lodLeaves` (default `[0.75, 0.25]`): the share of its leaves a tree draws at each of those levels. They are drawn bigger to make up for the others, so a distant tree doesn't look bare. `[1, 1]` always draws them all.
- `lodLeafGrowth` (default `0.5`): how much bigger, as `share ^ -lodLeafGrowth`. At 0.5 they keep the same area in all, so a quarter of the leaves are twice as big. Less costs a little less and looks barer. `forest.leafGrowth` and `forest.drawLeaves()` change it live.
- The branch levels need a tree made of one island per branch and smooth shaded, like Sapling's. A tree that is all one mesh, or flat shaded, keeps all its triangles; the report (`forest.report`) says how many each level has. Leaves on a removed branch stay where they are.

**Leaving trees out.** A tree the camera can't see isn't drawn, nor are its leaves, though they are still simulated. Its shadow can reach the view from outside, so it stays until it is `cullMargin` tree heights out of view (default `1.5`). With a low sun, raise it; `Infinity` never leaves one out. A leaf of that tree that has flown into view goes with it. `forest.levelCounts` tells how many trees are at each level and how many leaves are drawn, and without a camera in `update()` every tree stays at full detail.

Measured on the machine this was built on, at 1356×1249, with shadows and the 32 600 triangle tree of this demo:

| Trees | Leaves | One `LeafTree` each | `LeafForest`, full detail | `LeafForest` with levels |
| --- | --- | --- | --- | --- |
| 24 | 19 200 | 29 ms | 24 ms | |
| 100 | 20 000 | 47 ms | 37 ms | 22 ms |
| 100 | 60 000 | | | 27 ms |
| 250 | 20 000 | | 48 ms | 16 ms |
| 500 | 20 000 | | 77 ms | 16 ms |
| 1024 | 20 480 | | 154 ms | 19 ms |

The CPU stays under 2 ms per frame in every `LeafForest` row (15 ms with 100 `LeafTree`), and 100 trees load in 0.5 s against 8 s. The 250 to 1024 rows were measured before leaves had levels, and see the whole forest from afar, the cheapest view for levels of detail. From inside the forest more trees are close: 100 trees took 28 ms there, against 34 ms at full detail, with a quarter of the trees left out.

Fewer leaves on distant trees, with the bark's levels already on:

| Trees | Leaves simulated | Drawn | All drawn | With `lodLeaves` |
| --- | --- | --- | --- | --- |
| 100 | 60 000 | 29 100 | 29 ms | 28 ms |
| 500 | 50 000 | 13 175 | 29 ms | 22 ms |
| 500 | 150 000 | 39 525 | 40 ms | 34 ms |

What leaves cost is the area they cover on screen, more than their number: simulating them barely shows, and neither does flattening them (`leafCurve: 0`). So a big forest is limited by how full you want it. 500 trees at 100 leaves each still look bare, and 300 each is fuller, though still sparse from close by, at 34 ms (28 ms with `lodLeafGrowth: 0.4`, with smaller leaves).

### Using a rigged GLB as a static tree

`stripBones` removes the armature at load, so one GLB can serve both kinds of tree without a second export:

```js
import { LeafTree, loadTreeScene, stripBones } from 'three-living-trees'

const root = await loadTreeScene('./models/tree.glb')
stripBones(root)
const tree = await LeafTree.create(renderer, { object: root })
```

- It changes `root` in place and returns it. Call it before `LeafTree.create`, and before cloning if you want several trees.
- Each `SkinnedMesh` becomes a plain `Mesh` with its shape at rest. Normals are kept, which is right as long as the rest pose is the bind pose (true for a fresh export).
- Whatever else hangs from a bone, such as `leaf_anchor*` empties, moves to the root and keeps its place in the world.
- Pass the object that contains the tree: a loose `SkinnedMesh` or `Bone` as `root` is an error.

### How many bones

The leaf shaders read the bone matrices from a WebGPU uniform buffer, 64 bytes per bone. WebGPU guarantees 64 KB per uniform buffer (`maxUniformBufferBindingSize`, which three uses unless you request more with `requiredLimits`). That allows about **1000 bones** (1024) in a rigged tree. three's own skinning switches to a bone texture past that limit, but the leaf shaders don't. A large tree is better kept under a few hundred bones, or exported static.

### Leaf textures

The library ships no leaf images: like the tree's GLB, you supply them.

- `textures` is optional and takes 1 to 5 entries `{ url | texture, weight, name }`. Each leaf picks one when the tree is created, in proportion to the weights; with a single texture every leaf uses it. More than 5 is an error.
- Images: PNG or WebP with alpha, the stem at the bottom centre, any proportion. `leafSize` is the leaf's height and its width follows the image (width / height), so a 280 × 348 image makes a leaf 0.8 times as wide as it is tall. Textures of different proportions can be mixed in one tree.
- A `texture` you load yourself is used as it is: set its `colorSpace` to `THREE.SRGBColorSpace`, and its `anisotropy` to `renderer.getMaxAnisotropy()` so leaves seen edge-on (e.g. on the ground, from low down) keep their detail. It must already be loaded (e.g. `await loader.loadAsync(url)`), because its proportion is read from its image. Textures given by `url` are set up by the library.
- Without textures (or with `[]`) the leaves use a built-in leaf shape drawn in the shader, with no images, 0.6 times as wide as it is tall. Its color is `params.leafColor` (default `'#4f7a3a'`), changeable at any time with `tree.set({ leafColor: '#b5651d' })`. Shadows follow the leaf shape in both cases.

### Leaf curve

Leaves are slightly curved instead of flat, with or without textures. `leafCurve` (default `0.15`) is how far the tip bends, as a fraction of the leaf's height. The edges bend too, more on a wide leaf than on a narrow one. It changes live with `tree.set({ leafCurve: 0.3 })`, and each leaf varies a little around that value.

- On the tree, the tip and edges bend towards the ground, whichever face looks up. A leaf standing on edge bends less, so a falling leaf flexes as it tumbles instead of popping from one side to the other.
- On the ground, leaves keep their curve: they rest on the stem and midrib with the tip and edges lifted, so no part goes under `groundY`.
- Shadows follow the curve.
- Cost: 12 triangles per leaf instead of 2, in one draw call. Measured on the machine this was built on, at 1356×1249, with shadows: no measurable difference with one tree of 5000 leaves (12.6 ms per frame against 12.5), about 1.5 ms more with 24 static trees and 19 200 leaves, each its own `LeafTree` (24.3 ms against 22.8).
- `leafCurve: 0` goes back to the 2-triangle plane, and may help on a GPU where vertices cost more than on this one. In a `LeafForest` of 100 trees and 60 000 leaves it made no measurable difference here.

## Tech

Three.js 0.186 with `WebGPURenderer` and TSL: the leaf simulation runs on the GPU in compute shaders. Built with Vite.
