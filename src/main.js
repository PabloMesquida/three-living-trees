import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Inspector } from 'three/addons/inspector/Inspector.js'
import { color, mix, smoothstep, uv } from 'three/tsl'
import { leafTextures, options, sceneParams } from './config.js'
import { createForest } from './tree/forest.js'
import { DebugUI } from './debug/DebugUI.js'
import { BasicPanel } from './ui/BasicPanel.js'
import { createChecks } from './debug/checks.js'

const MIN_OPEN_PANEL_WIDTH = 768 // narrower, the open settings would cover the tree

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

    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false })
    if(options.debug) renderer.inspector = new Inspector()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap

    /**
     * Trees: a GLB with or without bones, one or several, all through the
     * library (see tree/forest.js)
     */
    let trees, bounds
    try
    {
        ({ trees, bounds } = await createForest(renderer, options, leafTextures.slice(0, options.textures)))
    }
    catch(error)
    {
        console.error(error)
        return fail(`No se ha podido preparar el árbol.\n\n${error.message}`)
    }
    const tree = trees[0] // the panels' parameters are this tree's, copied to the others
    console.info(`[tree] ${options.trees} × ${options.bones ? 'con huesos' : 'sin huesos'}\n  ${tree.report.join('\n  ')}`)

    // The whole group: ground at the lowest base, height of the tallest tree,
    // and how far the trees spread from the centre (nothing for a single tree,
    // which keeps the framing it always had)
    const groundY = bounds.min.y
    const height = bounds.max.y - bounds.min.y
    const several = options.trees > 1
    const spread = several ? Math.hypot(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 0.5 : 0
    const reach = Math.max(height * 0.9, spread + height * 0.15)

    /**
     * Scene
     */
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1b2126)
    for(const leafTree of trees) scene.add(leafTree.object)

    const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, Math.max(100, spread * 6))

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
        new THREE.CircleGeometry(Math.max(height * 3, spread + height * 2), 96).rotateX(-Math.PI * 0.5),
        groundMaterial
    )
    ground.renderOrder = -1
    ground.position.y = groundY
    ground.receiveShadow = true
    scene.add(ground)

    // Shadows: the sun keeps its direction; its shadow camera is fitted to the trees
    const centre = several
        ? new THREE.Vector3((bounds.min.x + bounds.max.x) * 0.5, groundY + height * 0.5, (bounds.min.z + bounds.max.z) * 0.5)
        : new THREE.Vector3(0, groundY + height * 0.5, 0)
    const sunDistance = height * 2 + spread
    sun.target.position.copy(centre)
    sun.position.copy(centre).addScaledVector(new THREE.Vector3(3, 6, 4).normalize(), sunDistance)
    scene.add(sun.target)
    sun.castShadow = true
    sun.shadow.mapSize.setScalar(several ? 4096 : 2048)
    sun.shadow.camera.left = -reach
    sun.shadow.camera.right = reach
    sun.shadow.camera.top = reach
    sun.shadow.camera.bottom = -reach
    sun.shadow.camera.near = Math.max(sunDistance - height * 1.5 - spread, height * 0.1)
    sun.shadow.camera.far = sunDistance + height * 1.5 + spread
    sun.shadow.radius = 3
    sun.shadow.bias = -0.0005
    sun.shadow.normalBias = height * 0.004

    camera.position.set(centre.x, groundY + height * 0.62 + spread * 0.3, centre.z + height * 2.3 + spread)
    const controls = new OrbitControls(camera, canvas)
    controls.target.copy(centre)
    controls.enableDamping = true
    controls.maxPolarAngle = Math.PI * 0.52
    controls.update()

    for(const leafTree of trees) leafTree.enablePointer(canvas, camera)

    /**
     * Settings: the trees' own (tree.set / tree.apply) plus the demo's scene.
     * The panels edit the first tree's params; every other tree copies them.
     */
    const applyScene = () =>
    {
        sun.castShadow = sceneParams.shadows
    }
    applyScene()

    const onChange = () =>
    {
        for(const leafTree of trees)
        {
            if(leafTree !== tree) Object.assign(leafTree.params, tree.params)
            leafTree.apply()
        }
        applyScene()
    }

    // Full settings by default, only the basics with #basic. Changing the hash
    // reloads the page, since the two interfaces are built once.
    const ui = options.debug
        ? new DebugUI({ renderer, trees, onChange })
        : new BasicPanel({ trees, onChange })
    window.addEventListener('hashchange', () => window.location.reload())

    // Show the settings in the Inspector's side panel, without its bottom bar of
    // tabs (performance, memory...), which starts closed even if a visit left it
    // open (the Inspector remembers). On a narrow screen the settings would cover
    // the tree, so they start closed too: the Inspector's button opens them.
    if(options.debug)
    {
        const { profiler, parameters } = renderer.inspector
        if(profiler.panel.classList.contains('visible')) profiler.togglePanel()
        if(window.innerWidth >= MIN_OPEN_PANEL_WIDTH) profiler.show(parameters)
        else profiler.hide()
    }

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
        // A forest also takes the camera, to choose each tree's level of detail
        if(!state.paused) for(const leafTree of trees) leafTree.update(deltaTime, camera)

        renderer.render(scene, camera)
        ui.update(deltaTime)
    })

    // Console access and scripted checks: `demo.checks.determinism()`, etc.
    // With several trees the checks run on the first one (demo.tree).
    window.demo = { renderer, scene, camera, tree, trees, sceneParams, state }
    window.demo.checks = createChecks(window.demo)
}

main()
