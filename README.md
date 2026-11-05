# Tree Demo

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
| Without bones | `?bones=0` | up to 24 | The same model, with its armature stripped at load as if exported without one. Sways in the wind on the GPU; the pointer pushes the crown |

- `?trees=N` sets how many. They stand on a grid, each turned and scaled a little, with its own seed. The GLB is loaded once and cloned, and the leaf textures are loaded once and shared.
- The limits are what kept a similar frame time on the machine this was built on, at 1923×909: 6 trees with bones (about 11 ms of CPU and 24 ms per frame) cost about as much as 24 without (10 ms and 23 ms).
- Leaves are per tree: 5000 by default, fewer past 4 trees (20 000 in all). `?count=` and `?maxCount=` change them. The panels' settings apply to every tree.
- `?textures=1` uses a single leaf texture, `?textures=0` none (the built-in leaf).

## Use it as a library

```bash
npm install three github:PabloMesquida/tree-demo#v0.4.0
```

Works with three 0.186.1 or newer (tested with 0.186.1 and 0.187.0).

```js
import * as THREE from 'three/webgpu'
import { LeafTree } from 'tree-demo'

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
- **Static:** plain meshes with no bones (e.g. a Sapling Tree Gen curve converted to a mesh, smooth shaded). The whole tree sways in the wind in its vertex shader. Cheap, so several of them fit in one scene. Leaves grow on the thinner branches.

Main options of `LeafTree.create`: `url` or `object` (an already loaded `Object3D`), `count`, `capacity`, `seed`, `textures`, `branchRadius` (static trees), `groundY`, `params`. The library needs a `WebGPURenderer` running on WebGPU; there is no WebGL fallback.

Create the renderer with `alpha: false`. The leaves use `alphaToCoverage`, so their edges write an alpha below 1 to the canvas. With the default `alpha: true`, the page background shows through those pixels as thin lines (white ones on a white page). `LeafTree.create` warns once per renderer about this. If you do want a transparent canvas, ignore the warning, but expect those lines.

### Static trees: wind sway

The bark and the attached leaves share one displacement function, so leaves never come off their branch. Shadows sway too.

- The displacement grows with the height above the base of the tree (height²): the trunk barely moves and the crown does. It points along `windAngle`, the same angle that blows the falling leaves. It combines a lean that grows in gusts, two oscillations, a smaller one across the wind and a faster flutter. The phase changes across the crown.
- `sway` (default 1): how much the tree moves. At 1 the crown leans about 3 % of the tree height; `0` keeps it still.
- `swaySpeed` (default 1): 2 is twice as fast.
- Each tree starts at its own point in the motion, taken from its `seed`. Give each tree in a scene a different `seed` so they don't sway in step.
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

### Using a rigged GLB as a static tree

`stripBones` removes the armature at load, so one GLB can serve both kinds of tree without a second export:

```js
import { LeafTree, loadTreeScene, stripBones } from 'tree-demo'

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

## Tech

Three.js 0.186 with `WebGPURenderer` and TSL: the leaf simulation runs on the GPU in compute shaders. Built with Vite.
