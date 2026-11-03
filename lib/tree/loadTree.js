import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

/**
 * Loads a tree exported from Blender and returns its scene. The requirements
 * on the file are the ones enforced by buildTreeAsset() (tree/TreeAsset.js):
 * either an armature with trunk / branch bones, or plain meshes for a static tree.
 *
 * The file may be compressed with meshopt (EXT_meshopt_compression, with or
 * without quantized attributes): the decoder only runs when a file needs it.
 */
export async function loadTreeScene(url)
{
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)

    let gltf
    try
    {
        gltf = await loader.loadAsync(url)
    }
    catch(error)
    {
        // A missing file comes back as the dev server's index.html, hence the odd parse errors
        throw new Error(`No se ha podido cargar "${url}". Comprueba que el archivo existe y que la ruta es correcta.\n(${error.message})`)
    }

    if(gltf.animations.length > 0)
        console.warn(`[tree] ${url} trae ${gltf.animations.length} animaciones; se ignoran: los huesos se mueven por código.`)

    return gltf.scene
}
