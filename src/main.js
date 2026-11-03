import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Inspector } from 'three/addons/inspector/Inspector.js'
import { color, mix, smoothstep, uv } from 'three/tsl'
import { LeafTree } from '../lib/index.js'
import { options, sceneParams } from './config.js'
import { createProceduralTree } from './tree/ProceduralTree.js'
import { DebugUI } from './debug/DebugUI.js'
import { BasicPanel } from './ui/BasicPanel.js'
import { createChecks } from './debug/checks.js'

const fail = (message) =>
{
    const element = document.getElementById('fatal')
    element.textContent = message
    element.hidden = false
    document.querySelector('canvas.threejs').style.display = 'none'
}

async function main()
{
    const canvas = document.querySelector('canvas.threejs')

    /**
     * WebGPU, and nothing else. three falls back to WebGL 2 on its own when
     * WebGPU is missing, so it is checked before creating the renderer (and
     * LeafTree.create() checks it again after).
     */
    if(!navigator.gpu)
    {
        return fail(
            'WebGPU no está disponible en este navegador.\n\n' +
            'Esta demo simula las hojas con compute shaders y no tiene modo WebGL.\n' +
            'Prueba con una versión reciente de Chrome o Edge, en https:// o en localhost.'
        )
    }

    const adapter = await navigator.gpu.requestAdapter()
    if(adapter === null)
    {
        return fail(
            'El navegador expone WebGPU, pero no ha encontrado ningún adaptador gráfico compatible.\n\n' +
            'Revisa que la aceleración por hardware esté activada y que los drivers de la GPU estén al día.'
        )
    }

    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
    if(options.debug) renderer.inspector = new Inspector()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap

    /**
     * Tree: a GLB or the provisional procedural one, both through the library
     */
    let tree
    try
    {
        tree = await LeafTree.create(renderer, {
            ...(options.tree === 'glb' ? { url: options.glb } : { object: createProceduralTree(options.seed) }),
            count: options.count,
            capacity: options.capacity,
            seed: options.seed
        })
    }
    catch(error)
    {
        console.error(error)
        return fail(`No se ha podido preparar el árbol.\n\n${error.message}`)
    }
    console.info(`[tree]\n  ${tree.report.join('\n  ')}`)

    const { asset } = tree

    /**
     * Scene
     */
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1b2126)
    scene.add(tree.object)

    const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100)

    scene.add(new THREE.HemisphereLight(0xdfeaff, 0x3a3226, 1.6))
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.2)
    scene.add(sun)

    // Ground: a lighter pool under the tree that darkens outwards and fades
    // into the background, so the floor has no visible edge
    const groundMaterial = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false })
    const groundDistance = uv().sub(0.5).length().mul(2) // 0 at the centre, 1 at the rim
    groundMaterial.colorNode = mix(color(0x47525a), color(0x283036), smoothstep(0, 0.55, groundDistance))
    groundMaterial.opacityNode = smoothstep(0.45, 1, groundDistance).oneMinus()

    const ground = new THREE.Mesh(
        new THREE.CircleGeometry(asset.height * 3, 96).rotateX(-Math.PI * 0.5),
        groundMaterial
    )
    ground.renderOrder = -1
    ground.position.y = asset.groundY
    ground.receiveShadow = true
    scene.add(ground)

    // Shadows: the sun keeps its direction; its shadow camera is fitted to the tree
    const centre = new THREE.Vector3(0, asset.groundY + asset.height * 0.5, 0)
    sun.target.position.copy(centre)
    sun.position.copy(centre).addScaledVector(new THREE.Vector3(3, 6, 4).normalize(), asset.height * 2)
    scene.add(sun.target)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -asset.height * 0.9
    sun.shadow.camera.right = asset.height * 0.9
    sun.shadow.camera.top = asset.height * 0.9
    sun.shadow.camera.bottom = -asset.height * 0.9
    sun.shadow.camera.near = asset.height * 0.5
    sun.shadow.camera.far = asset.height * 3.5
    sun.shadow.radius = 3
    sun.shadow.bias = -0.0005
    sun.shadow.normalBias = asset.height * 0.004

    camera.position.set(0, asset.groundY + asset.height * 0.62, asset.height * 2.3)
    const controls = new OrbitControls(camera, canvas)
    controls.target.set(0, asset.groundY + asset.height * 0.5, 0)
    controls.enableDamping = true
    controls.maxPolarAngle = Math.PI * 0.52
    controls.update()

    tree.enablePointer(canvas, camera)

    /**
     * Settings: the tree's own (tree.set / tree.apply) plus the demo's scene
     */
    const applyScene = () =>
    {
        sun.castShadow = sceneParams.shadows
    }
    applyScene()

    const onChange = () =>
    {
        tree.apply()
        applyScene()
    }

    // Full settings with #debug, only the basics without it. Adding or removing
    // #debug reloads the page, since the two interfaces are built once.
    const ui = options.debug
        ? new DebugUI({ renderer, tree, onChange })
        : new BasicPanel({ tree, onChange })
    window.addEventListener('hashchange', () => window.location.reload())

    /**
     * Resize
     */
    window.addEventListener('resize', () =>
    {
        camera.aspect = window.innerWidth / window.innerHeight
        camera.updateProjectionMatrix()
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        renderer.setSize(window.innerWidth, window.innerHeight)
    })

    /**
     * Loop. tree.update() keeps the rig and the GPU buffers in step:
     *   pointer -> rig -> bone matrices to the GPU -> compute pass,
     * then the render draws the skinned mesh and the leaves from the same bone matrices.
     */
    const timer = new THREE.Timer()
    timer.connect(document)

    const state = { paused: false }

    renderer.setAnimationLoop(() =>
    {
        timer.update()
        const deltaTime = timer.getDelta()

        controls.update()
        if(!state.paused) tree.update(deltaTime)

        renderer.render(scene, camera)
        ui.update(deltaTime)
    })

    // Console access and scripted checks: `demo.checks.determinism()`, etc.
    window.demo = { renderer, scene, camera, tree, sceneParams, state }
    window.demo.checks = createChecks(window.demo)
}

main()
