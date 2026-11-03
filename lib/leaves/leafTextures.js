import * as THREE from 'three/webgpu'

/**
 * Leaf textures, supplied by the app like the tree's GLB: the library ships
 * none. A list of 1 to MAX_LEAF_TEXTURES entries { url | texture, weight, name }:
 *
 *   url      image to load: PNG or WebP with alpha, the stem at the bottom
 *            centre, 3:5 (the leaf plane is 0.6 x 1)
 *   texture  an already loaded THREE.Texture, instead of url. It is used as
 *            it is: set its colorSpace to THREE.SRGBColorSpace yourself
 *   weight   how often it appears, relative to the others (see textureVariants.js)
 *   name     only for messages
 *
 * No list, or an empty one, draws the leaves with the built-in leaf shape
 * instead (see LeafRenderer.js).
 */
export const MAX_LEAF_TEXTURES = 5

export function checkLeafTextures(list)
{
    if(list === undefined || list === null) return []
    if(!Array.isArray(list))
        throw new Error('textures debe ser una lista de texturas de hoja: [{ url, weight }].')
    if(list.length > MAX_LEAF_TEXTURES)
        throw new Error(`Se pasaron ${list.length} texturas de hoja; el máximo es ${MAX_LEAF_TEXTURES}.`)

    list.forEach((entry, index) =>
    {
        const item = typeof entry === 'string' ? { url: entry } : entry
        if(item === null || typeof item !== 'object' || (!item.url && !item.texture?.isTexture))
            throw new Error(`La textura de hoja ${index + 1} necesita \`url\` o \`texture\` (un THREE.Texture ya cargado).`)
    })

    return list
}

/**
 * Loads the ones given by url, once. They are shared by the single leaf material.
 */
export async function loadLeafTextures(list)
{
    const loader = new THREE.TextureLoader()

    return Promise.all(checkLeafTextures(list).map(async (entry, index) =>
    {
        const item = typeof entry === 'string' ? { url: entry } : entry
        if(item.texture) return item.texture

        try
        {
            const texture = await loader.loadAsync(item.url)
            texture.colorSpace = THREE.SRGBColorSpace
            texture.name = item.name ?? `leaf${index + 1}`
            return texture
        }
        catch(error)
        {
            throw new Error(`No se ha podido cargar la textura de hoja "${item.url}".`)
        }
    }))
}
