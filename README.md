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
- The panel lets you set the number of leaves, make leaves fall on their own (from one at a time up to all together), turn falling and regrowth on or off, reset, and shake the whole tree.
- Add `#debug` to the URL to show every setting and the particle counters.
- `?textures=1` uses a single leaf texture, `?textures=0` none (the built-in leaf).

## Use it as a library

```bash
npm install three github:PabloMesquida/tree-demo#v0.3.0
```

Works with three 0.186.1 or newer (tested with 0.186.1 and 0.187.0).

```js
import * as THREE from 'three/webgpu'
import { LeafTree } from 'tree-demo'

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })

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

- **Rigged:** an armature with bones named `trunk*` and `branch*` and skinned meshes. The branches sway, and shaking them makes leaves fall.
- **Static:** plain meshes with no bones (e.g. a Sapling Tree Gen curve converted to a mesh, smooth shaded). The tree does not move. Leaves grow on the thinner branches and fall on their own with `spontaneousFall`.

Main options of `LeafTree.create`: `url` or `object` (an already loaded `Object3D`), `count`, `capacity`, `seed`, `textures`, `branchRadius` (static trees), `groundY`, `params`. The library needs a `WebGPURenderer` running on WebGPU; there is no WebGL fallback.

### Leaf textures

The library ships no leaf images: like the tree's GLB, you supply them.

- `textures` is optional and takes 1 to 5 entries `{ url | texture, weight, name }`. Each leaf picks one when the tree is created, in proportion to the weights; with a single texture every leaf uses it. More than 5 is an error.
- Images: PNG or WebP with alpha, the stem at the bottom centre, 3:5 proportions (the leaf plane is 0.6 × 1).
- A `texture` you load yourself is used as it is: set its `colorSpace` to `THREE.SRGBColorSpace`. Textures given by `url` are set up by the library.
- Without textures (or with `[]`) the leaves use a built-in leaf shape drawn in the shader, with no images. Its color is `params.leafColor` (default `'#4f7a3a'`), changeable at any time with `tree.set({ leafColor: '#b5651d' })`. Shadows follow the leaf shape in both cases.

## Tech

Three.js 0.186 with `WebGPURenderer` and TSL: the leaf simulation runs on the GPU in compute shaders. Built with Vite.
